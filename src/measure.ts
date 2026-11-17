import type { ImportManifest } from './feed.ts';
import type { LaunchEvent, NormalizedEvent, StatusEvent } from './protocol-types.ts';
import { summarizeLatency } from './report.ts';

function launches(rows: readonly NormalizedEvent[], min: number, max: number) {
  return rows.filter((row): row is LaunchEvent => row.kind === 'launch' &&
    (row.commitment === 'confirmed' || row.commitment === 'finalized') && row.slot >= min && row.slot <= max);
}

function key(launch: LaunchEvent) { return `${launch.signature}:${launch.mint}`; }
function distinct(rows: LaunchEvent[]) {
  const map = new Map<string, LaunchEvent>();
  for (const row of rows) if (!map.has(key(row))) map.set(key(row), row);
  return map;
}

export function measureCapture(rows: readonly NormalizedEvent[], reference: readonly NormalizedEvent[],
  manifest: ImportManifest, deadlineMs: number, alternate?: readonly NormalizedEvent[]) {
  const { firstSlot, lastSlot } = manifest;
  const expected = distinct(launches(reference, firstSlot, lastSlot).filter(row => row.commitment === 'finalized'));
  const events = launches(rows, firstSlot, lastSlot);
  const primary = distinct(events);
  const withinRange = rows.filter(row => row.slot !== undefined && row.slot >= firstSlot && row.slot <= lastSlot);
  const rolled = new Set(withinRange.filter((row): row is StatusEvent => row.kind === 'status' && row.commitment === 'rolled_back')
    .map(row => `${row.signature}:${row.blockhash ?? ''}`));
  const matched = [...primary.entries()].filter(([id, row]) => expected.has(id) &&
    !rolled.has(`${row.signature}:${row.blockhash ?? ''}`)).map(([, row]) => row);
  const hydration = matched.filter(row => row.sourceTiming !== 'historical_block' && row.hydrationMs !== undefined);
  const healthy = withinRange.filter(row => row.kind === 'feed' && !row.healthy);
  const usable = (row: LaunchEvent) => row.sourceTiming !== 'historical_block' && row.sourceTiming !== 'transaction_sampler' &&
    !row.late && row.supported && row.hydrationMs !== undefined && row.hydrationMs <= deadlineMs;
  const summary = {
    reference: { slots: [firstSlot, lastSlot], blocksRead: manifest.blocksRead, expectedLaunches: expected.size,
      missingBlocks: manifest.missingBlocks, omittedSlots: manifest.omittedSlots, decodeFailures: manifest.decodeFailures },
    captured: {
      uniqueLaunches: primary.size, finalizedMatches: matched.length, missingLaunches: expected.size - matched.length,
      unmatchedLaunches: primary.size - matched.length,
      duplicates: events.length - new Set(events.map(row => [key(row), row.commitment, row.blockhash].join(':'))).size,
      lateLaunches: matched.filter(row => row.late).length, rolledBackEvents: rolled.size,
      decodeGapSignals: healthy.filter(row => row.kind === 'feed' && /decode/.test(row.reason ?? '')).length,
      reconnectSignals: healthy.filter(row => row.kind === 'feed' && /reconnect|recover/.test(row.reason ?? '')).length,
      recoveredLaunches: matched.filter(row => row.late && row.hydrationMs === undefined).length,
      missingObservedSignatures: [...expected.keys()].filter(id => !matched.some(row => key(row) === id)),
      receiptToHydratedMs: summarizeLatency(hydration.map(row => row.hydrationMs!)),
      eligibleDataBeforeReceiptDeadline: matched.filter(usable).length,
    },
    deadlineMs,
  };
  if (!alternate) return { ...summary, alternate: null };
  const other = distinct(launches(alternate, firstSlot, lastSlot));
  const selected = matched.flatMap(row => {
    const secondary = other.get(key(row));
    return secondary && expected.has(key(secondary)) &&
      row.sourceTiming !== 'historical_block' && secondary.sourceTiming !== 'historical_block'
      ? [{ primary: row, secondary }] : [];
  });
  return {
    ...summary,
    alternate: {
      uniqueLaunches: other.size, finalizedMatches: [...other.keys()].filter(id => expected.has(id)).length,
      pairedLaunches: selected.length,
      laterArrivalAlternateMinusPrimaryMs: summarizeLatency(selected.map(({ primary, secondary }) =>
        secondary.receivedAtMs - primary.receivedAtMs)),
      bothHaveHydrationMeasurement: selected.filter(({ primary, secondary }) =>
        primary.hydrationMs !== undefined && secondary.hydrationMs !== undefined).length,
      alternateEligibleDataBeforeReceiptDeadline: [...other.values()].filter(row => expected.has(key(row)) && usable(row)).length,
      requiresSynchronizedReceiptClocks: true,
    },
  };
}
