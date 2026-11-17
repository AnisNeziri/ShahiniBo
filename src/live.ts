import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { runReadOnlyFeed } from "./feed.ts";
import { isPublicKey, verifyCreator } from "./identity.ts";
import { LiveExecutor } from "./live-execution.ts";
import type { LiveCaps, LiveIntent } from "./live-execution.ts";
import { SolanaTransport, createConnection } from "./live-solana.ts";
import type { RouteLimits } from "./live-solana.ts";
import { SOL_MINT } from "./protocol-types.ts";
import type { LaunchEvent, FeedEvent } from "./protocol-types.ts";
import { loadAllowlist, loadFeed, object, readJson } from "./settings.ts";
import { exitTrigger, minAfterSlippage } from "./strategy.ts";
import { validateExitPolicy, terminalExit, profitSize, profitExit } from "./exits.ts";

function requiredText(input: unknown, label: string): string {
  if (typeof input !== "string" || !input.trim()) throw new Error(`Missing live ${label}`);
  return input;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid live ${name}`);
  }
  return value;
}

function amount(value: unknown, name: string, min = 1n): bigint {
  if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) throw new Error(`Invalid live ${name}`);
  const lamports = BigInt(value);
  if (lamports < min || lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Invalid live ${name}`);
  return lamports;
}

function recipients(value: unknown, name: string): PublicKey[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => !isPublicKey(item))) {
    throw new Error(`Specify reviewed live ${name}`);
  }
  return value.map(key => new PublicKey(String(key)));
}

export function loadLivePolicy(path: string) {
  const policy = object(readJson(path), "live policy");
  if (policy.version !== 1 || policy.mode !== "live" || policy.enabled !== true) {
    throw new Error("Live execution requires an independently reviewed version 1 policy with enabled=true");
  }
  const base = dirname(resolve(path));
  const db = resolve(base, requiredText(policy.database, "database"));
  if (!db.endsWith(".live.sqlite")) throw new Error("Live database must use a dedicated .live.sqlite path");
  const wallet = requiredText(policy.wallet, "wallet");
  if (!isPublicKey(wallet)) throw new Error("Specify the dedicated wallet public key");
  const genesisHash = requiredText(policy.genesisHash, "genesisHash");
  if (!/^[1-9A-HJ-NP-Za-km-z]{20,50}$/.test(genesisHash)) throw new Error("Specify the expected cluster genesis hash");
  const feedPolicy = object(policy.feed, "live feed");
  if (feedPolicy.launchesOnly === true) throw new Error("Live execution requires venue and migration feed coverage");
  const rpcEnv = requiredText(feedPolicy.rpcEnv, "feed.rpcEnv");
  if (!process.env[rpcEnv]) throw new Error("Set the dedicated live RPC environment variable");
  const feed = loadFeed(feedPolicy);
  const caps = object(policy.caps, "live caps");
  const risk = object(policy.rules, "live rules");
  const exits = risk.exits === undefined ? undefined : validateExitPolicy(risk.exits);
  const configuredCaps: LiveCaps = {
    maxWalletLamports: amount(caps.maxWalletLamports, "maxWalletLamports"),
    maxEntryLamports: amount(caps.maxEntryLamports, "maxEntryLamports"),
    maxExposureLamports: amount(caps.maxExposureLamports, "maxExposureLamports"),
    maxNetworkFeeLamports: amount(caps.maxNetworkFeeLamports, "maxNetworkFeeLamports"),
    maxAccountDepositLamports: amount(caps.maxAccountDepositLamports, "maxAccountDepositLamports", 0n),
    dailyLossLamports: amount(caps.dailyLossLamports, "dailyLossLamports"),
    maxOpenPositions: integer(caps.maxOpenPositions, "maxOpenPositions", 1, 20),
    maxBroadcasts: integer(caps.maxBroadcasts, "maxBroadcasts", 1, 5),
  };
  const routeLimits: RouteLimits = {
    maxVenueFeeBps: integer(caps.maxVenueFeeBps, "maxVenueFeeBps", 0, 9_999),
    maxEntryImpactBps: integer(caps.maxEntryImpactBps, "maxEntryImpactBps", 0, 9_999),
    maxExitImpactBps: integer(caps.maxExitImpactBps, "maxExitImpactBps", 0, 9_999),
    computeUnitLimit: integer(caps.computeUnitLimit, "computeUnitLimit", 1, 1_400_000),
    microLamportsPerUnit: integer(caps.microLamportsPerUnit, "microLamportsPerUnit", 0, Number.MAX_SAFE_INTEGER),
    timeoutMs: integer(policy.rpcTimeoutMs, "rpcTimeoutMs", 100, 15_000),
    feeRecipients: recipients(policy.feeRecipients, "feeRecipients"),
    buybackRecipients: recipients(policy.buybackRecipients, "buybackRecipients"),
  };
  const spend = amount(risk.spendLamports, "spendLamports");
  if (spend + configuredCaps.maxNetworkFeeLamports + configuredCaps.maxAccountDepositLamports > configuredCaps.maxEntryLamports ||
      configuredCaps.maxEntryLamports > configuredCaps.maxExposureLamports ||
      configuredCaps.maxEntryLamports > configuredCaps.maxWalletLamports) throw new Error("Inconsistent live spending or exposure caps");
  return {
    db, wallet, genesisHash, feed, caps: configuredCaps, routeLimits, spend,
    keypairPath: resolve(base, requiredText(policy.keypairPath, "keypairPath")),
    allowlistPath: resolve(base, requiredText(policy.allowlist, "allowlist")),
    revision: createHash("sha256").update(JSON.stringify({ caps, risk, wallet, genesisHash, feeRecipients: policy.feeRecipients,
      buybackRecipients: policy.buybackRecipients })).digest("hex"),
    exits,
    takeProfitBps: integer(risk.takeProfitBps ?? (exits ? 2000 : undefined), "takeProfitBps", 1, 100_000),
    stopLossBps: integer(risk.stopLossBps ?? (exits ? 1000 : undefined), "stopLossBps", 1, 10_000),
    timeExitMs: integer(risk.timeExitMs, "timeExitMs", 100, 86_400_000),
    maxLaunchAgeMs: integer(risk.maxLaunchAgeMs, "maxLaunchAgeMs", 100, 60_000),
    slippageBps: integer(risk.slippageBps, "slippageBps", 0, 9_999),
    maxExitAttempts: integer(risk.maxExitAttempts, "maxExitAttempts", 1, 20),
    retryDelayMs: integer(risk.retryDelayMs, "retryDelayMs", 500, 60_000),
    exitOrderTtlMs: integer(risk.exitOrderTtlMs, "exitOrderTtlMs", 500, 30_000),
  };
}

function privatePOSIXPath(path: string, isFile: boolean) {
  const target = realpathSync(path);
  const stat = statSync(target);
  if ((isFile ? !stat.isFile() : !stat.isDirectory()) || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("Live key file and ledger directory must be private and owned by the service user");
  }
  return target;
}

function loadWallet(keypairPath: string): Keypair {
  const privateFile = privatePOSIXPath(keypairPath, true);
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const fromRepo = relative(repo, privateFile);
  if (!isAbsolute(fromRepo) && fromRepo !== ".." && !fromRepo.startsWith("../")) {
    throw new Error("Live key file must be stored outside the repository");
  }
  const raw = readFileSync(privateFile);
  try {
    const values: unknown = JSON.parse(raw.toString("utf8"));
    if (!Array.isArray(values) || values.length !== 64 ||
        values.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error("Invalid live key");
    const bytes = Uint8Array.from(values);
    values.fill(0);
    try { return Keypair.fromSecretKey(bytes.slice()); } finally { bytes.fill(0); }
  } catch {
    throw new Error("Unable to load valid Solana key from the private live key file");
  } finally {
    raw.fill(0);
  }
}

export async function runLive(policyPath: string, signal: AbortSignal): Promise<void> {
  const policy = loadLivePolicy(policyPath);
  if (process.platform !== "linux") throw new Error("Run the live wallet service on Linux with private POSIX file permissions");
  mkdirSync(dirname(policy.db), { recursive: true, mode: 0o700 });
  privatePOSIXPath(dirname(policy.db), false);
  closeSync(openSync(policy.db, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
  privatePOSIXPath(policy.db, true);
  const rpc = createConnection(policy.feed.rpcUrl, policy.routeLimits.timeoutMs);
  let genesisHash: string;
  try { genesisHash = await rpc.getGenesisHash(); } catch { throw new Error("Unable to verify the live RPC cluster"); }
  if (genesisHash !== policy.genesisHash) throw new Error("Live RPC cluster does not match the reviewed policy");
  const signer = loadWallet(policy.keypairPath);
  if (signer.publicKey.toBase58() !== policy.wallet) throw new Error("Key does not match the dedicated review-approved wallet");
  const transport = new SolanaTransport(signer, rpc, policy.routeLimits);
  const executor = new LiveExecutor(policy.db, transport, policy.caps);
  const controller = new AbortController();
  const activeSignal = AbortSignal.any([signal, controller.signal]);
  const launches = new Map<string, LaunchEvent>();
  const tracked = new Map<string, { event: LaunchEvent; expiresAt: number }>();
  const nextExitQuote = new Map<string, number>();
  let health: FeedEvent | undefined;
  let providerSlot = 0;
  let lastProviderActivity = 0;
  let queueOverrun = false;
  let launchRollback = !!executor.currentRuntime("rollback");
  let readOnlyError = false;
  let feedTask: Promise<void> | undefined;
  const feedUsable = () => !activeSignal.aborted && !!health?.healthy && !queueOverrun && !launchRollback &&
    Date.now() - lastProviderActivity <= (policy.feed.staleMs ?? 15_000);
  const mayBuy = (intent: LiveIntent) => {
    if (!feedUsable() || executor.control() !== "active" || !intent.sourceSignature) return false;
    const authorization = tracked.get(intent.sourceSignature);
    try {
      return !!authorization && Date.now() < authorization.expiresAt &&
        verifyCreator(authorization.event, loadAllowlist(policy.allowlistPath).creators, Date.now()).eligible;
    } catch { return false; }
  };
  try {
    loadAllowlist(policy.allowlistPath);
    executor.runtime("policyRevision", policy.revision);
    executor.runtime("walletBalance", null);
    executor.runtime("feed", { healthy: false, reason: "starting" });
    const balance = await rpc.getBalance(signer.publicKey, "confirmed").catch(() => {
      throw new Error("Unable to reconcile the live wallet balance");
    });
    executor.runtime("walletBalance", { lamports: String(balance), observedAtMs: Date.now() });
    if (BigInt(balance) > policy.caps.maxWalletLamports) executor.runtime("entryBlock", "wallet_balance_above_cap");
    else executor.runtime("entryBlock", null);
    await executor.recover(mayBuy);
    process.stdout.write(JSON.stringify({ mode: "live", ...executor.status() }) + "\n");
    feedTask = runReadOnlyFeed(policy.feed, {
      resumeSlot: executor.checkpoint(),
      resumeConfirmed: executor.unsettledLaunches(),
      checkpoint(slot) {
        lastProviderActivity = Date.now();
        executor.runtime("checkpoint", slot);
        executor.runtime("providerActivityAtMs", lastProviderActivity);
      },
      event(event) {
        if (event.kind === "feed") {
          health = event;
          if (event.healthy) lastProviderActivity = Date.now();
          executor.runtime("feed", event);
        } else {
          if (event.commitment === "confirmed" && !event.late) providerSlot = Math.max(providerSlot, event.slot);
          if (event.commitment === "rolled_back") {
            tracked.delete(event.signature);
            if (executor.hasSourceSignature(event.signature)) {
              launchRollback = true;
              executor.runtime("rollback", { signature: event.signature, slot: event.slot });
            }
            launches.delete(event.signature);
          }
          if (event.kind === "launch" && event.commitment === "confirmed" && !event.late &&
              event.supported && event.quoteMint === SOL_MINT) {
            if (launches.size < (policy.feed.maxQueue ?? 256)) launches.set(event.signature, event);
            else {
              launches.clear();
              queueOverrun = true;
              executor.runtime("feedGap", { reason: "live_launch_queue_overrun", atMs: Date.now() });
            }
          }
        }
      },
    }, activeSignal).then(() => {
      if (!activeSignal.aborted) {
        readOnlyError = true;
        controller.abort();
      }
    }, () => {
      readOnlyError = true;
      controller.abort();
    });
    let refreshBalanceAt = 0;
    while (!activeSignal.aborted) {
      await executor.recover(mayBuy);
      const now = Date.now();
      if (now >= refreshBalanceAt) {
        const current = await rpc.getBalance(signer.publicKey, "confirmed").catch(() => null);
        executor.runtime("walletBalance", { lamports: current === null ? null : String(current), observedAtMs: now });
        executor.runtime("entryBlock", current === null ? "wallet_balance_unavailable" :
          BigInt(current) > policy.caps.maxWalletLamports ? "wallet_balance_above_cap" : null);
        refreshBalanceAt = now + 5_000;
      }
      for (const [signature, auth] of tracked) if (auth.expiresAt <= now) tracked.delete(signature);
      const positions = executor.positions();
      const open = new Set(positions.map(p => p.mint));
      for (const mint of nextExitQuote.keys()) {
        if (!open.has(mint)) {
          nextExitQuote.delete(mint);
          executor.runtime(`exit:${mint}`, null);
        }
      }
      for (const position of positions) {
        if (activeSignal.aborted || (nextExitQuote.get(position.mint) ?? 0) > now) continue;
        nextExitQuote.set(position.mint, now + policy.retryDelayMs);
        const elapsed = now - position.filledAt;
        if (elapsed >= policy.timeExitMs) {
          if (position.exit) executor.latchTerminal(position.mint, "time_exit");
          else executor.trigger(position.mint, "time_exit");
        }
        if (!position.exit && !executor.mayPlanExit(position.mint, now, policy.maxExitAttempts)) {
          executor.runtime(`exit:${position.mint}`, { reason: "position_has_pending_attempt_or_retry_limit", atMs: now });
          continue;
        }
        try {
          let quote = await transport.quote("sell", position.mint, position.tokens, providerSlot);
          let trigger: LiveIntent["trigger"];
          let size = position.tokens;
          const fullNet = quote.sol - policy.caps.maxNetworkFeeLamports;
          if (position.exit) {
            const { policy: frozen, progress } = position.exit;
            trigger = terminalExit(frozen, progress, size, fullNet, elapsed, policy.timeExitMs);
            if (trigger) executor.latchTerminal(position.mint, trigger);
            if (!executor.mayPlanExit(position.mint, now, policy.maxExitAttempts, trigger ?? "TP1") && trigger) {
              executor.runtime(`exit:${position.mint}`, { reason: "terminal_exit_waiting_for_reconciliation_or_retry", trigger, atMs: now });
              continue;
            }
            if (!trigger) {
              const quotes = new Map<bigint, typeof quote>();
              for (const leg of frozen.takeProfits) {
                const tokens = profitSize(frozen, progress, size, leg.label);
                if (!tokens || !executor.mayPlanExit(position.mint, now, policy.maxExitAttempts, leg.label as LiveIntent["trigger"])) continue;
                try {
                  const legQuote = tokens === size ? quote : await transport.quote("sell", position.mint, tokens, quote.slot);
                  if (legQuote.sol > policy.caps.maxNetworkFeeLamports) quotes.set(tokens, legQuote);
                } catch { continue; }
              }
              const planned = profitExit(frozen, progress, size, fullNet, tokens => {
                const priced = quotes.get(tokens);
                return priced ? priced.sol - policy.caps.maxNetworkFeeLamports : undefined;
              }, label => executor.mayPlanExit(position.mint, now, policy.maxExitAttempts, label as LiveIntent["trigger"]));
              if (!planned) continue;
              trigger = planned.label as LiveIntent["trigger"];
              size = planned.tokens;
              if (!executor.mayPlanExit(position.mint, now, policy.maxExitAttempts, trigger)) continue;
              quote = quotes.get(size)!;
            }
          } else trigger = executor.trigger(position.mint, exitTrigger(fullNet, position.cost, elapsed, policy));
          if (!trigger || activeSignal.aborted) continue;
          const operationId = `sell:${position.mint}:${randomUUID()}`;
          executor.recordDecision(operationId, { trigger, proceedsLamports: String(quote.sol), quoteSlot: quote.slot });
          await executor.execute({ operationId, mint: position.mint, venue: quote.venue, side: "sell",
            tokens: size, trigger, limitLamports: minAfterSlippage(quote.sol, policy.slippageBps),
            expiresAt: Date.now() + policy.exitOrderTtlMs, minimumSlot: quote.slot }, mayBuy);
          executor.runtime(`exit:${position.mint}`, { reason: "awaiting_finalized_settlement", trigger, atMs: now });
        } catch {
          executor.runtime(`exit:${position.mint}`, { reason: "exit_quote_or_preflight_failed", atMs: now });
        }
      }
      for (const [signature, launch] of launches) {
        launches.delete(signature);
        if (!feedUsable() || executor.control() !== "active" || launch.blockTimeMs === undefined) continue;
        const expiresAt = Math.min(launch.receivedAtMs, launch.blockTimeMs) + policy.maxLaunchAgeMs;
        if (expiresAt <= Date.now()) continue;
        const operationId = `buy:${launch.mint}`;
        try {
          const list = loadAllowlist(policy.allowlistPath);
          const identity = verifyCreator(launch, list.creators, Date.now());
          if (!identity.eligible) {
            executor.recordDecision(operationId, { outcome: identity.reason, listVersion: list.version, launch });
            continue;
          }
          tracked.set(signature, { event: launch, expiresAt });
          const spendWithHeadroom = policy.spend * 10_000n / BigInt(10_000 + policy.slippageBps);
          const quote = await transport.quote("buy", launch.mint, spendWithHeadroom, launch.slot, launch.creator);
          if (quote.sol > spendWithHeadroom || quote.ataAmount !== 0n) throw new Error("Unexpected buy cost or existing holdings");
          const exit = await transport.quote("sell", launch.mint, quote.tokens, quote.slot);
          if (exit.sol <= policy.caps.maxNetworkFeeLamports) throw new Error("Unusable full position exit quote");
          executor.recordDecision(operationId, { identity, listVersion: list.version, launch, quoteSlot: quote.slot,
            exitQuoteLamports: String(exit.sol), entryQuoteLamports: String(quote.sol) });
          await executor.execute({ operationId, mint: launch.mint, creator: launch.creator, venue: quote.venue,
            side: "buy", tokens: quote.tokens, limitLamports: quote.sol * BigInt(10_000 + policy.slippageBps) / 10_000n,
            expiresAt, minimumSlot: quote.slot, sourceSignature: signature, exitPolicy: policy.exits }, mayBuy);
        } catch {
          executor.recordDecision(`${operationId}:rejected:${signature}`, { outcome: "buy_quote_preflight_or_risk_gate_failed", launch });
        }
      }
      await delay(500, undefined, { signal: activeSignal }).catch(() => undefined);
    }
  } finally {
    controller.abort();
    await feedTask;
    executor.runtime("feed", { healthy: false, reason: readOnlyError ? "feed_stopped_unexpectedly" : "service_stopped" });
    await executor.close();
  }
  if (readOnlyError) throw new Error("Live feed stopped unexpectedly. Review the ledger and restart.");
}
