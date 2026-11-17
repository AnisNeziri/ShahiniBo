import type { LaunchEvent, OwnerBalance, Reserves, TradeEvent } from './protocol-types.ts';

export type BalanceEvidence = OwnerBalance & { availableAtMs: number; signature: string };

export interface RiskPolicy {
  version: string;
  maxRoundTripLossBps?: number;
  minDistinctBuyers?: number;
  maxHolderConcentrationBps?: number;
}

export interface EarlyTrade {
  atMs: number;
  slot: number;
  signature: string;
  provider: string;
  wallet: string | null;
  signer: boolean | null;
  side: 'buy' | 'sell';
  tokens: string | null;
  sol: string | null;
}

function publicAmount(value: string | undefined): string | null {
  return value !== undefined && /^\d{1,20}$/.test(value) ? value : null;
}

export function earlyTrade(event: TradeEvent, availableAtMs: number): EarlyTrade | undefined {
  if (event.side === 'update') return;
  return {
    atMs: availableAtMs, slot: event.slot, signature: event.signature, provider: event.provider,
    wallet: event.trader && event.trader !== event.venueAccount ? event.trader : null,
    signer: event.signers && event.trader ? event.signers.includes(event.trader) : null,
    side: event.side, tokens: publicAmount(event.tokenAmount), sol: publicAmount(event.quoteAmount),
  };
}

type History = {
  priorLaunches: number; maturedLaunches: number; sampleSize: number;
  returnBps: number | null; creatorInitialBuyLamports: string | null;
};

export interface OpportunityQuote {
  reserves: Reserves;
  quoteReceiptMs: number;
  quoteSlot: number;
  provider: string;
  entryNetLamports: string;
  exitNetLamports: string | null;
  entryImpactBps: number;
  exitImpactBps: number | null;
}

export function opportunity(args: {
  launch: LaunchEvent; cutoffMs: number; cutoffSlot: number | null; trades: readonly EarlyTrade[];
  balances: readonly BalanceEvidence[];
  tapeIncomplete: boolean; history: History; quote: OpportunityQuote | null; quoteError: string | null; policy?: RiskPolicy;
}) {
  const { launch, cutoffMs, cutoffSlot, history, quote, quoteError, policy, tapeIncomplete } = args;
  const trades = args.trades.filter(trade => trade.atMs <= cutoffMs && (cutoffSlot === null || trade.slot <= cutoffSlot));
  const buyers = new Set<string>();
  const signerWallets = new Set<string>();
  const slotBuyers = new Map<number, Set<string>>();
  const positions = new Map<string, bigint>();
  let flow = 0n;
  let flowKnown = 0;
  let creatorSell = 0n;
  let creatorSellCount = 0;
  let attributed = 0;
  for (const trade of trades) {
    const sign = trade.side === 'buy' ? 1n : -1n;
    if (trade.sol !== null) {
      flow += sign * BigInt(trade.sol);
      flowKnown++;
    }
    if (!trade.wallet || trade.wallet === launch.bondingCurve) continue;
    if (trade.side === 'buy') {
      buyers.add(trade.wallet);
      const peers = slotBuyers.get(trade.slot) ?? new Set<string>();
      peers.add(trade.wallet);
      slotBuyers.set(trade.slot, peers);
      if (trade.signer) signerWallets.add(trade.wallet);
    } else if (trade.wallet === launch.creator && trade.sol !== null) {
      creatorSell += BigInt(trade.sol);
      creatorSellCount++;
    }
    if (trade.tokens !== null) {
      attributed++;
      positions.set(trade.wallet, (positions.get(trade.wallet) ?? 0n) + sign * BigInt(trade.tokens));
    }
  }
  const observedHoldings = [...positions.values()].filter(value => value > 0n);
  const total = observedHoldings.reduce((a, b) => a + b, 0n);
  const top = observedHoldings.reduce((a, b) => a > b ? a : b, 0n);
  const roundTrip = quote?.exitNetLamports == null ? null :
    Number((BigInt(quote.entryNetLamports) - BigInt(quote.exitNetLamports)) * 10_000n / BigInt(quote.entryNetLamports));
  const concentration = launch.concentrationBps ?? null;
  const observedAccounts = new Map<string, BalanceEvidence>();
  for (const row of args.balances) {
    if (row.availableAtMs <= cutoffMs && row.owner !== launch.bondingCurve) observedAccounts.set(row.account, row);
  }
  const observedByOwner = new Map<string, bigint>();
  for (const row of observedAccounts.values()) {
    observedByOwner.set(row.owner, (observedByOwner.get(row.owner) ?? 0n) + BigInt(row.amount));
  }
  const features = {
    priorLaunches: history.priorLaunches, maturedLaunches: history.maturedLaunches, creatorReturnBps: history.returnBps,
    distinctEarlyBuyers: !tapeIncomplete && trades.length && trades.every(trade => trade.side === 'sell' || trade.wallet) ? buyers.size : null,
    roundTripLossBps: roundTrip, holderConcentrationBps: concentration,
    entryImpactBps: quote?.entryImpactBps ?? null, exitImpactBps: quote?.exitImpactBps ?? null,
  };
  const reasons: string[] = [];
  if (policy?.maxRoundTripLossBps !== undefined && (roundTrip === null || roundTrip > policy.maxRoundTripLossBps)) {
    reasons.push(roundTrip === null ? 'round_trip_loss_unknown' : 'round_trip_loss_limit');
  }
  if (policy?.minDistinctBuyers !== undefined &&
      (features.distinctEarlyBuyers === null || features.distinctEarlyBuyers < policy.minDistinctBuyers)) {
    reasons.push(features.distinctEarlyBuyers === null ? 'buyer_count_unknown' : 'buyer_count_limit');
  }
  if (policy?.maxHolderConcentrationBps !== undefined && (concentration === null || concentration > policy.maxHolderConcentrationBps)) {
    reasons.push(concentration === null ? 'holder_concentration_unknown' : 'holder_concentration_limit');
  }
  return {
    schema: 1, ruleVersion: policy?.version ?? 'observe-v1', cutoffMs, cutoffSlot,
    launchSlot: launch.slot, launchSignature: launch.signature, launchReceiptMs: launch.receivedAtMs,
    providers: [...new Set([launch.provider, ...trades.map(trade => trade.provider), ...(quote ? [quote.provider] : [])])].sort(),
    history, features, quote, quoteAgeMs: quote ? cutoffMs - quote.quoteReceiptMs : null,
    quoteError, adjustments: reasons, approved: !reasons.length,
    flow: { netObservedLamports: flowKnown ? String(flow) : null, knownTradeCount: flowKnown },
    owners: {
      creatorHoldings: null, creatorNetTradedTokens: positions.has(launch.creator) ? String(positions.get(launch.creator)) : null,
      creatorLastObservedAccountTokens: observedByOwner.has(launch.creator) ? String(observedByOwner.get(launch.creator)) : null,
      touchedAccountsBasis: 'last_seen_post_transaction_balances_excludes_known_vaults_not_total_holdings',
      lastObservedAccountBalancesByOwner: [...observedByOwner].sort(([a], [b]) => a.localeCompare(b))
        .map(([wallet, tokens]) => ({ wallet, tokens: String(tokens) })),
      lastAccountObservationMs: args.balances.filter(row => row.availableAtMs <= cutoffMs).at(-1)?.availableAtMs ?? null,
      creatorSellCount, creatorSellObservedLamports: creatorSellCount ? String(creatorSell) : null,
      traderNetHoldingsBasis: 'observed_trades_excludes_unseen_transfers',
      observedNetTokenBalances: [...positions].sort(([a], [b]) => a.localeCompare(b)).map(([wallet, tokens]) => ({ wallet, tokens: String(tokens) })),
      observedTopShareBps: total ? Number(top * 10_000n / total) : null,
    },
    coordination: {
      directlySignedObservedBuyers: trades.some(trade => trade.signer !== null) ? signerWallets.size : null,
      bundleEvidence: null,
      maxDistinctBuyersInOneSlot: slotBuyers.size ? Math.max(...Array.from(slotBuyers.values(), peers => peers.size)) : null,
    },
    coverage: { incomplete: tapeIncomplete, trades: trades.length, attributed, identityIncludedInHardRule: true,
      firstTradeAvailableAtMs: trades[0]?.atMs ?? null, lastTradeAvailableAtMs: trades.at(-1)?.atMs ?? null },
  };
}

export type RiskSnapshot = ReturnType<typeof opportunity>;
export type Feature = keyof RiskSnapshot['features'];
