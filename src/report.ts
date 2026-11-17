import { SOL_MINT, type NormalizedEvent, type LaunchEvent } from './protocol-types.ts';
import { Ledger } from './ledger.ts';
import { PaperEngine, type IdentityVerdict, type Outcome, type PaperSettings, type PaperState } from './engine.ts';
import type { Model, Example } from './model.ts';
import { strategyFingerprint } from './model.ts';
import type { RiskSnapshot } from './risk.ts';
import { trackerAsOf, type TrackerSnapshot } from './tracker.ts';

export interface ReportOptions {
  fixedCostsLamports?: string;
  eurReference?: { eurCentsPerSol: string; observedAtMs: number; source: string };
  provenance?: string;
  historicalAllowlistVerified?: boolean;
}

type VerifyCreator = (launch: LaunchEvent, decisionAtMs: number, chainAtMs: number) => IdentityVerdict;
type Data = Record<string, unknown>;
type Side = 'buy' | 'sell';

export function formatSol(lamports: bigint): string {
  const negative = lamports < 0n;
  const absolute = negative ? -lamports : lamports;
  const whole = absolute / 1_000_000_000n;
  const decimal = String(absolute % 1_000_000_000n).padStart(9, '0');
  return `${negative ? '-' : ''}${whole}.${decimal}`;
}

export function summarizeLatency(values: number[]) {
  values.sort((left, right) => left - right);
  const quantile = (percentile: number) => values[Math.ceil(values.length * percentile) - 1] ?? null;
  return { samples: values.length, median: quantile(0.5), p50: quantile(0.5),
    p95: values.length >= 20 ? quantile(0.95) : null, p99: values.length >= 100 ? quantile(0.99) : null, max: quantile(1) };
}

function fraction(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

function grouped(outcomes: Outcome[], group: (value: Outcome) => string) {
  const totals = new Map<string, { net: bigint; trades: number }>();
  for (const outcome of outcomes) {
    const key = group(outcome);
    const total = totals.get(key) ?? { net: 0n, trades: 0 };
    total.net += BigInt(outcome.pnlLamports);
    total.trades++;
    totals.set(key, total);
  }
  return [...totals.entries()].sort(([left], [right]) => left < right ? -1 : left === right ? 0 : 1);
}

function uncertainty(outcomes: Outcome[]) {
  // Day clusters keep correlated exits together. The deterministic seed makes reports replayable.
  const days = grouped(outcomes, (outcome) => String(Math.floor(outcome.realizedAtMs / 86_400_000))).map(([, day]) => day);
  if (days.length < 10 || outcomes.length < 30) return { method: 'day_cluster_bootstrap', clusters: days.length, interval: null };
  let seed = 4_751;
  const sample = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return days[seed % days.length]!;
  };
  const distribution: bigint[] = [];
  for (let replicate = 0; replicate < 1_000; replicate++) {
    let net = 0n;
    let trades = 0;
    for (let i = 0; i < days.length; i++) {
      const day = sample();
      net += day.net;
      trades += day.trades;
    }
    distribution.push(net / BigInt(trades));
  }
  distribution.sort((left, right) => left < right ? -1 : left === right ? 0 : 1);
  return {
    method: 'day_cluster_bootstrap', clusters: days.length,
    interval: { meanClosedTradeLamportsLow: String(distribution[24]), meanClosedTradeLamportsHigh: String(distribution[974]) },
  };
}

export function buildReport(ledger: Ledger, id: string, options: ReportOptions = {}) {
  const { state, settings, mode } = ledger.run<PaperState>(id);
  const config = settings as PaperSettings;
  const journal = ledger.journal(id);
  const events = ledger.events<NormalizedEvent>(id);
  if (mode !== 'paper' && mode !== 'replay') throw new Error(`Run ${id} does not contain paper fills`);
  const launches = journal.filter(({ kind }) => kind === 'launch');
  const decisions = journal.filter(({ kind }) => kind === 'decision');
  const eligible = decisions.filter(({ data }) => (data as Data).result === 'eligible');
  const compatibleLaunches = launches.filter(({ data }) => {
    const item = data as Data;
    return item.supported === true && item.quoteMint === SOL_MINT;
  });
  const entries: number[] = [];
  const exits: number[] = [];
  const failures = { buy: 0n, sell: 0n };
  let venueFees = 0n;
  let executionFees = 0n;
  const exitTriggers = new Map<string, number>();
  const receipts = new Map(launches.map((value) => [value.mint, Number((value.data as Data).receiptMs)]));
  const results = Object.fromEntries((['buy', 'sell'] as const).map((side) => [side, {
    intents: 0, submitted: 0, filled: 0, failed: 0, missed: 0,
  }])) as Record<Side, { intents: number; submitted: number; filled: number; failed: number; missed: number }>;
  const reasons: Record<string, number> = Object.create(null);
  const feeds: Record<string, number> = Object.create(null);
  let peak = BigInt(config.startingLamports);
  let drawdown = 0n;
  let drawdownBps = 0;
  let maximumDrawdown = 0n;
  for (const { kind, data, mint, atMs } of journal) {
    const row = data as Data;
    const side = row.side as Side;
    if (kind === 'intent') results[side].intents++;
    if (kind === 'attempt') results[side].submitted++;
    if (kind === 'exit_trigger' && mint) exitTriggers.set(mint, atMs);
    if (kind === 'fill') {
      venueFees += BigInt(String(row.venueFeeLamports ?? '0'));
      executionFees += ['networkFeeLamports', 'priorityFeeLamports', 'tipLamports']
        .reduce((total, field) => total + BigInt(String(row[field] ?? '0')), 0n);
      if (side === 'buy') entries.push(atMs - (receipts.get(mint) ?? atMs));
      else exits.push(atMs - (exitTriggers.get(mint ?? '') ?? atMs));
    }
    if (kind === 'result') {
      const status = row.status as 'filled' | 'failed' | 'missed';
      results[side][status]++;
      if (status === 'failed') failures[side] += BigInt(String(row.feeLamports));
    }
    if (kind === 'decision' && row.result === 'rejected') {
      const reason = String(row.reason);
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    if (kind === 'feed' && row.healthy === false) {
      const reason = String(row.reason ?? 'unknown');
      feeds[reason] = (feeds[reason] ?? 0) + 1;
    }
    if (kind === 'equity') {
      const value = BigInt(String(row.equityLamports));
      if (value > peak) peak = value;
      drawdown = peak - value;
      if (drawdown > maximumDrawdown) maximumDrawdown = drawdown;
      if (peak > 0n) drawdownBps = Math.max(drawdownBps, Number(drawdown * 10_000n / peak));
    }
  }
  let grossProfit = 0n;
  let grossLoss = failures.buy;
  let bestTrade: bigint | undefined;
  for (const outcome of state.outcomes) {
    const pnl = BigInt(outcome.pnlLamports);
    if (pnl > 0n) grossProfit += pnl;
    else grossLoss -= pnl;
    if (bestTrade === undefined || pnl > bestTrade) bestTrade = pnl;
  }
  let openPartialRealized = 0n;
  for (const position of Object.values(state.positions)) {
    if (!position.exit) continue;
    const original = BigInt(position.exit.originalTokens);
    const sold = original - BigInt(position.tokens);
    const allocatedEntry = BigInt(position.exit.entryCostLamports) * sold / original;
    openPartialRealized += BigInt(position.exit.saleProceedsLamports) - allocatedEntry;
  }
  if (openPartialRealized > 0n) grossProfit += openPartialRealized;
  else grossLoss -= openPartialRealized;
  const outstandingSellFees = journal.reduce((total, { kind, mint, data }) => {
    const value = data as Data;
    if (kind !== 'result' || value.side !== 'sell' || value.status !== 'failed' || !mint || !state.positions[mint]) return total;
    return total + BigInt(String(value.feeLamports));
  }, 0n);
  grossLoss += outstandingSellFees;
  const realized = grossProfit - grossLoss;
  const creators = grouped(state.outcomes, (trade) => trade.creator);
  const bestCreator = creators.reduce<bigint | undefined>((best, [, group]) =>
    best === undefined || group.net > best ? group.net : best, undefined);
  const controls = state.outcomes.reduce((total, outcome) => total + BigInt(outcome.costLamports), 0n);
  const trades = state.outcomes.length;
  const interval = uncertainty(state.outcomes);
  const hydration = events.flatMap((event) => event.kind !== 'feed' && event.hydrationMs !== undefined ? [event.hydrationMs] : []);
  const slots = events.flatMap((event) => event.slot === undefined ? [] : [event.slot]);
  const optionsCosts = options.fixedCostsLamports === undefined ? null : BigInt(options.fixedCostsLamports);
  const reference = options.eurReference;
  const orderStats = (side: Side) => {
    const record = results[side];
    return {
      ...record, submissionRate: fraction(record.submitted, record.intents), fillRate: fraction(record.filled, record.submitted),
      failureRate: fraction(record.failed, record.submitted), pending: Object.values(state.orders).filter((order) => order.side === side).length,
    };
  };
  const opens = Object.values(state.positions).map((position) => ({
    ...position, unresolved: position.unresolved ?? (position.trigger || position.exit?.terminal ? 'trigger_pending' : 'open_at_cutoff'),
  }));
  const ready = eligible.map(row => ({ ...row, data: row.data as Data })).filter(({ data }) =>
    typeof data.receiptMs === 'number' && typeof data.decisionAtMs === 'number');
  const decisionTimings = Object.fromEntries([...new Set(ready.map(({ data }) => String(data.sourceTiming ?? 'unspecified')))]
    .map(timing => [timing, summarizeLatency(ready.filter(({ data }) => String(data.sourceTiming ?? 'unspecified') === timing)
      .map(({ data, atMs }) => atMs - Number(data.receiptMs)))]));
  const enrichment = ledger.enrichments<TrackerSnapshot>(id);
  const cutoffs = new Map(decisions.map(row => [row.mint, row.atMs]));
  return {
    schema: 1, runId: id, mode, settings,
    execution: 'counterfactual_paper',
    timing: mode === 'replay' ? 'tape_receipts_or_modeled_receipt_times_plus_configured_latency' : 'local_provider_receipts_plus_configured_latency',
    exploratory: mode === 'replay' && !options.historicalAllowlistVerified,
    provenance: options.provenance ?? null,
    verdict: 'inconclusive',
    verdictReason: interval.interval === null ? 'insufficient_independent_day_clusters_or_closed_positions' : 'single_run_does_not_establish_a_creator_filter_effect',
    coverage: {
      firstReceiptMs: events[0]?.receivedAtMs ?? null, lastReceiptMs: events.at(-1)?.receivedAtMs ?? null,
      slotRange: slots.length ? slots.reduce<[number, number]>(([low, high], slot) => [Math.min(low, slot), Math.max(high, slot)],
        [Infinity, -Infinity]) : null,
      providers: [...new Set(events.map(({ provider }) => provider))].sort(),
      markets: { curve: true, canonicalPumpSwap: true, quote: 'SOL' },
      normalizedEvents: events.length, duplicateEvents: journal.filter(({ kind }) => kind === 'duplicate').length,
      lateEvents: events.filter((event) => event.kind !== 'feed' && event.late).length,
      feedIncidents: feeds, unknownMarketEvents: journal.filter(({ kind }) => kind === 'market_unknown').length,
      reorderedMarketEvents: journal.filter(({ kind }) => kind === 'market_reordered').length,
      rollbacks: journal.filter(({ kind, data }) => kind === 'finality' && (data as Data).status === 'rolled_back').length,
      forkTaintedClosedPositions: journal.filter(({ kind }) => kind === 'fork_tainted_outcome').map(({ mint }) => mint),
    },
    launches: {
      observed: launches.length, compatible: compatibleLaunches.length, evaluated: decisions.length, eligible: eligible.length,
      unresolvedDecisionAtCutoff: Object.keys(state.candidates).length, rejectionReasons: reasons,
    },
    orders: { entry: orderStats('buy'), exit: orderStats('sell') },
    latencyMs: { hydration: summarizeLatency(hydration), scheduledReceiptToEligibleDecisionBySource: decisionTimings,
      measuredReceiptToEligibleDecision: summarizeLatency(ready.flatMap(({ data }) =>
        typeof data.processedAtMs === 'number' ? [data.processedAtMs - Number(data.receiptMs)] : [])),
      scheduledDecisionToProcessing: summarizeLatency(ready.flatMap(({ data }) =>
        typeof data.processedAtMs === 'number' ? [data.processedAtMs - Number(data.decisionAtMs)] : [])),
      entry: summarizeLatency(entries), exit: summarizeLatency(exits) },
    decisionSlots: {
      sameSlot: ready.filter(({ data }) => data.launchSlot === data.decisionSlot).length,
      laterSlot: ready.filter(({ data }) => Number(data.decisionSlot) > Number(data.launchSlot)).length,
    },
    tracker: {
      responses: enrichment.length, successful: enrichment.filter(row => row.status === 'ok').length,
      inTimeAndFresh: enrichment.filter(row => cutoffs.has(row.mint) && trackerAsOf(row, cutoffs.get(row.mint)!, 15000).eligible).length,
      fetchLatencyMs: summarizeLatency(enrichment.map(row => row.fetchedAtMs - row.startedAtMs)),
    },
    fees: { venueLamports: String(venueFees), executionLamports: String(executionFees), failedLamports: String(failures.buy + failures.sell) },
    returns: {
      realizedNetLamports: String(realized), realizedNetSol: formatSol(realized), cashLamports: state.balanceLamports,
      markedEquityLamports: state.equityLamports, markedEquitySol: formatSol(BigInt(state.equityLamports)),
      perEligibleLaunchLamports: eligible.length ? String(realized / BigInt(eligible.length)) : null,
      perCompatibleLaunchLamports: compatibleLaunches.length ? String(realized / BigInt(compatibleLaunches.length)) : null,
      perClosedTradeLamports: trades ? String(realized / BigInt(trades)) : null,
      perFilledEntryLamports: results.buy.filled ? String(realized / BigInt(results.buy.filled)) : null,
      closedCostBasisLamports: String(controls),
      maxDrawdownLamports: String(maximumDrawdown), maxDrawdownBps: drawdownBps,
      grossProfitLamports: String(grossProfit), grossLossLamports: String(grossLoss),
      profitFactor: grossLoss ? Number(grossProfit * 10_000n / grossLoss) / 10_000 : null,
      failedTransactionFeesLamports: String(failures.buy + failures.sell),
      openPositionsPartialRealizedLamportsBeforeFailedFees: String(openPartialRealized),
      withoutBestTradeLamports: String(realized - (bestTrade ?? 0n)),
      withoutBestCreatorLamports: String(realized - (bestCreator ?? 0n)),
      fixedCostsLamports: options.fixedCostsLamports ?? null,
      lessFixedCostsLamports: optionsCosts === null ? null : String(realized - optionsCosts),
      eur: reference ? { ...reference, realizedNetCents: String(realized * BigInt(reference.eurCentsPerSol) / 1_000_000_000n) } : null,
    },
    creatorConcentration: creators.map(([creator, value]) => ({
      creator, closedTrades: value.trades, closedTradeShare: fraction(value.trades, trades), netLamports: String(value.net),
    })),
    uncertainty: interval, openPositions: opens, pendingOrders: Object.values(state.orders), closedPositions: state.outcomes,
  };
}

export function exportExamples(ledger: Ledger, id: string) {
  const { state, settings } = ledger.run<PaperState>(id);
  const journal = ledger.journal(id);
  const outcomes = new Map(state.outcomes.map(outcome => [outcome.mint, outcome]));
  const entrants = new Set(state.entered);
  const forkTainted = new Set(journal.filter(row => row.kind === 'fork_tainted_outcome').map(row => row.mint));
  const missed = new Map(journal.filter(row => row.kind === 'result' && (row.data as Data).side === 'buy' &&
    (row.data as Data).status !== 'filled').map(row => [row.mint, row]));
  const examples: Example[] = [];
  for (const row of journal) {
    if (row.kind !== 'decision' || !row.mint) continue;
    const data = row.data as Data;
    const risk = data.risk as RiskSnapshot | undefined;
    if (!risk || !(data.identity as IdentityVerdict | undefined)?.eligible || data.result !== 'eligible') continue;
    if (risk.cutoffMs !== row.atMs || risk.coverage.lastTradeAvailableAtMs !== null && risk.coverage.lastTradeAvailableAtMs > row.atMs) {
      throw new Error('Decision has a feature beyond its timestamp');
    }
    const outcome = outcomes.get(row.mint);
    const failure = missed.get(row.mint);
    const tainted = forkTainted.has(row.mint) || state.launches[row.mint]?.rolledBack;
    const resolvedAt = tainted ? null : outcome?.realizedAtMs ?? failure?.atMs ?? null;
    const achieved = !!outcome && (outcome.exit?.legs.TP1?.state === 'filled' || outcome.exitReason === 'take_profit');
    examples.push({ mint: row.mint, creator: String(data.creator), decisionAtMs: row.atMs, labelAvailableAtMs: resolvedAt,
      tp1: resolvedAt === null ? null : achieved, exitExecutable: resolvedAt === null ? null : entrants.has(row.mint),
      netLamports: resolvedAt === null ? null : outcome?.pnlLamports ?? String(-BigInt(String((failure?.data as Data)?.feeLamports ?? '0'))),
      features: risk.features });
  }
  return { schema: 1, settingsHash: strategyFingerprint(settings), settings,
    sourceRunId: id, examples, unresolvedLabels: examples.filter(row => row.labelAvailableAtMs === null).length };
}

export function buildComparison(
  events: readonly NormalizedEvent[],
  settings: PaperSettings,
  verifyCreator: VerifyCreator,
  options: ReportOptions & { evaluationStartMs?: number; evaluationEndMs?: number } = {},
  model?: Model,
) {
  const { minCreatorHistorySamples, minCreatorHistoryCoverageBps, minCreatorHistoryReturnBps, minCreatorInitialBuyLamports,
    maxConcentrationBps, riskPolicy, exits, ...single } = settings;
  const base = { ...single, exits };
  const start = options.evaluationStartMs ?? 0;
  const end = options.evaluationEndMs ?? Infinity;
  if (start > end) throw new Error('Evaluation window is inverted');
  // Feed preceding venue state for context without using it to fill or train.
  const tape = events.filter(event => {
    const hydration = event.kind !== 'feed' && (event.sourceTiming === 'confirmed_block' || event.sourceTiming === 'executed_transaction')
      ? event.hydrationMs ?? 0 : 0;
    return event.receivedAtMs + hydration <= end;
  });
  const baseline: VerifyCreator = (launch) => launch.receivedAtMs < start
    ? { eligible: false, reason: 'pre_evaluation_window' } : { eligible: true, reason: 'frozen_baseline' };
  const verified: VerifyCreator = (launch, atMs, chainAtMs) => launch.receivedAtMs < start
    ? { eligible: false, reason: 'pre_evaluation_window' } : verifyCreator(launch, atMs, chainAtMs);
  const ledger = new Ledger(':memory:');
  const run = (id: string, config: PaperSettings, identity: VerifyCreator = verified, creatorHistory?: readonly Outcome[], gate = false) => {
    const engine = new PaperEngine({ ledger, id, mode: 'replay', settings: config, verifyCreator: identity, verifyHistory: verifyCreator, creatorHistory,
      shadowModel: model, evaluateModelGate: gate });
    for (const event of tape) engine.accept(event);
    engine.finish();
    return buildReport(ledger, id, options);
  };
  try {
    const reference = run('baseline', base, baseline);
    const creator = run('verified_creator', base);
    const riskSettings = { ...base, riskPolicy: riskPolicy ?? { version: 'comparison-v1', maxRoundTripLossBps: 1000 } };
    const risk = run('verified_creator_with_risk', riskSettings);
    const holdout: VerifyCreator = (launch, decision, chain) => !model || decision < model.trainedBeforeMs
      ? { eligible: false, reason: 'outside_model_holdout' } : verified(launch, decision, chain);
    const shadow = model && strategyFingerprint(base) === model.settingsHash ? {
      baseline: run('shadow_holdout_creator', base, holdout),
      deterministicRisk: run('shadow_holdout_risk', riskSettings, holdout),
      selected: run('shadow_holdout_selected', base, holdout, undefined, true),
    } : null;
    const singleExit = exits ? run('single_exit', single) : null;
    const exactEntries = (id: string) => new Map(ledger.journal(id)
      .filter(row => row.kind === 'fill' && (row.data as Data).side === 'buy')
      .map(row => [row.mint, JSON.stringify([row.atMs, row.data])]));
    const ladderEntries = exits ? exactEntries('verified_creator') : new Map();
    const singleEntries = exits ? exactEntries('single_exit') : new Map();
    const matched = new Set([...ladderEntries].filter(([mint, value]) => singleEntries.get(mint) === value).map(([mint]) => mint));
    const sumMatched = (rows: Outcome[]) => String(rows.filter(row => matched.has(row.mint)).reduce((sum, row) => sum + BigInt(row.pnlLamports), 0n));
    const history = { minCreatorHistorySamples, minCreatorHistoryCoverageBps, minCreatorHistoryReturnBps };
    const historyEnabled = Object.values(history).some((value) => value !== undefined);
    const prior = historyEnabled
      ? start > 0
        ? run('history_observations', base, () => ({ eligible: true, reason: 'independent_baseline_observation' })).closedPositions
        : reference.closedPositions
      : undefined;
    const variants = [
      ...(historyEnabled ? [run('creator_history', { ...base, ...history }, verified, prior)] : []),
      ...(minCreatorInitialBuyLamports === undefined ? [] : [run('creator_initial_buy', { ...base, minCreatorInitialBuyLamports })]),
      ...(maxConcentrationBps === undefined ? [] : [run('holder_concentration', { ...base, maxConcentrationBps })]),
    ];
    const scenarios: [string, PaperSettings][] = [
      ['slower_landing', { ...base, delayMs: { ...base.delayMs, landing: Math.max(1_000, base.delayMs.landing * 2) } }],
      ['higher_execution_fees', { ...base, priorityFeeLamports: String(BigInt(base.priorityFeeLamports) * 2n + 5_000n) }],
      ['stricter_exit_impact', { ...base, exitImpactBps: Math.max(1, Math.floor(base.exitImpactBps / 2)) }],
      ['smaller_size', { ...base, spendLamports: String(BigInt(base.spendLamports) / 2n || 1n) }],
      ['larger_size', { ...base, spendLamports: String(BigInt(base.spendLamports) * 2n) }],
    ];
    const sensitivities = scenarios.map(([name, config]) => {
      const reference = run(`${name}_baseline`, config, baseline);
      const creator = run(name, config);
      return { ...creator, baseline: {
        realizedNetLamports: reference.returns.realizedNetLamports, markedEquityLamports: reference.returns.markedEquityLamports,
        entryFills: reference.orders.entry.filled, exitFills: reference.orders.exit.filled,
        openPositions: reference.openPositions.length,
      }, realizedCreatorMinusBaselineLamports: String(BigInt(creator.returns.realizedNetLamports) - BigInt(reference.returns.realizedNetLamports)) };
    });
    return {
      schema: 1, execution: 'counterfactual_paper', evaluationStartMs: start, evaluationEndMs: Number.isFinite(end) ? end : null,
      verdict: 'inconclusive', verdictReason: 'comparison_is_descriptive_and_does_not_establish_a_creator_filter_effect',
      realizedCreatorMinusBaselineLamports: String(BigInt(creator.returns.realizedNetLamports) - BigInt(reference.returns.realizedNetLamports)),
      baseline: reference, verifiedCreator: creator, creatorPlusRisk: risk, shadow, variants, sensitivities,
      shadowStatus: !model ? 'no_trained_model' : shadow ? 'holdout_replay' : 'different_frozen_settings',
      commonCohort: {
        verifiedCreatorEligibleLaunches: creator.launches.eligible,
        creatorNetLamportsPerBaselineEligibleLaunch: creator.returns.perEligibleLaunchLamports,
        riskNetLamportsPerBaselineEligibleLaunch: creator.launches.eligible
          ? String(BigInt(risk.returns.realizedNetLamports) / BigInt(creator.launches.eligible)) : null,
      },
      timingComparison: {
        immediateConfiguredExtraDelayMs: 0, delayedConfiguredExtraDelayMs: 1000,
        immediate: run('earliest_eligible_decision', { ...base, delayMs: { ...base.delayMs, decision: 0 } }),
        delayed: run('delayed_decision', { ...base, delayMs: { ...base.delayMs, decision: 1000 } }),
      },
      exitComparison: singleExit && {
        singleExit, matchingEntries: matched.size, ladderEntries: ladderEntries.size, singleEntries: singleEntries.size,
        matchedLadderClosedNetLamports: sumMatched(creator.closedPositions),
        matchedSingleClosedNetLamports: sumMatched(singleExit.closedPositions),
        matchedLadderOpen: creator.openPositions.filter(row => matched.has(row.mint)).length,
        matchedSingleOpen: singleExit.openPositions.filter(row => matched.has(row.mint)).length,
      },
    };
  } finally {
    ledger.close();
  }
}
