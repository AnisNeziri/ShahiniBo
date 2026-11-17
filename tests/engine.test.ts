import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { PaperEngine, type PaperSettings } from '../src/engine.ts';
import { buildComparison, buildReport } from '../src/report.ts';
import { verifyCreator } from '../src/identity.ts';
import type { LaunchEvent, NormalizedEvent, Reserves, TradeEvent } from '../src/protocol-types.ts';
import { afterFill, minAfterSlippage, quoteBuy, quoteSell } from '../src/strategy.ts';

const tape = readFileSync(new URL('../fixtures/pumpfun-events.jsonl', import.meta.url), 'utf8').trim().split(/\r?\n/)
  .map((line) => JSON.parse(line) as NormalizedEvent);
const settings = JSON.parse(readFileSync(new URL('../config/paper.example.json', import.meta.url), 'utf8')).strategy as PaperSettings;
const first = tape[0] as LaunchEvent;
const syntheticCreator = {
  wallet: first.creator, alias: 'Fixture creator', method: 'wallet-challenge' as const,
  evidenceRef: 'synthetic fixture', verifiedAtMs: first.receivedAtMs - 1_000, activeAtMs: first.receivedAtMs - 1_000,
};
const identity = (launch: LaunchEvent, decisionAtMs: number, chainAtMs: number) =>
  verifyCreator(launch, [syntheticCreator], decisionAtMs, chainAtMs);

function engine(ledger: Ledger, id: string, overrides: Partial<PaperSettings> = {}, mode: 'replay' | 'paper' = 'replay') {
  return new PaperEngine({ id, mode, ledger, settings: { ...settings, ...overrides }, verifyCreator: identity });
}

function replay(ledger: Ledger, id: string, overrides?: Partial<PaperSettings>) {
  const runner = engine(ledger, id, overrides);
  for (const event of tape) runner.accept(event);
  runner.finish();
  return buildReport(ledger, id);
}

test('replay rejects a spoof, deduplicates a launch, recovers a failed exit, and exits after migration', () => {
  const ledger = new Ledger(':memory:');
  try {
    const result = replay(ledger, 'acceptance');
    const again = replay(ledger, 'again');
    assert.deepEqual(result, { ...again, runId: 'acceptance' });
    assert.equal(result.launches.rejectionReasons['creator-signer-mismatch'], 1);
    assert.equal(result.launches.rejectionReasons.unsupported_quote, 1);
    assert.equal(result.launches.rejectionReasons.feed_unhealthy_or_stale, 1);
    assert.equal(result.launches.rejectionReasons.stale_launch, 1);
    assert.equal(result.launches.rejectionReasons.rolled_back_launch, 1);
    assert.equal(result.coverage.duplicateEvents, 1);
    assert.equal(result.coverage.rollbacks, 1);
    assert.equal(result.orders.entry.filled, 2);
    assert.equal(result.orders.exit.filled, 2);
    assert.equal(result.orders.exit.failed, 1);
    assert.equal(result.returns.failedTransactionFeesLamports, '6000');
    assert.equal(result.returns.realizedNetLamports, '9316109');
    assert.equal(result.openPositions.length, 0);
    const journal = ledger.journal('acceptance');
    const failed = journal.find(({ kind, operationId, data }) =>
      kind === 'result' && operationId === first.mint + ':sell:1' && (data as { status: string }).status === 'failed');
    assert.ok(failed);
    assert.equal((failed.data as { reason: string }).reason, 'slippage_limit');
    const postMigration = journal.filter(({ kind, data }) => kind === 'fill' &&
      (data as { venue: string; side: string }).venue === 'pumpswap' && (data as { side: string }).side === 'sell');
    assert.equal(postMigration.length, 1);
  } finally {
    ledger.close();
  }
});

test('a closed SQLite ledger resumes an open position, pending work, and tape cursor', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shahinibot-ledger-'));
  const path = join(directory, 'replay.sqlite');
  let ledger = new Ledger(path);
  try {
    const runner = engine(ledger, 'restart');
    for (let i = 0; i < 6; i++) {
      const event = tape[i]!;
      runner.accept(event, undefined, { name: 'cursor', point: { slot: i + 1, updatedAtMs: event.receivedAtMs } });
    }
    const unresolved = runner.state.positions[first.mint];
    assert.ok(unresolved);
    assert.equal(unresolved.unresolved, 'slippage_limit');
    assert.equal(unresolved.attempts, 1);
    assert.equal(unresolved.costLamports, '10012000');
    const expected = runner.state;
    ledger.close();
    ledger = new Ledger(path);
    const reopened = engine(ledger, 'restart');
    assert.deepEqual(reopened.state, expected);
    assert.equal(ledger.checkpoint('cursor')?.slot, 6);
    for (const event of tape.slice(ledger.checkpoint('cursor')!.slot)) reopened.accept(event);
    reopened.finish();
    const resumed = buildReport(ledger, 'restart');
    const fresh = replay(ledger, 'fresh');
    assert.deepEqual(resumed, { ...fresh, runId: 'restart' });
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a buy cannot overspend the available simulated cash or sneak below a changed slippage limit', () => {
  const ledger = new Ledger(':memory:');
  try {
    const underfunded = replay(ledger, 'underfunded', { startingLamports: '10000001' });
    assert.equal(underfunded.orders.entry.filled, 0);
    assert.equal(underfunded.launches.rejectionReasons.insufficient_paper_balance, 3);

    const runner = engine(ledger, 'slippage');
    runner.accept(first);
    const marketRise = tape[2] as TradeEvent;
    runner.accept({ ...marketRise, receivedAtMs: first.receivedAtMs + 350 });
    runner.advance(first.receivedAtMs + 1_000);
    assert.equal(buildReport(ledger, 'slippage').orders.entry.failed, 1);
    assert.equal(runner.state.balanceLamports, '999994000');
    assert.equal(buildReport(ledger, 'slippage').returns.realizedNetLamports, '-6000');
  } finally {
    ledger.close();
  }
});

test('an ambiguous slot order blocks an entry without a false fill', () => {
  const ledger = new Ledger(':memory:');
  try {
    const runner = engine(ledger, 'ambiguous');
    runner.accept({ ...first, transactionIndex: undefined });
    runner.accept({ ...(tape[2] as TradeEvent), slot: first.slot, transactionIndex: undefined,
      receivedAtMs: first.receivedAtMs + 50, blockhash: first.blockhash });
    runner.advance(first.receivedAtMs + 1_000);
    const report = buildReport(ledger, 'ambiguous');
    assert.equal(report.coverage.unknownMarketEvents, 1);
    assert.equal(report.launches.rejectionReasons.venue_state_missing_or_stale, 1);
    assert.equal(report.orders.entry.filled, 0);
  } finally {
    ledger.close();
  }
});

test('paper kill persists and does not block reducing exposure', () => {
  const ledger = new Ledger(':memory:');
  try {
    const runner = engine(ledger, 'paper-kill', {}, 'paper');
    runner.accept({ kind: 'feed', provider: first.provider, receivedAtMs: first.receivedAtMs, healthy: true });
    runner.accept(first);
    runner.advance(first.receivedAtMs + 800);
    assert.ok(runner.state.positions[first.mint]);
    ledger.setControl('paper', 'killed');
    for (const event of tape.slice(2)) runner.accept(event);
    runner.finish();
    const report = buildReport(ledger, 'paper-kill');
    assert.equal(report.orders.entry.filled, 1);
    assert.equal(report.orders.exit.filled, 1);
    assert.equal(report.launches.rejectionReasons.entries_disabled, 2);
    assert.equal(ledger.control('paper'), 'killed');
  } finally {
    ledger.close();
  }
});

test('integer fees round against the trader and rent is refunded once after closing', () => {
  const state: Reserves = { virtualToken: '1000', virtualSol: '100', realToken: '1000', realSol: '100', feeBps: 100, complete: false };
  const limits = { impactBps: 1_000, maxVenueFeeBps: 120, executionFee: 1n };
  const buy = quoteBuy(10n, state, limits);
  assert.ok(buy.ok);
  assert.deepEqual(buy, { ok: true, tokens: 82n, grossSol: 9n, venueFee: 1n, netSol: 11n, impactBps: 826 });
  const sell = quoteSell(82n, afterFill(state, buy, 'buy'), limits);
  assert.ok(sell.ok);
  assert.equal(sell.netSol, 6n);
  assert.equal(minAfterSlippage(101n, 100), 100n);
  const ledger = new Ledger(':memory:');
  try {
    const normal = replay(ledger, 'normal');
    const withRent = replay(ledger, 'with_rent', { tokenAccountRentLamports: '2039280' });
    assert.equal(withRent.returns.cashLamports, normal.returns.cashLamports);
    assert.equal(withRent.returns.realizedNetLamports, normal.returns.realizedNetLamports);
  } finally {
    ledger.close();
  }
});

test('the comparison runs the baseline and filters on the same immutable tape', () => {
  const plain = structuredClone(tape);
  const result = buildComparison(tape, settings, identity);
  assert.deepEqual(tape, plain);
  assert.equal(result.baseline.launches.observed, result.verifiedCreator.launches.observed);
  assert.equal(result.baseline.orders.entry.filled, 3);
  assert.equal(result.verifiedCreator.orders.entry.filled, 2);
  assert.equal(result.verifiedCreator.returns.realizedNetLamports, '9316109');
  assert.equal(result.sensitivities.length, 5);
  assert.equal(result.verdict, 'inconclusive');
});
