export type ExitUnit = 'net_pnl_percent' | 'net_pnl_sol' | 'executable_sol_per_token';

export interface ExitLevel {
  unit: ExitUnit;
  value: string;
}

export interface ProfitLeg extends ExitLevel {
  label: string;
  sellPercent: string;
}

export interface ExitPolicy {
  version: string;
  takeProfits: ProfitLeg[];
  stop: ExitLevel;
}

export interface ExitProgress {
  policyVersion: string;
  originalTokens: string;
  entryCostLamports: string;
  saleProceedsLamports: string;
  failedFeesLamports: string;
  legs: Record<string, { soldTokens: string; state: 'armed' | 'pending' | 'failed' | 'filled' | 'rounded_to_zero'; operationId?: string }>;
  terminal?: 'stop_loss' | 'time_exit';
}

export function decimalUnits(text: string, places: number): bigint {
  const match = /^(-?)(\d{1,20})(?:\.(\d{1,18}))?$/.exec(text);
  if (!match || (match[3]?.length ?? 0) > places) throw new Error(`Invalid decimal precision for ${text}`);
  const magnitude = BigInt(match[2]!) * 10n ** BigInt(places) + BigInt((match[3] ?? '').padEnd(places, '0') || '0');
  return match[1] === '-' ? -magnitude : magnitude;
}

function threshold(level: ExitLevel): bigint {
  switch (level.unit) {
    case 'net_pnl_percent': return decimalUnits(level.value, 2);
    case 'net_pnl_sol': return decimalUnits(level.value, 9);
    case 'executable_sol_per_token': return decimalUnits(level.value, 18);
  }
}

export function validateExitPolicy(value: unknown): ExitPolicy {
  const row = value as Partial<ExitPolicy> | null;
  if (!row || typeof row.version !== 'string' || !/^[\w.-]{1,64}$/.test(row.version) ||
      !Array.isArray(row.takeProfits) || row.takeProfits.length < 1 || row.takeProfits.length > 3 || !row.stop) {
    throw new Error('An exit policy needs a version, one to three TP legs and a stop');
  }
  function level(value: ExitLevel, stop: boolean) {
    if (!value || !['net_pnl_percent', 'net_pnl_sol', 'executable_sol_per_token'].includes(value.unit) ||
        typeof value.value !== 'string') throw new Error('Invalid exit level');
    const target = threshold(value);
    if (stop && value.unit !== 'executable_sol_per_token' ? target >= 0n : target <= 0n) {
      throw new Error('Profit and token price levels must be positive and net loss levels negative');
    }
    return { unit: value.unit, value: value.value };
  }
  const labels = new Set<string>();
  let size = 0n;
  const takeProfits = row.takeProfits.map(item => {
    if (!item || typeof item.label !== 'string' || !/^TP[123]$/.test(item.label) || labels.has(item.label) ||
        typeof item.sellPercent !== 'string') throw new Error('Each exit leg needs a unique TP1, TP2 or TP3 label');
    labels.add(item.label);
    const fraction = decimalUnits(item.sellPercent, 2);
    if (fraction <= 0n) throw new Error('Exit leg size must be positive');
    size += fraction;
    return { ...level(item, false), label: item.label, sellPercent: item.sellPercent };
  });
  if (size > 10_000n) throw new Error('Combined exit leg fractions exceed 100%');
  return { version: row.version, takeProfits: takeProfits.sort((a, b) => a.label.localeCompare(b.label)), stop: level(row.stop, true) };
}

export function startExit(policy: ExitPolicy, tokens: string, entryCost: string): ExitProgress {
  return {
    policyVersion: policy.version, originalTokens: tokens, entryCostLamports: entryCost,
    saleProceedsLamports: '0', failedFeesLamports: '0',
    legs: Object.fromEntries(policy.takeProfits.map(leg => {
      const size = BigInt(tokens) * decimalUnits(leg.sellPercent, 2) / 10_000n;
      return [leg.label, { soldTokens: '0', state: size > 0n ? 'armed' : 'rounded_to_zero' }];
    })),
  };
}

function crosses(level: ExitLevel, exitNet: bigint | undefined, tokens: bigint, mark: bigint | undefined,
  progress: ExitProgress, stop: boolean): boolean {
  const target = threshold(level);
  let left: bigint;
  let right: bigint;
  const entryCost = BigInt(progress.entryCostLamports);
  if (level.unit === 'executable_sol_per_token') {
    if (exitNet === undefined || tokens === 0n) return false;
    // Pump mints have 6 decimals. Net leg receipt includes venue and network costs.
    left = exitNet * 10n ** 15n;
    right = target * tokens;
  } else {
    if (mark === undefined) return false;
    const pnl = BigInt(progress.saleProceedsLamports) + mark - entryCost - BigInt(progress.failedFeesLamports);
    left = level.unit === 'net_pnl_percent' ? pnl * 10_000n : pnl;
    right = level.unit === 'net_pnl_percent' ? target * entryCost : target;
  }
  return stop ? left <= right : left >= right;
}

export function terminalExit(policy: ExitPolicy, progress: ExitProgress, remaining: bigint, net: bigint | undefined,
  elapsed: number, timeExitMs: number): ExitProgress['terminal'] {
  if (progress.terminal === 'stop_loss' || crosses(policy.stop, net, remaining, net, progress, true)) return 'stop_loss';
  if (progress.terminal === 'time_exit' || elapsed >= timeExitMs) return 'time_exit';
}

export function profitExit(policy: ExitPolicy, progress: ExitProgress, remaining: bigint, mark: bigint | undefined,
  quote: (size: bigint) => bigint | undefined, canAttempt: (label: string) => boolean = () => true
): { label: string; tokens: bigint; net: bigint } | undefined {
  for (const leg of policy.takeProfits) {
    if (!canAttempt(leg.label)) continue;
    const size = profitSize(policy, progress, remaining, leg.label);
    if (size === 0n) continue;
    const net = quote(size);
    if (net !== undefined && crosses(leg, net, size, mark, progress, false)) {
      return { label: leg.label, tokens: size, net };
    }
  }
}

export function profitSize(policy: ExitPolicy, progress: ExitProgress, remaining: bigint, label: string): bigint {
  const leg = policy.takeProfits.find(item => item.label === label);
  if (!leg || ['filled', 'rounded_to_zero'].includes(progress.legs[label]?.state ?? '')) return 0n;
  const size = BigInt(progress.originalTokens) * decimalUnits(leg.sellPercent, 2) / 10_000n;
  return size > remaining ? remaining : size;
}

export function flagLeg(progress: ExitProgress, label: string, state: 'pending' | 'failed', operationId: string): void {
  const current = progress.legs[label];
  if (current && current.state !== 'filled') progress.legs[label] = { ...current, state, operationId };
}

export function sellProgress(progress: ExitProgress, label: string, sold: bigint, net: bigint, operationId: string): void {
  progress.saleProceedsLamports = String(BigInt(progress.saleProceedsLamports) + net);
  progress.legs[label] = { soldTokens: String(sold), state: 'filled', operationId };
}
