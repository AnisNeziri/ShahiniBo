import { setTimeout as sleep } from "node:timers/promises";
import { decodeTransaction, mentionsProtocol } from "./protocol.ts";
import type { RawTransactionRecord, RpcTransaction, TransactionProvenance } from "./protocol.ts";
import { PUMP_PROGRAM, PUMPSWAP_PROGRAM } from "./protocol-types.ts";
import type { NormalizedEvent, ProtocolEvent, StatusEvent } from "./protocol-types.ts";

export interface FeedSettings {
  rpcUrl: string;
  wsUrl?: string;
  provider: string;
  staleMs?: number;
  hydrationDeadlineMs?: number;
  maxQueue?: number;
  backlogSlots?: number;
  importSlots?: number;
  launchesOnly?: boolean;
}

export interface FeedHandlers {
  event(event: NormalizedEvent): void;
  raw?(record: RawTransactionRecord): void;
  checkpoint?(slot: number): void;
  resumeSlot?: number;
  resumeConfirmed?: ProtocolEvent[];
}

export interface ImportManifest {
  provider: string;
  firstSlot: number;
  lastSlot: number;
  firstBlockTimeMs?: number;
  lastBlockTimeMs?: number;
  blocksRead: number;
  omittedSlots: number[];
  missingBlocks: number[];
  noBlockTimeSlots: number[];
  venueSupport: string[];
  transactionsRead: number;
  decodedEvents: number;
  unknownReserveEvents: number;
  decodeFailures: number;
  timing: "block_time_only";
}

type RpcCommitment = "confirmed" | "finalized";

interface Block {
  blockhash: string;
  previousBlockhash?: string;
  parentSlot: number;
  blockTime: number | null;
  transactions: Omit<RpcTransaction, "slot" | "blockTime">[];
}

interface BlockMetadata {
  blockhash: string;
  previousBlockhash?: string;
  parentSlot: number;
  blockTime: number | null;
}

class RpcReadError extends Error {
  constructor(method: string, code?: number) {
    super(code === undefined ? `${method} failed` : `${method} failed (RPC ${code})`);
    this.name = "RpcReadError";
  }
}

function rpcClient(url: string) {
  const address = new URL(url);
  if (address.protocol !== "https:" && address.protocol !== "http:") throw new Error("invalid read-only RPC scheme");
  let nextId = 0;
  return async function rpc<Result>(method: "getSlot" | "getBlocks" | "getBlock" | "getTransaction",
    params: unknown[], signal: AbortSignal, deadlineMs: number): Promise<Result> {
    try {
      const response = await fetch(address, {
        method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error",
        body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]),
      });
      if (!response.ok) throw new RpcReadError(method, response.status);
      const payload = await response.json() as { result?: Result; error?: { code?: number } };
      if (!("result" in payload)) throw new RpcReadError(method, payload.error?.code);
      return payload.result as Result;
    } catch (error) {
      if (error instanceof RpcReadError) throw error;
      throw new RpcReadError(method);
    }
  };
}

type Rpc = ReturnType<typeof rpcClient>;
type Receipt = { receivedAtMs: number; slot: number };

function getBlock(rpc: Rpc, slot: number, commitment: RpcCommitment, signal: AbortSignal, deadline: number) {
  return rpc<Block | null>("getBlock", [slot, {
    commitment, encoding: "json", maxSupportedTransactionVersion: 1, transactionDetails: "full", rewards: false,
  }], signal, deadline);
}

function getHeader(rpc: Rpc, slot: number, signal: AbortSignal, deadline: number) {
  return rpc<BlockMetadata | null>("getBlock", [slot, {
    commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 1, transactionDetails: "none", rewards: false,
  }], signal, deadline);
}

function readBlock(block: Block, slot: number, handlers: FeedHandlers, provider: string, commitment: RpcCommitment,
  getReceipt: (signature: string) => Receipt | undefined, deadline: number, historical: boolean, observedHeadSlot?: number) {
  const decoded: ProtocolEvent[] = [];
  let transactions = 0;
  let failures = 0;
  const hydratedAtMs = Date.now();
  for (const [transactionIndex, value] of block.transactions.entries()) {
    const transaction = { ...value, slot, blockTime: block.blockTime };
    if (!mentionsProtocol(transaction)) continue;
    const signature = value.transaction.signatures[0];
    const receipt = signature ? getReceipt(signature) : undefined;
    const receivedAtMs = historical ? (block.blockTime ?? 0) * 1000 : receipt?.receivedAtMs ?? hydratedAtMs;
    const hydrationMs = receipt ? hydratedAtMs - receivedAtMs : undefined;
    const provenance: TransactionProvenance = {
      receivedAtMs, provider, transactionIndex, blockhash: block.blockhash, commitment,
      sourceTiming: historical ? "historical_block" : "confirmed_block", observedHeadSlot,
      late: historical ? block.blockTime === null : !receipt || receipt.slot !== slot || (hydrationMs ?? 0) > deadline,
      hydrationMs,
    };
    handlers.raw?.({ transaction, provenance });
    transactions += 1;
    try {
      decoded.push(...decodeTransaction(transaction, provenance));
    } catch {
      failures += 1;
    }
  }
  return { decoded, transactions, failures };
}

export async function importBlocks(settings: FeedSettings, firstSlot: number, lastSlot: number,
  handlers: FeedHandlers, signal: AbortSignal): Promise<ImportManifest> {
  if (!Number.isSafeInteger(firstSlot) || !Number.isSafeInteger(lastSlot) || firstSlot < 0 || lastSlot < firstSlot ||
      lastSlot - firstSlot >= (settings.importSlots ?? 256)) throw new Error("historical range exceeds the configured slot bound");
  const rpc = rpcClient(settings.rpcUrl);
  const deadline = settings.hydrationDeadlineMs ?? 6_000;
  const manifest: ImportManifest = { provider: settings.provider, firstSlot, lastSlot, blocksRead: 0,
    missingBlocks: [], omittedSlots: [], noBlockTimeSlots: [], transactionsRead: 0, decodedEvents: 0, decodeFailures: 0,
    unknownReserveEvents: 0, venueSupport: ["curve", "pumpswap"], timing: "block_time_only" };
  const slots = new Set(await rpc<number[]>("getBlocks", [firstSlot, lastSlot, { commitment: "finalized" }],
    signal, deadline));
  let hasGap = false;
  let previousBlock: Block | undefined;
  const gap = (reason: string, slot: number, atMs?: number): void => {
    if (hasGap) return;
    hasGap = true;
    handlers.event({ kind: "feed", provider: settings.provider, healthy: false, reason, slot,
      receivedAtMs: atMs ?? manifest.lastBlockTimeMs ?? 0 });
  };
  for (let slot = firstSlot; slot <= lastSlot; slot++) {
    signal.throwIfAborted();
    if (!slots.has(slot)) {
      manifest.omittedSlots.push(slot);
      continue;
    }
    let block: Block | null;
    try {
      block = await getBlock(rpc, slot, "finalized", signal, deadline);
    } catch (error) {
      if (!(error instanceof RpcReadError)) throw error;
      manifest.missingBlocks.push(slot);
      gap("archive_announced_block_unavailable", slot);
      continue;
    }
    if (!block) {
      manifest.missingBlocks.push(slot);
      gap("archive_announced_block_unavailable", slot);
      continue;
    }
    manifest.blocksRead += 1;
    if (block.blockTime !== null) {
      manifest.firstBlockTimeMs ??= block.blockTime * 1000;
      manifest.lastBlockTimeMs = block.blockTime * 1000;
    } else {
      manifest.noBlockTimeSlots.push(slot);
      gap("archive_block_time_unknown", slot);
    }
    if (block.parentSlot >= firstSlot && (!slots.has(block.parentSlot) ||
        (previousBlock && block.previousBlockhash && block.previousBlockhash !== previousBlock.blockhash))) {
      gap("archive_parent_block_unavailable", slot);
    }
    previousBlock = block;
    const read = readBlock(block, slot, handlers, settings.provider, "finalized", () => undefined, deadline, true);
    manifest.transactionsRead += read.transactions;
    manifest.decodedEvents += read.decoded.length;
    manifest.decodeFailures += read.failures;
    manifest.unknownReserveEvents += read.decoded.filter(event => event.reserves?.feeBps === undefined).length;
    if (read.failures) gap("archive_protocol_decode_gap", slot);
    for (const event of read.decoded) handlers.event(event);
    if (!hasGap && block.blockTime !== null) {
      handlers.event({ kind: "feed", provider: settings.provider, healthy: true, reason: "archive_slot_complete",
        slot, receivedAtMs: block.blockTime * 1000 });
    }
  }
  return manifest;
}

interface SocketState {
  socket: WebSocket;
  open: boolean;
  closed: boolean;
  acknowledgments: Set<number>;
  lastMessageAt: number;
  dropped: number;
  receipts: Map<string, Receipt>;
}

type SocketPayload = {
  id?: number;
  result?: number;
  error?: unknown;
  method?: string;
  params?: { result?: { context?: { slot?: number }; value?: { signature?: string; err?: unknown; logs?: string[] } } };
};

function connect(settings: FeedSettings, notify: (event: NormalizedEvent) => void): SocketState {
  const rpcUrl = new URL(settings.rpcUrl);
  const url = settings.wsUrl ? new URL(settings.wsUrl) : rpcUrl;
  if (!settings.wsUrl) url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("invalid read-only WebSocket scheme");
  const socket = new WebSocket(url);
  const state: SocketState = { socket, open: false, closed: false, lastMessageAt: Date.now(),
    dropped: 0, acknowledgments: new Set(), receipts: new Map() };
  const limit = settings.maxQueue ?? 8192;
  socket.addEventListener("open", () => {
    state.open = true;
    const programs = settings.launchesOnly ? [PUMP_PROGRAM] : [PUMP_PROGRAM, PUMPSWAP_PROGRAM];
    for (const [i, program] of programs.entries()) {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "logsSubscribe",
        params: [{ mentions: [program] }, { commitment: "confirmed" }] }));
    }
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "slotSubscribe" }));
  });
  socket.addEventListener("close", () => { state.closed = true; });
  socket.addEventListener("error", () => { state.closed = true; });
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    let message: SocketPayload;
    try {
      if (typeof event.data !== "string") throw new Error("unexpected frame");
      message = JSON.parse(event.data) as SocketPayload;
    } catch {
      state.dropped += 1;
      return;
    }
    const now = Date.now();
    state.lastMessageAt = now;
    if (message.id && typeof message.result === "number") state.acknowledgments.add(message.id);
    if (message.id && message.error !== undefined) {
      state.closed = true;
      return;
    }
    const signature = message.params?.result?.value?.signature;
    const slot = message.params?.result?.context?.slot;
    if (message.method !== "logsNotification" || typeof signature !== "string" || typeof slot !== "number" ||
        state.receipts.get(signature)?.slot === slot) return;
    if (settings.launchesOnly && (message.params?.result?.value?.err !== null ||
        !message.params?.result?.value?.logs?.some(log => /^Program log: Instruction: Create(?:V2)?$/.test(log)))) return;
    if (state.receipts.size >= limit) {
      state.dropped += 1;
      return;
    }
    state.receipts.set(signature, { receivedAtMs: now, slot });
    notify({ kind: "status", provider: settings.provider, signature, slot,
      instructionPath: [], receivedAtMs: now, commitment: "observed" });
  });
  return state;
}

interface PendingBlock {
  blockhash: string;
  events: ProtocolEvent[];
  fullyScanned: boolean;
}

function finalStatus(event: ProtocolEvent, rollback: boolean): StatusEvent {
  return { kind: "status", provider: event.provider, signature: event.signature, slot: event.slot,
    mint: event.mint, receivedAtMs: Date.now(), instructionPath: event.instructionPath,
    transactionIndex: event.transactionIndex, blockhash: event.blockhash, late: true,
    commitment: rollback ? "rolled_back" : "finalized", reason: rollback ? "confirmed_block_replaced" : undefined };
}

// The observation-only route avoids the RPC volume of complete block scans.
// Its unordered launch samples are ineligible for paper or live entries.
async function sampleLaunches(settings: FeedSettings, handlers: FeedHandlers, signal: AbortSignal): Promise<void> {
  const rpc = rpcClient(settings.rpcUrl);
  const staleMs = settings.staleMs ?? 15_000;
  const deadline = settings.hydrationDeadlineMs ?? 6_000;
  const health = (reason: string) => handlers.event({ kind: "feed", provider: settings.provider,
    healthy: false, reason, receivedAtMs: Date.now() });
  const seen = new Map<string, number>();
  while (!signal.aborted) {
    const state = connect(settings, handlers.event);
    health("connecting_launch_sampler");
    let subscribed = false;
    try {
      while (!signal.aborted && !state.closed && Date.now() - state.lastMessageAt <= staleMs) {
        if (state.acknowledgments.size < 2) {
          await sleep(50, undefined, { signal });
          continue;
        }
        if (!subscribed) {
          health("launch_sampler_connected_incomplete_coverage");
          subscribed = true;
        }
        if (state.dropped) throw new RpcReadError("WebSocket sampling queue overflow");
        const next = state.receipts.entries().next();
        if (next.done) {
          await sleep(50, undefined, { signal });
          continue;
        }
        const [signature, receipt] = next.value;
        state.receipts.delete(signature);
        if (seen.has(signature)) continue;
        let transaction: RpcTransaction | null = null;
        while (!signal.aborted && Date.now() - receipt.receivedAtMs < deadline) {
          const remaining = deadline - (Date.now() - receipt.receivedAtMs);
          try {
            transaction = await rpc<RpcTransaction | null>("getTransaction", [signature, {
              commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 1,
            }], signal, Math.max(1, remaining));
          } catch (error) {
            if (!(error instanceof RpcReadError)) throw error;
          }
          if (transaction) break;
          await sleep(200, undefined, { signal });
        }
        seen.set(signature, receipt.receivedAtMs);
        // Map order is receipt order and bounds memory during an unattended sample.
        if (seen.size > (settings.maxQueue ?? 8192)) {
          const oldest = seen.keys().next().value;
          if (oldest) seen.delete(oldest);
        }
        if (!transaction || signature !== transaction.transaction.signatures[0]) {
          handlers.event({ kind: "status", provider: settings.provider, signature, slot: receipt.slot,
            commitment: "observed", instructionPath: [], late: true, receivedAtMs: Date.now(),
            reason: "launch_sampler_transaction_unavailable" });
          continue;
        }
        const provenance: TransactionProvenance = { provider: settings.provider, receivedAtMs: receipt.receivedAtMs,
          commitment: "confirmed", hydrationMs: Date.now() - receipt.receivedAtMs, late: true, sourceTiming: "transaction_sampler" };
        handlers.raw?.({ transaction, provenance });
        let events: ProtocolEvent[];
        try {
          events = decodeTransaction(transaction, provenance);
        } catch {
          health("launch_sampler_decode_gap");
          continue;
        }
        for (const event of events) handlers.event(event);
      }
      if (!signal.aborted) health("launch_sampler_disconnected");
    } catch (error) {
      if (signal.aborted) break;
      if (!(error instanceof RpcReadError)) throw error;
      health(error.message);
    } finally {
      state.socket.close();
    }
    if (!signal.aborted) await sleep(1_000, undefined, { signal }).catch(() => undefined);
  }
  health("stopped");
}

export async function runReadOnlyFeed(settings: FeedSettings, handlers: FeedHandlers, signal: AbortSignal): Promise<void> {
  if (settings.launchesOnly) return sampleLaunches(settings, handlers, signal);
  const rpc = rpcClient(settings.rpcUrl);
  const maxBacklog = settings.backlogSlots ?? 128;
  const readDeadline = settings.hydrationDeadlineMs ?? 6_000;
  const staleMs = settings.staleMs ?? 15_000;
  let finalized: number = handlers.resumeSlot ?? -1;
  const pending = new Map<number, PendingBlock>();
  for (const event of handlers.resumeConfirmed ?? []) {
    if (event.commitment !== "confirmed" || event.slot <= finalized || !event.blockhash) continue;
    const block = pending.get(event.slot);
    if (!block) {
      pending.set(event.slot, { blockhash: event.blockhash, events: [event], fullyScanned: false });
    } else if (block.blockhash === event.blockhash) {
      block.events.push(event);
    }
  }
  let healthy: boolean | undefined;
  let lastReason: string | undefined;
  let integrityFailure: string | undefined;
  let lastHealthAt = 0;
  const emitHealth = (good: boolean, reason?: string, slot?: number, state?: SocketState): void => {
    const now = Date.now();
    if (healthy === good && lastReason === reason && now - lastHealthAt < 15_000) return;
    healthy = good;
    lastReason = reason;
    lastHealthAt = now;
    handlers.event({ kind: "feed", provider: settings.provider, receivedAtMs: now, healthy: good, reason, slot,
      subscriptions: state?.acknowledgments.size, queueDepth: state?.receipts.size, droppedMessages: state?.dropped,
      finalizedSlot: finalized >= 0 ? finalized : undefined });
  };
  emitHealth(false, "connecting");
  while (!signal.aborted) {
    const state = connect(settings, handlers.event);
    try {
      while (!signal.aborted && !state.closed && state.acknowledgments.size < 3 &&
          Date.now() - state.lastMessageAt < staleMs) await sleep(50, undefined, { signal });
      if (state.closed || state.acknowledgments.size < 3) throw new RpcReadError("WebSocket subscriptions");
      const firstFinalized = await rpc<number>("getSlot", [{ commitment: "finalized" }], signal, readDeadline);
      if (finalized === -1) {
        finalized = firstFinalized;
        handlers.checkpoint?.(finalized);
      }
      let processed = finalized;
      let lastConfirmed = processed;
      let lastAdvanceAt = Date.now();
      while (!signal.aborted && state.open && !state.closed) {
        if (Date.now() - state.lastMessageAt > staleMs) throw new RpcReadError("WebSocket heartbeat");
        if (state.dropped) throw new RpcReadError("WebSocket frame or backlog limit");
        const [confirmedHead, finalizedHead] = await Promise.all([
          rpc<number>("getSlot", [{ commitment: "confirmed" }], signal, readDeadline),
          rpc<number>("getSlot", [{ commitment: "finalized" }], signal, readDeadline),
        ]);
        if (confirmedHead > lastConfirmed) {
          lastConfirmed = confirmedHead;
          lastAdvanceAt = Date.now();
        }
        if (confirmedHead - processed > maxBacklog) {
          // Leave the durable checkpoint intact. Operators can backfill a larger
          // verified archival range and restart without enabling stale entries.
          throw new RpcReadError("confirmed slot backfill exceeds configured bound");
        }
        if (confirmedHead < processed || finalizedHead < finalized) throw new RpcReadError("RPC head regressed");
        if (confirmedHead > processed) {
          const slots = await rpc<number[]>("getBlocks", [processed + 1, confirmedHead, { commitment: "confirmed" }],
            signal, readDeadline);
          for (const slot of slots) {
            const block = await getBlock(rpc, slot, "confirmed", signal, readDeadline);
            if (!block) throw new RpcReadError("confirmed block unavailable");
            const prior = pending.get(processed);
            if (block.parentSlot !== processed || (prior && block.previousBlockhash && prior.blockhash !== block.previousBlockhash)) {
              throw new RpcReadError("confirmed block parent was not covered");
            }
            const previous = pending.get(slot);
            if (previous?.fullyScanned && previous.blockhash === block.blockhash) {
              processed = slot;
              continue;
            }
            if (previous && previous.blockhash !== block.blockhash) {
              integrityFailure = "confirmed_fork_changed";
              emitHealth(false, integrityFailure, slot);
              for (const event of previous.events) handlers.event(finalStatus(event, true));
            }
            const read = readBlock(block, slot, handlers, settings.provider, "confirmed",
              signature => slot > firstFinalized ? state.receipts.get(signature) : undefined, readDeadline, false, confirmedHead);
            if (read.failures) integrityFailure = "confirmed_protocol_decode_gap";
            const timely = slot > firstFinalized && Date.now() - state.lastMessageAt < staleMs &&
              Date.now() - lastAdvanceAt < staleMs && state.dropped === 0;
            emitHealth(timely && !integrityFailure, integrityFailure ?? (timely ? undefined : "recovering_history"), slot, state);
            for (const event of read.decoded) handlers.event(event);
            pending.set(slot, { blockhash: block.blockhash, events: read.decoded, fullyScanned: read.failures === 0 });
            processed = slot;
          }
          if (processed < confirmedHead) throw new RpcReadError("confirmed head missing from ordered scan");
        }
        if (finalizedHead > finalized) {
          const finalSlots = await rpc<number[]>("getBlocks", [finalized + 1, finalizedHead, { commitment: "finalized" }],
            signal, readDeadline);
          const finalizedSlots = new Set(finalSlots);
          for (const [slot, block] of pending) {
            if (slot > finalizedHead || finalizedSlots.has(slot)) continue;
            integrityFailure = "confirmed_fork_changed";
            emitHealth(false, integrityFailure, slot);
            for (const event of block.events) handlers.event(finalStatus(event, true));
            pending.delete(slot);
          }
          for (const slot of finalSlots) {
            const header = await getHeader(rpc, slot, signal, readDeadline);
            if (!header || header.parentSlot !== finalized) throw new RpcReadError("finalized block coverage gap");
            const candidate = pending.get(slot);
            if (candidate?.fullyScanned && candidate.blockhash === header.blockhash) {
              for (const event of candidate.events) handlers.event(finalStatus(event, false));
            } else {
              if (candidate && candidate.blockhash !== header.blockhash) {
                integrityFailure = "confirmed_fork_changed";
                emitHealth(false, integrityFailure, slot);
                for (const event of candidate.events) handlers.event(finalStatus(event, true));
              }
              const block = await getBlock(rpc, slot, "finalized", signal, readDeadline);
              if (!block) throw new RpcReadError("finalized block unavailable");
              const read = readBlock(block, slot, handlers, settings.provider, "finalized",
                () => undefined, readDeadline, false);
              if (read.failures) {
                integrityFailure = "finalized_protocol_decode_gap";
                throw new RpcReadError("finalized protocol decode gap");
              }
              for (const event of read.decoded) handlers.event(event);
            }
            pending.delete(slot);
            finalized = slot;
            handlers.checkpoint?.(slot);
          }
          if (finalized < finalizedHead) throw new RpcReadError("finalized head missing from ordered scan");
        }
        // Evict evidence only once it cannot be needed to replay an unscanned slot.
        for (const [signature, receipt] of state.receipts) {
          if (receipt.slot <= finalized) state.receipts.delete(signature);
        }
        if (Date.now() - lastAdvanceAt >= staleMs) emitHealth(false, "confirmed_head_stale", confirmedHead, state);
        await sleep(400, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) break;
      if (!(error instanceof RpcReadError)) throw error;
      emitHealth(false, error.message, finalized === -1 ? undefined : finalized, state);
    } finally {
      state.socket.close();
    }
    if (!signal.aborted) {
      emitHealth(false, "reconnecting", finalized === -1 ? undefined : finalized);
      await sleep(1_000, undefined, { signal }).catch(() => undefined);
    }
  }
  emitHealth(false, "stopped", finalized === -1 ? undefined : finalized);
}
