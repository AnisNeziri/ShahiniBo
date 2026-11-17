import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Ledger } from '../src/ledger.ts';
import { PaperEngine } from '../src/engine.ts';
import type { PaperSettings } from '../src/engine.ts';
import { buildReport, exportExamples } from '../src/report.ts';
import { loadSettings } from '../src/settings.ts';
import { readTape } from '../src/tape.ts';
import { verifyCreator } from '../src/identity.ts';
import { decimalUnits, profitSize, startExit, validateExitPolicy } from '../src/exits.ts';
import { evaluateModel, scoreModel, strategyFingerprint, trainModel, type Example } from '../src/model.ts';
import { measureCapture } from '../src/measure.ts';
import type { LaunchEvent, TradeEvent } from '../src/protocol-types.ts';
import type { RiskSnapshot } from '../src/risk.ts';

const tape = await readTape('fixtures/ladder-events.jsonl');
const tp3 = await readTape('fixtures/tp3-events.jsonl');
const launch = tape[0] as LaunchEvent;
const earlyTrade = tape[3] as TradeEvent;
const settings = loadSettings('fixtures/ladder.demo.json', 'paper');
const policy = settings.paper!;
const identity = (row: LaunchEvent, time: number, chain: number) => verifyCreator(row, settings.allowlist!.creators, time, chain);

function runner(ledger: Ledger, id: string, config: PaperSettings = policy) {
  return new PaperEngine({ id, ledger, mode: 'replay', settings: config, verifyCreator: identity });
}

test('crossed targets execute in label order from original size, survive restart, then stop the remainder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shahini-ladder-'));
  const path = join(dir, 'run.sqlite');
  let db = new Ledger(path);
  try {
    let engine = runner(db, 'ladder');
    for (const event of tape.slice(0, 5)) engine.accept(event);
    engine.advance(launch.receivedAtMs + 1350);
    const first = engine.state.positions[launch.mint]!;
    assert.equal(first.exit?.legs.TP1?.state, 'filled');
    assert.ok(engine.state.orders[`${launch.mint}:sell`]);
    assert.equal(first.rentLamports, '2039280');
    db.close();
    db = new Ledger(path);
    engine = runner(db, 'ladder');
    engine.accept(tape[4]!);
    for (const event of tape.slice(5)) engine.accept(event);
    engine.finish();
    const report = buildReport(db, 'ladder');
    const closed = report.closedPositions[0]!;
    assert.equal(report.orders.entry.filled, 1);
    assert.equal(report.orders.exit.filled, 3);
    assert.equal(report.launches.rejectionReasons['creator-signer-mismatch'], 1);
    assert.equal(report.coverage.duplicateEvents, 2);
    assert.equal(closed.exitReason, 'stop_loss');
    assert.equal(report.openPositions.length, 0);
    const legs = closed.exit!.legs;
    const original = BigInt(closed.exit!.originalTokens);
    assert.deepEqual(Object.keys(legs), ['TP1', 'TP2', 'stop_loss']);
    assert.equal(BigInt(legs.TP1!.soldTokens), original / 4n);
    assert.equal(BigInt(legs.TP2!.soldTokens), original / 4n);
    assert.equal(BigInt(legs.stop_loss!.soldTokens), original - 2n * (original / 4n));
    const sellFills = db.journal('ladder').filter(row => row.kind === 'fill' && (row.data as { side: string }).side === 'sell');
    assert.deepEqual(sellFills.map(row => (row.data as { rentLamports: string }).rentLamports), ['0', '0', '2039280']);
    assert.equal(report.returns.cashLamports, String(1_000_000_000n + BigInt(closed.pnlLamports)));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('token price leg requotes after a migration and decimals preserve base-unit rounding', () => {
  const db = new Ledger(':memory:');
  try {
    const pricing = loadSettings('fixtures/tp3.demo.json', 'paper').paper!;
    const engine = runner(db, 'price', pricing);
    for (const event of tp3) engine.accept(event);
    engine.finish();
    const position = engine.state.positions[launch.mint]!;
    const price = position.exit!.legs.TP3!;
    assert.equal(BigInt(price.soldTokens), BigInt(position.exit!.originalTokens) / 4n);
    assert.ok(db.journal('price').some(row => row.operationId === price.operationId && row.kind === 'fill' &&
      (row.data as { venue: string }).venue === 'pumpswap'));
    const progress = startExit(pricing.exits!, '3', '100000000');
    assert.equal(profitSize(pricing.exits!, progress, 3n, 'TP1'), 0n);
    assert.equal(decimalUnits('0.00000004', 18), 40_000_000_000n);
    assert.throws(() => decimalUnits('0.0000000001', 9), /precision/);
    assert.throws(() => validateExitPolicy({ ...pricing.exits, takeProfits: [
      ...pricing.exits!.takeProfits.slice(0, 2), { ...pricing.exits!.takeProfits[2], sellPercent: '50.01' },
    ] }), /100%/);
  } finally { db.close(); }
});

test('a pending TP reconciles before a latched stop and an unavailable route is not a fill', () => {
  const db = new Ledger(':memory:');
  try {
    const engine = runner(db, 'pending');
    for (const event of tape.slice(0, 5)) engine.accept(event);
    engine.advance(launch.receivedAtMs + 1150);
    assert.equal(engine.state.orders[`${launch.mint}:sell`]?.phase, 'land');
    engine.accept({ ...tape[5] as TradeEvent, receivedAtMs: launch.receivedAtMs + 1200 });
    assert.equal(engine.state.positions[launch.mint]?.exit?.terminal, 'stop_loss');
    assert.equal(engine.state.orders[`${launch.mint}:sell`]?.reason, 'TP1');
    engine.accept({ ...tape[6]!, receivedAtMs: launch.receivedAtMs + 2700 });
    const report = buildReport(db, 'pending');
    assert.equal(report.orders.exit.failed, 1);
    assert.equal(report.closedPositions[0]?.exitReason, 'stop_loss');
    assert.equal(report.closedPositions[0]?.exit?.legs.TP1?.state, 'failed');
    assert.equal(report.closedPositions[0]?.exit?.failedFeesLamports, '6000');
  } finally { db.close(); }
});

test('ordered replay cannot decide in the launch slot and a risk snapshot excludes later trades', () => {
  const db = new Ledger(':memory:');
  try {
    const engine = runner(db, 'timing', { ...policy, delayMs: { detection: 0, decision: 0, submission: 20, landing: 30 } });
    engine.accept({ ...launch, sourceTiming: 'confirmed_block', hydrationMs: 30, observedHeadSlot: launch.slot });
    engine.advance(launch.receivedAtMs + 100);
    assert.equal(db.journal('timing').filter(row => row.kind === 'decision').length, 0);
    const next = { ...earlyTrade, receivedAtMs: launch.receivedAtMs + 200, sourceTiming: 'confirmed_block' as const, hydrationMs: 40 };
    engine.accept(next);
    engine.advance(next.receivedAtMs + 40);
    engine.accept({ ...next, signature: 'later', slot: next.slot + 1, receivedAtMs: next.receivedAtMs + 100 });
    const decision = db.journal('timing').find(row => row.kind === 'decision')!;
    const data = decision.data as { receiptMs: number; result: string; decisionSlot: number; risk: RiskSnapshot };
    assert.equal(data.result, 'eligible');
    assert.ok(data.decisionSlot > launch.slot);
    assert.equal(decision.atMs - data.receiptMs, 240);
    assert.equal(data.risk.coverage.trades, 1);
    assert.equal(data.risk.coverage.lastTradeAvailableAtMs, next.receivedAtMs + 40);
    assert.equal(data.risk.features.distinctEarlyBuyers, 1);
    assert.equal(data.risk.owners.creatorHoldings, null);
    assert.equal(data.risk.coordination.directlySignedObservedBuyers, 1);
    assert.equal(exportExamples(db, 'timing').examples[0]?.tp1, null);
  } finally { db.close(); }
});

test('shallow model trains only on outcomes available before the split', () => {
  const hash = strategyFingerprint(policy);
  const features: RiskSnapshot['features'] = {
    priorLaunches: 0, maturedLaunches: 0, creatorReturnBps: null, distinctEarlyBuyers: null,
    roundTripLossBps: 10, holderConcentrationBps: null, entryImpactBps: null, exitImpactBps: null,
  };
  const rows = Array.from({ length: 50 }, (_, i): Example => ({
    mint: `fixture-${i}`, creator: 'verified', decisionAtMs: i < 40 ? i : 120 + i, labelAvailableAtMs: i < 40 ? i + 1 : 200 + i,
    tp1: i % 2 === 0, exitExecutable: true, netLamports: i % 2 === 0 ? '100' : '-200',
    features: { ...features, roundTripLossBps: i % 2 === 0 ? 10 : 30 },
  }));
  rows.push({ ...rows[0]!, labelAvailableAtMs: 100, tp1: false, netLamports: '-9000000' });
  const model = trainModel(rows, 100, hash)!;
  assert.equal(model.samples, 40);
  assert.equal(model.feature, 'roundTripLossBps');
  assert.equal(scoreModel(model, features, 99, hash).reason, 'training_window');
  assert.equal(scoreModel(model, { ...features, roundTripLossBps: null }, 101, hash).reason, 'missing_feature');
  assert.equal(evaluateModel(rows, model, hash).shadowAcceptedLabeledNetLamports, '500');
});

test('paper shadows a model veto while its replay variant can measure the veto', () => {
  const db = new Ledger(':memory:');
  try {
    const model = {
      schema: 1 as const, version: '0123456789abcdef', trainingDataHash: 'a'.repeat(64),
      settingsHash: strategyFingerprint(policy), trainedBeforeMs: launch.receivedAtMs - 1,
      feature: 'roundTripLossBps' as const, boundary: 0, leftBps: 0, rightBps: 0, approvalBps: 5000, samples: 30,
    };
    const paper = new PaperEngine({ id: 'shadow-paper', ledger: db, mode: 'paper', settings: policy, verifyCreator: identity,
      shadowModel: model, evaluateModelGate: true });
    paper.accept({ kind: 'feed', provider: launch.provider, healthy: true, receivedAtMs: launch.receivedAtMs });
    const counterfactual = new PaperEngine({ id: 'shadow-replay', ledger: db, mode: 'replay', settings: policy, verifyCreator: identity,
      shadowModel: model, evaluateModelGate: true });
    for (const event of tape) {
      paper.accept(event);
      counterfactual.accept(event);
    }
    assert.equal(buildReport(db, 'shadow-paper').orders.entry.filled, 1);
    const report = buildReport(db, 'shadow-replay');
    assert.equal(report.orders.entry.filled, 0);
    assert.equal(report.launches.rejectionReasons.shadow_model_counterfactual_veto, 1);
    assert.equal(report.launches.rejectionReasons['creator-signer-mismatch'], 1);
  } finally { db.close(); }
});

test('feed measurement joins finalized and alternate executed signatures, preserves gaps and does not count finality copies as duplicates', () => {
  const captured = { ...launch, sourceTiming: 'confirmed_block' as const, hydrationMs: 20 };
  const alternate = { ...launch, receivedAtMs: launch.receivedAtMs - 10, hydrationMs: 5 };
  const finalized = { ...launch, commitment: 'finalized' as const };
  const result = measureCapture([captured, captured, finalized], [finalized], {
    provider: 'test', firstSlot: launch.slot, lastSlot: launch.slot, blocksRead: 1, missingBlocks: [], omittedSlots: [],
    venueSupport: ['curve'], transactionsRead: 1, decodedEvents: 1, unknownReserveEvents: 0, decodeFailures: 0,
    noBlockTimeSlots: [], timing: 'block_time_only',
  }, 15, [alternate]);
  assert.equal(result.captured.duplicates, 1);
  assert.equal(result.captured.finalizedMatches, 1);
  assert.equal(result.captured.eligibleDataBeforeReceiptDeadline, 0);
  assert.equal(result.alternate?.laterArrivalAlternateMinusPrimaryMs.p50, -10);
  assert.equal(result.alternate?.alternateEligibleDataBeforeReceiptDeadline, 1);
});
