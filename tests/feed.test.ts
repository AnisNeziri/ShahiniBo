import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { importBlocks, runReadOnlyFeed } from "../src/feed.ts";
import { decodeTransaction } from "../src/protocol.ts";
import type { NormalizedEvent } from "../src/protocol-types.ts";
import type { RpcTransaction } from "../src/protocol.ts";

const recorded = JSON.parse(readFileSync(new URL("../fixtures/public-create-v0.redacted.json", import.meta.url), "utf8"))
  .transaction as RpcTransaction;
const signature = recorded.transaction.signatures[0]!;
const settings = { rpcUrl: "http://127.0.0.1:8899", provider: "offline-rpc", backlogSlots: 32,
  hydrationDeadlineMs: 2_000, staleMs: 5_000 };

function block(slot: number, blockhash: string, hasLaunch: boolean) {
  return { blockhash, parentSlot: slot - 1, blockTime: recorded.blockTime,
    transactions: hasLaunch ? [recorded] : [] };
}

function request(body: unknown): { method: string; params: unknown[] } {
  assert.equal(typeof body, "string");
  return JSON.parse(body as string) as { method: string; params: unknown[] };
}

function response(result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", result });
}

test("bounded archival import preserves execution order and reports missing and omitted slots", async t => {
  t.mock.method(globalThis, "fetch", async (_: unknown, options: RequestInit) => {
    const { method, params } = request(options.body);
    if (method === "getBlocks") return response([9, 11]);
    assert.equal(method, "getBlock");
    return response(params[0] === 9 ? block(9, "historical-block", true) : null);
  });
  const events: NormalizedEvent[] = [];
  const manifest = await importBlocks(settings, 9, 11, { event: event => events.push(event) }, AbortSignal.timeout(5000));
  assert.equal(manifest.blocksRead, 1);
  assert.deepEqual(manifest.omittedSlots, [10]);
  assert.deepEqual(manifest.missingBlocks, [11]);
  assert.equal(manifest.timing, "block_time_only");
  assert.deepEqual(events.map(event => event.kind), ["launch", "trade", "feed", "feed"]);
  assert.equal(events[2]?.kind === "feed" && events[2].reason, "archive_slot_complete");
  assert.equal(events[3]?.kind === "feed" && events[3].healthy, false);
  for (const event of events.slice(0, 2)) {
    assert.ok(event.kind !== "feed");
    assert.equal(event.commitment, "finalized");
    assert.equal(event.blockhash, "historical-block");
    assert.equal(event.transactionIndex, 0);
    assert.equal(event.receivedAtMs, recorded.blockTime! * 1000);
  }
});

test("confirmed feed recognizes live receipt, then reconciles a fork after reconnect from the durable checkpoint", async t => {
  const stop = new AbortController();
  const events: NormalizedEvent[] = [];
  let generation = 0;
  let socket: FakeSocket | undefined;
  class FakeSocket extends EventTarget {
    constructor() {
      super();
      generation += 1;
      socket = this;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(body: string) {
      const { id } = JSON.parse(body) as { id: number };
      this.deliver({ id, result: id + 100 });
      if (id === 3 && generation === 1) {
        this.deliver({ method: "logsNotification", params: { result: { context: { slot: 9 }, value: { signature, err: null } } } });
      }
    }
    deliver(data: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
    }
    close() { this.dispatchEvent(new Event("close")); }
  }
  t.mock.property(globalThis, "WebSocket", FakeSocket as unknown as typeof WebSocket);
  t.mock.method(globalThis, "fetch", async (_: unknown, options: RequestInit) => {
    const { method, params } = request(options.body);
    const commitment = params.find(value => typeof value === "object") as { commitment: string; transactionDetails?: string };
    if (method === "getSlot") return response(generation === 1 ? commitment.commitment === "finalized" ? 8 : 9 : 10);
    if (method === "getBlocks") return response(generation === 1 ? [9] : [9, 10]);
    assert.equal(method, "getBlock");
    const slot = Number(params[0]);
    if (generation === 1) return response(block(slot, "displaced-fork", true));
    return response(block(slot, `canonical-${slot}`, false));
  });
  const checkpoints: number[] = [];
  const rawSlots: number[] = [];
  await runReadOnlyFeed(settings, {
    resumeSlot: 8,
    event(event) {
      events.push(event);
      if (event.kind === "launch" && event.commitment === "confirmed") socket?.close();
    },
    raw(record) { rawSlots.push(record.transaction.slot); },
    checkpoint(slot) {
      checkpoints.push(slot);
      if (slot === 10) stop.abort();
    },
  }, AbortSignal.any([stop.signal, AbortSignal.timeout(6000)]));
  assert.equal(generation, 2);
  assert.deepEqual(rawSlots, [9]);
  assert.deepEqual(checkpoints, [9, 10]);
  assert.ok(events.some(event => event.kind === "status" && event.commitment === "observed" && event.signature === signature));
  const launch = events.find(event => event.kind === "launch");
  assert.ok(launch?.kind === "launch");
  assert.equal(launch.late, false);
  assert.equal(launch.blockhash, "displaced-fork");
  assert.ok(events.some(event => event.kind === "status" && event.commitment === "rolled_back" && event.mint === launch.mint));
  assert.ok(events.some(event => event.kind === "feed" && event.reason === "confirmed_fork_changed" && !event.healthy));
});

test("restart reconciles persisted confirmed events even when their slot vanished from the new chain", async t => {
  const stop = new AbortController();
  class FakeSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(body: string) {
      const { id } = JSON.parse(body) as { id: number };
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: id + 100 }) }));
    }
    close() { this.dispatchEvent(new Event("close")); }
  }
  t.mock.property(globalThis, "WebSocket", FakeSocket as unknown as typeof WebSocket);
  t.mock.method(globalThis, "fetch", async (_: unknown, options: RequestInit) => {
    const { method, params } = request(options.body);
    if (method === "getSlot") return response(10);
    if (method === "getBlocks") return response([10]);
    assert.equal(method, "getBlock");
    return response({ ...block(Number(params[0]), "canonical", false), parentSlot: 8 });
  });
  const seed = decodeTransaction({ ...recorded, slot: 9 }, {
    provider: settings.provider, receivedAtMs: Date.now() - 500, blockhash: "persisted-orphan",
    transactionIndex: 0, commitment: "confirmed",
  });
  const events: NormalizedEvent[] = [];
  await runReadOnlyFeed(settings, {
    resumeSlot: 8, resumeConfirmed: seed, event: event => events.push(event),
    checkpoint(slot) { if (slot === 10) stop.abort(); },
  }, AbortSignal.any([stop.signal, AbortSignal.timeout(3000)]));
  const rollbacks = events.filter(event => event.kind === "status" && event.commitment === "rolled_back");
  assert.equal(rollbacks.length, 2);
  assert.ok(rollbacks.every(event => event.kind === "status" && event.blockhash === "persisted-orphan"));
});
