import { appendFileSync, createReadStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { object } from "./settings.ts";
import type { NormalizedEvent } from "./protocol-types.ts";

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAmount(value: unknown): boolean {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) < (1n << 64n);
}

function validateEvent(value: unknown): NormalizedEvent {
  const event = object(value, "event");
  if (!hasText(event.provider) || !isIndex(event.receivedAtMs)) throw new Error("Invalid event provenance");
  if (event.kind === "feed") {
    if (typeof event.healthy !== "boolean" || (event.slot !== undefined && !isIndex(event.slot))) {
      throw new Error("Invalid feed event");
    }
    return event as unknown as NormalizedEvent;
  }
  if (!isIndex(event.slot) || !hasText(event.signature) ||
      !Array.isArray(event.instructionPath) || !event.instructionPath.every(isIndex) ||
      !["observed", "confirmed", "finalized", "rolled_back"].includes(String(event.commitment)) ||
      (event.transactionIndex !== undefined && !isIndex(event.transactionIndex)) ||
      (event.hydrationMs !== undefined && !isIndex(event.hydrationMs)) ||
      (event.observedHeadSlot !== undefined && !isIndex(event.observedHeadSlot)) ||
      (event.sourceTiming !== undefined && !["historical_block", "confirmed_block", "transaction_sampler", "executed_transaction"].includes(String(event.sourceTiming))) ||
      (event.blockTimeMs !== undefined && !isIndex(event.blockTimeMs))) {
    throw new Error("Invalid transaction provenance");
  }
  if (event.kind === "status") return event as unknown as NormalizedEvent;
  if (event.ownerBalances !== undefined && (!Array.isArray(event.ownerBalances) || event.ownerBalances.length > 256 ||
      !event.ownerBalances.every(value => {
        const row = object(value, "owner balance");
        return hasText(row.account) && hasText(row.owner) && isAmount(row.amount);
      }))) throw new Error("Invalid owner balance evidence");
  const mint = event.mint;
  if (!hasText(mint) || Object.hasOwn(Object.prototype, mint) || !hasText(event.quoteMint)) {
    throw new Error("Invalid mint fields");
  }
  if (event.reserves !== undefined) {
    const reserves = object(event.reserves, "reserves");
    if (![reserves.virtualToken, reserves.virtualSol, reserves.realToken, reserves.realSol].every(isAmount) ||
        typeof reserves.complete !== "boolean" ||
        (reserves.feeBps !== undefined && (!isIndex(reserves.feeBps) || reserves.feeBps >= 10000))) {
      throw new Error("Invalid reserves");
    }
  }
  switch (event.kind) {
    case "launch":
      if (!hasText(event.creator) || !hasText(event.launchUser) ||
          !Array.isArray(event.signers) || !event.signers.every(hasText) || typeof event.supported !== "boolean" ||
          (event.concentrationBps !== undefined && (!isIndex(event.concentrationBps) || event.concentrationBps > 10000))) {
        throw new Error("Invalid launch event");
      }
      break;
    case "trade":
      if ((event.side !== "buy" && event.side !== "sell" && event.side !== "update") ||
          (event.venue !== "curve" && event.venue !== "pumpswap") || typeof event.canonical !== "boolean" ||
          (event.signers !== undefined && (!Array.isArray(event.signers) || !event.signers.every(hasText)))) {
        throw new Error("Invalid trade event");
      }
      break;
    case "migration":
      if (typeof event.canonical !== "boolean") throw new Error("Invalid migration event");
      break;
    default:
      throw new Error("Unknown event kind");
  }
  return event as unknown as NormalizedEvent;
}

export async function readTape(path: string): Promise<NormalizedEvent[]> {
  const reader = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  const events: NormalizedEvent[] = [];
  let lineNumber = 0;
  for await (const line of reader) {
    lineNumber++;
    if (!line.trim()) continue;
    try {
      const row = object(JSON.parse(lineNumber === 1 ? line.replace(/^\uFEFF/, "") : line), "record");
      if (row.type === "raw") continue;
      events.push(validateEvent(row.type === "event" ? row.event : row));
      if (events.length > 500000) throw new Error("Replay at most 500,000 events per window");
    } catch (error) {
      const reason = error instanceof SyntaxError ? "invalid JSON" : (error as Error).message;
      throw new Error(`${path}:${lineNumber}: ${reason}`);
    }
  }
  if (!events.length) throw new Error("Tape has no normalized events");
  return events;
}

export function recorder(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  return (type: "event" | "raw", data: unknown) => {
    const row = type === "event" ? { type, event: data } : { type, record: data };
    appendFileSync(path, JSON.stringify(row) + "\n", { encoding: "utf8", mode: 0o600 });
  };
}
