import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { TrackerWorker, trackerAsOf, trackerFindings, type TrackerSnapshot } from '../src/tracker.ts';

const mint = '2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr';
const otherMint = '2VDW9dFE1ZXz4zWAbaBDQFynNVdRpQ73HyfSHMzBSL6Z';

function response(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

async function sample(pull: typeof fetch, timeoutMs = 100) {
  let resolve!: (value: TrackerSnapshot) => void;
  const saved = new Promise<TrackerSnapshot>(accept => { resolve = accept; });
  const worker = new TrackerWorker({ key: 'test-only-key', fetch: pull, timeoutMs, save: resolve });
  const fail = new AbortController();
  try {
    worker.enqueue(mint, Date.now());
    worker.enqueue(mint, Date.now());
    return await Promise.race([saved, sleep(1500, undefined, { signal: fail.signal }).then(() => { throw new Error('Worker did not save'); })]);
  } finally { fail.abort(); await worker.close(); }
}

test('tracker preserves zero findings, records findings and keeps omitted fields unknown', async () => {
  const observed = Date.now();
  let called = 0;
  const result = await sample(async (url, opts) => {
    called++;
    assert.equal(String(url), 'https://data.solanatracker.io/tokens/' + mint);
    assert.equal(new Headers(opts?.headers).get('x-api-key'), 'test-only-key');
    return response({ token: { mint }, risk: { score: 0, top10: 0, rugged: false, lastUpdated: observed,
      risks: [{ name: 'test finding', level: 'warn', score: 0 }] }, holders: 0 });
  });
  assert.equal(called, 1);
  assert.deepEqual(result.findings, { score: 0, top10Percent: 0, rugged: false, holderCount: 0,
    findings: [{ name: 'test finding', level: 'warn', score: 0 }] });
  assert.ok(trackerAsOf(result, result.fetchedAtMs, 15_000).eligible);
  assert.equal(trackerAsOf(result, result.fetchedAtMs - 1, 15_000).reason, 'received_after_decision');
  assert.equal(trackerAsOf(result, result.fetchedAtMs + 30_000, 15_000).reason, 'stale_or_future_provider_time');
  assert.deepEqual(trackerFindings({ token: { mint }, pools: [{ lastUpdated: observed }] }), {
    findings: {}, providerAtMs: null, poolUpdatedAtMs: observed,
  });
  const omitted = await sample(async () => response({ token: { mint }, risk: { lastUpdated: observed } }));
  assert.equal(trackerAsOf(omitted, omitted.fetchedAtMs, 15_000).reason, 'risk_fields_omitted');
});

test('tracker aborts timed-out requests and pauses its queue after rate limits', async () => {
  const timed = await sample(async (_, opts) => {
    return new Promise((_resolve, reject) => opts?.signal?.addEventListener('abort', () => reject(opts.signal!.reason), { once: true }));
  }, 25);
  assert.equal(timed.status, 'timeout');
  let resolve!: (row: TrackerSnapshot) => void;
  const delivered = new Promise<TrackerSnapshot>(accept => { resolve = accept; });
  let count = 0;
  const worker = new TrackerWorker({ key: 'test-only-key', concurrency: 1, minIntervalMs: 0, save: resolve,
    fetch: async () => { count++; return new Response('', { status: 429, headers: { 'retry-after': '2' } }); } });
  try {
    worker.enqueue(mint, Date.now());
    worker.enqueue(otherMint, Date.now());
    assert.equal((await delivered).status, 'rate_limited');
    await sleep(30);
    assert.equal(count, 1);
  } finally { await worker.close(); }
});
