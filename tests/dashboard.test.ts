import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import bs58 from 'bs58';
import { startDashboard } from '../src/dashboard.ts';
import { PaperEngine } from '../src/engine.ts';
import { verifyCreator } from '../src/identity.ts';
import { Ledger } from '../src/ledger.ts';
import { loadSettings } from '../src/settings.ts';
import { LiveExecutor, setLiveControl } from '../src/live-execution.ts';
import type { LiveTransport } from '../src/live-execution.ts';
import { readTape } from '../src/tape.ts';

type StreamMessage = { event: string; id?: string; data: any };

async function openStream(url: string, cursor?: string, last?: string) {
  const stop = new AbortController();
  const response = await fetch(`${url}/api/events${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`, {
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(8000)]),
    headers: last ? { 'Last-Event-ID': last } : {},
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  async function next(): Promise<StreamMessage> {
    for (;;) {
      const end = pending.indexOf('\n\n');
      if (end !== -1) {
        const frame = pending.slice(0, end).split('\n');
        pending = pending.slice(end + 2);
        const type = frame.find(line => line.startsWith('event: '));
        const body = frame.find(line => line.startsWith('data: '));
        if (type && body) {
          return { event: type.slice(7), id: frame.find(line => line.startsWith('id: '))?.slice(4), data: JSON.parse(body.slice(6)) };
        }
        continue;
      }
      const value = await reader.read();
      if (value.done) throw new Error('Dashboard stream ended before the expected message');
      pending += decoder.decode(value.value, { stream: true });
    }
  }
  return {
    next,
    async until(predicate: (record: StreamMessage) => boolean) {
      for (;;) {
        const record = await next();
        if (predicate(record)) return record;
      }
    },
    close: () => stop.abort(),
  };
}

const tape = await readTape('fixtures/ladder-events.jsonl');
const config = loadSettings('fixtures/ladder.demo.json', 'paper');
const launch = tape[0]!;
const spoof = tape[2]!;
assert.ok(launch.kind === 'launch' && spoof.kind === 'launch');
const first = launch.receivedAtMs;

async function setup(context: TestContext, mode: 'paper' | 'replay' = 'replay') {
  const directory = mkdtempSync(join(tmpdir(), 'shahini-dashboard-test-'));
  const database = join(directory, 'test.sqlite');
  const ledger = new Ledger(database);
  const runId = 'dashboard-test';
  let now = first;
  const engine = new PaperEngine({ id: runId, ledger, mode, settings: config.paper!,
    verifyCreator: (launch, atMs, chain) => verifyCreator(launch, config.allowlist!.creators, atMs, chain) });
  const dashboard = await startDashboard({ database, runId, port: 0, pollMs: 20, now: () => now });
  context.after(async () => {
    await dashboard.close();
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { url: dashboard.url, database, ledger, runId, engine, setNow: (value: number) => { now = value; } };
}

test('dashboard streams persisted paper actions and distinct market trades, then reconnects without duplicate IDs', async t => {
  const d = await setup(t);
  const initial = await (await fetch(`${d.url}/api/snapshot`)).json();
  assert.deepEqual(initial.activity, []);
  const firstStream = await openStream(d.url, initial.cursor);
  t.after(firstStream.close);
  assert.equal((await firstStream.next()).event, 'state');

  for (const event of tape.slice(0, 4)) d.engine.accept(event);
  d.engine.advance(first + 500);
  const activity = await firstStream.until(message => message.event === 'activity' && message.data.some((row: any) => row.kind === 'fill'));
  assert.ok(activity.id);
  const rows = activity.data as any[];
  const seen = new Set(rows.map(row => row.id));
  assert.equal(seen.size, rows.length);
  const fill = rows.find(row => row.kind === 'fill');
  assert.equal(fill.source, 'paper');
  assert.equal(fill.data.side, 'buy');
  assert.equal(fill.links.explorer, undefined);
  assert.ok(rows.some(row => row.source === 'market' && row.kind === 'trade'));
  assert.ok(rows.some(row => row.kind === 'decision' && row.data.reason === 'creator-signer-mismatch'));
  firstStream.close();

  const nextStream = await openStream(d.url, initial.cursor, activity.id);
  t.after(nextStream.close);
  const state = await nextStream.next();
  assert.equal(state.event, 'state');
  assert.equal(state.data.positions.length, 1);
  assert.equal(state.data.positions[0].originalTokens, state.data.positions[0].remainingTokens);
  assert.match(state.data.positions[0].links.mint, /https:\/\/pump\.fun\/coin\//);
  assert.ok(BigInt(state.data.positions[0].liquidationLamports) > 0n);

  d.engine.accept(tape[4]!);
  d.engine.advance(first + 1500);
  const leg = await nextStream.until(message => message.event === 'activity' && message.data.some((row: any) => row.kind === 'position_partial'));
  assert.ok(leg.data.every((row: any) => !seen.has(row.id)));
  assert.ok(leg.data.some((row: any) => row.kind === 'position_partial' && row.data.reason === 'TP1'));
  assert.ok(leg.data.some((row: any) => row.kind === 'fill' && row.data.side === 'sell'));
  for (const event of tape.slice(5)) d.engine.accept(event);
  d.engine.finish();
  const complete = await nextStream.until(message => message.event === 'state' && message.data.performance?.orders.exit.filled === 3);
  assert.equal(complete.data.positions.length, 0);
  const cli = spawnSync(process.execPath, ['src/cli.ts', 'report', '--db', d.database, '--run-id', d.runId], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const official = JSON.parse(cli.stdout);
  assert.deepEqual(complete.data.performance.returns, official.returns);
  assert.deepEqual(complete.data.performance.orders, official.orders);
  const coin = await (await fetch(`${d.url}/api/coin?mint=${spoof.mint}`)).json();
  assert.equal(coin.decision.data.reason, 'creator-signer-mismatch');
  assert.equal(coin.decision.data.risk.ruleVersion, 'fixture-risk-v1');
  assert.equal(coin.decision.data.shadow.available, false);
});

test('dashboard marks paper data stale and withholds expired net liquidation quotes', async t => {
  const d = await setup(t, 'paper');
  d.engine.accept({ kind: 'feed', provider: 'test', healthy: true, receivedAtMs: first, slot: 1 });
  for (const event of tape.slice(0, 4)) d.engine.accept(event);
  d.engine.advance(first + 500);
  d.setNow(first + 500);
  const fresh = await (await fetch(`${d.url}/api/snapshot`)).json();
  assert.equal(fresh.feed.stale, false);
  assert.equal(fresh.positions[0].quoteStale, false);
  const stream = await openStream(d.url, fresh.cursor);
  t.after(stream.close);
  const initial = await stream.next();
  assert.equal(initial.event, 'state');
  d.setNow(first + 50_000);
  const stale = await stream.until(message => message.event === 'state' && message.data.feed.stale);
  assert.equal(stale.data.positions[0].quoteStale, true);
  assert.equal(stale.data.positions[0].liquidationLamports, null);
  const coin = await (await fetch(`${d.url}/api/coin?mint=${launch.mint}`)).json();
  assert.equal(coin.decision.riskStale, true);
  assert.equal(coin.decision.data.risk.cutoffMs, first + 150);
});

test('dashboard resets clients after history gaps and only accepts local read requests', async t => {
  const d = await setup(t);
  const initial = await (await fetch(`${d.url}/api/snapshot`)).json();
  const run = d.ledger.run(d.runId);
  d.ledger.save({ id: d.runId, revision: run.revision, state: run.state, journal: Array.from({ length: 305 }, (_, i) => ({
    kind: 'decision', atMs: first + i, mint: launch.mint, data: { result: 'rejected', reason: 'fixture_backlog' },
  })) });
  const stream = await openStream(d.url, initial.cursor);
  t.after(stream.close);
  const reset = await stream.next();
  assert.equal(reset.event, 'reset');
  assert.equal(reset.data.activity.length, 140);
  assert.equal(reset.id, reset.data.cursor);
  assert.notEqual(reset.id, initial.cursor);
  assert.equal((await fetch(`${d.url}/api/snapshot`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${d.url}/api/snapshot`, { headers: { origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${d.url}/api/coin?mint=javascript%3Ax`)).status, 400);
  assert.equal((await fetch(`${d.url}/src/live.ts`)).status, 404);
  await wait(30);
});

test('dashboard labels mock live settlement as confirmed only after persistence', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'shahini-dashboard-live-records-'));
  const database = join(dir, 'records.sqlite');
  const signature = bs58.encode(Buffer.alloc(64, 7));
  let outcome: Awaited<ReturnType<LiveTransport['inspect']>> = { outcome: 'seen' };
  const writer = new LiveExecutor(database, {
    wallet: 'test-only',
    async prepare() { return { signature, blockhash: 'test-block', lastValidBlockHeight: 9, wire: 'test-wire' }; },
    async send() { return signature; },
    async inspect() { return outcome; },
  }, { maxWalletLamports: 50_000_000n, maxEntryLamports: 10_000_000n, maxExposureLamports: 50_000_000n,
    maxNetworkFeeLamports: 10_000n, maxAccountDepositLamports: 0n, dailyLossLamports: 50_000_000n,
    maxOpenPositions: 2, maxBroadcasts: 1 });
  const dashboard = await startDashboard({ database, port: 0 });
  t.after(async () => {
    await dashboard.close();
    await writer.close();
    rmSync(dir, { recursive: true, force: true });
  });
  setLiveControl(database, 'active');
  await writer.execute({ operationId: 'mock-record', mint: launch.mint, side: 'buy', venue: 'curve',
    tokens: 250n, limitLamports: 5_000_000n, expiresAt: Date.now() + 20_000,
    minimumSlot: 5, creator: launch.creator }, () => true);
  const pending = await (await fetch(`${dashboard.url}/api/snapshot`)).json();
  assert.equal(pending.run.mode, 'live');
  assert.equal(pending.submissions.length, 1);
  assert.equal(pending.submissions[0].state, 'pending');
  assert.ok(!pending.activity.some((item: any) => item.kind === 'fill'));
  outcome = { outcome: 'filled', slot: 7, fee: 5_000n, solDelta: -1_005_000n, tokenDelta: 250n, rentDelta: 0n };
  await writer.recover(() => true);
  const settled = await (await fetch(`${dashboard.url}/api/snapshot`)).json();
  const fill = settled.activity.find((item: any) => item.kind === 'fill');
  assert.equal(fill.source, 'live');
  assert.equal(fill.links.explorer, `https://explorer.solana.com/tx/${signature}`);
  assert.equal(fill.data.slot, 7);
  assert.equal(settled.positions[0].liquidationLamports, null);
  assert.deepEqual(settled.submissions, []);
  assert.ok(!JSON.stringify(settled).includes('test-wire'));
});
