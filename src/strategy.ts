import type { Reserves } from './protocol-types.ts';

const BPS = 10_000n;

export interface QuoteLimits {
  impactBps: number;
  maxVenueFeeBps: number;
  executionFee: bigint;
}

export type Quote =
  | { ok: false; reason: string }
  | { ok: true; tokens: bigint; grossSol: bigint; venueFee: bigint; netSol: bigint; impactBps: number };

function ceil(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function reserveValues(reserves: Reserves | undefined, maxVenueFeeBps: number) {
  if (!reserves || reserves.complete || reserves.feeBps === undefined ||
      !Number.isInteger(reserves.feeBps) || reserves.feeBps < 0 || reserves.feeBps > maxVenueFeeBps) return;
  const values = [reserves.virtualToken, reserves.virtualSol, reserves.realToken, reserves.realSol];
  if (values.some((value) => !/^\d+$/.test(value))) return;
  const [token, sol, realToken, realSol] = values.map(BigInt) as [bigint, bigint, bigint, bigint];
  if (token <= 0n || sol <= 0n) return;
  return { token, sol, realToken, realSol, feeBps: BigInt(reserves.feeBps) };
}

export function quoteBuy(spend: bigint, state: Reserves | undefined, limits: QuoteLimits): Quote {
  const reserves = reserveValues(state, limits.maxVenueFeeBps);
  if (!reserves) return { ok: false, reason: 'route_or_fee_unknown' };
  if (spend <= 0n) return { ok: false, reason: 'invalid_size' };
  // Allocate a fixed total swap budget across reserve input and fee.
  const reserveIn = spend * BPS / (BPS + reserves.feeBps);
  const venueFee = ceil(reserveIn * reserves.feeBps, BPS);
  const tokens = reserves.token * reserveIn / (reserves.sol + reserveIn);
  if (tokens <= 0n || tokens > reserves.realToken) return { ok: false, reason: 'insufficient_real_tokens' };
  const impactBps = Number(ceil(reserveIn * BPS, reserves.sol + reserveIn));
  if (impactBps > limits.impactBps) return { ok: false, reason: 'entry_impact_limit' };
  return { ok: true, tokens, grossSol: reserveIn, venueFee, netSol: reserveIn + venueFee + limits.executionFee, impactBps };
}

export function quoteSell(tokens: bigint, state: Reserves | undefined, limits: QuoteLimits): Quote {
  const reserves = reserveValues(state, limits.maxVenueFeeBps);
  if (!reserves) return { ok: false, reason: 'route_or_fee_unknown' };
  if (tokens <= 0n) return { ok: false, reason: 'invalid_size' };
  const grossSol = reserves.sol * tokens / (reserves.token + tokens);
  if (grossSol <= 0n || grossSol > reserves.realSol) return { ok: false, reason: 'insufficient_real_sol' };
  const impactBps = Number(ceil(tokens * BPS, reserves.token + tokens));
  if (impactBps > limits.impactBps) return { ok: false, reason: 'exit_impact_limit' };
  const venueFee = ceil(grossSol * reserves.feeBps, BPS);
  const netSol = grossSol - venueFee - limits.executionFee;
  if (netSol <= 0n) return { ok: false, reason: 'nonpositive_exit_proceeds' };
  return { ok: true, tokens, grossSol, venueFee, netSol, impactBps };
}

export function afterFill(
  state: Reserves, quote: Extract<Quote, { ok: true }>, side: 'buy' | 'sell',
): Reserves {
  const direction = side === 'buy' ? 1n : -1n;
  return {
    ...state,
    virtualToken: String(BigInt(state.virtualToken) - direction * quote.tokens),
    virtualSol: String(BigInt(state.virtualSol) + direction * quote.grossSol),
    realToken: String(BigInt(state.realToken) - direction * quote.tokens),
    realSol: String(BigInt(state.realSol) + direction * quote.grossSol),
  };
}

export function exitTrigger(
  netProceeds: bigint | undefined,
  cost: bigint,
  elapsedMs: number,
  rules: { takeProfitBps: number; stopLossBps: number; timeExitMs: number },
): 'take_profit' | 'stop_loss' | 'time_exit' | undefined {
  if (netProceeds !== undefined) {
    const gain = (netProceeds - cost) * BPS;
    if (gain >= cost * BigInt(rules.takeProfitBps)) return 'take_profit';
    if (gain <= -cost * BigInt(rules.stopLossBps)) return 'stop_loss';
  }
  if (elapsedMs >= rules.timeExitMs) return 'time_exit';
}

export function minAfterSlippage(quoted: bigint, slippageBps: number): bigint {
  return ceil(quoted * (BPS - BigInt(slippageBps)), BPS);
}
