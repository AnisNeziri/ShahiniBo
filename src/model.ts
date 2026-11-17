import { createHash } from 'node:crypto';
import type { Feature, RiskSnapshot } from './risk.ts';

const featureNames: Feature[] = ['entryImpactBps', 'exitImpactBps', 'roundTripLossBps', 'distinctEarlyBuyers',
  'holderConcentrationBps', 'creatorReturnBps', 'priorLaunches', 'maturedLaunches'];

export interface Example {
  mint: string;
  creator: string;
  decisionAtMs: number;
  labelAvailableAtMs: number | null;
  tp1: boolean | null;
  exitExecutable: boolean | null;
  netLamports: string | null;
  features: RiskSnapshot['features'];
}

export interface Model {
  schema: 1;
  version: string;
  trainedBeforeMs: number;
  settingsHash: string;
  feature: Feature;
  boundary: number;
  leftBps: number;
  rightBps: number;
  approvalBps: number;
  samples: number;
  trainingDataHash: string;
}

export function hashSettings(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function strategyFingerprint(value: unknown): string {
  const { engineVersion, policy, riskPolicy, ...strategy } = value as Record<string, unknown>;
  return hashSettings(Object.fromEntries(Object.entries(strategy).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))));
}

export function validateModel(input: unknown): Model {
  const model = input as Model;
  if (!model || model.schema !== 1 || !featureNames.includes(model.feature) ||
      typeof model.version !== 'string' || !/^[a-f\d]{16}$/.test(model.version) ||
      !/^[a-f\d]{64}$/.test(model.trainingDataHash) ||
      !/^[a-f\d]{64}$/.test(model.settingsHash) || !Number.isFinite(model.boundary) ||
      !Number.isSafeInteger(model.trainedBeforeMs) || model.trainedBeforeMs < 0 ||
      !Number.isSafeInteger(model.samples) || model.samples < 30 ||
      ![model.leftBps, model.rightBps, model.approvalBps].every(value => Number.isInteger(value) && value >= 0 && value <= 10000)) {
    throw new Error('Invalid local model artifact');
  }
  return model;
}

export function scoreModel(model: Model | undefined, features: RiskSnapshot['features'], atMs: number, settingsHash: string) {
  if (!model) return { available: false as const, reason: 'no_trained_model' };
  const detail = { version: model.version, input: model.feature, value: features[model.feature], boundary: model.boundary };
  if (atMs < model.trainedBeforeMs || settingsHash !== model.settingsHash) {
    return { available: false as const, ...detail, reason: atMs < model.trainedBeforeMs ? 'training_window' : 'different_frozen_settings' };
  }
  const value = features[model.feature];
  if (value == null || !Number.isFinite(value)) return { available: false as const, ...detail, reason: 'missing_feature' };
  const scoreBps = value <= model.boundary ? model.leftBps : model.rightBps;
  return { available: true as const, ...detail, scoreBps, wouldEnter: scoreBps >= model.approvalBps };
}

export function trainModel(examples: readonly Example[], trainedBeforeMs: number, settingsHash: string): Model | undefined {
  const eligible = examples.filter(row => row.decisionAtMs < trainedBeforeMs && row.labelAvailableAtMs !== null &&
    row.labelAvailableAtMs < trainedBeforeMs && row.tp1 !== null);
  const overallPositives = eligible.filter(row => row.tp1).length;
  if (eligible.length < 30 || Math.min(overallPositives, eligible.length - overallPositives) < 5) return;
  const impurity = (positives: number, count: number) => positives * (count - positives) / count;
  let bestGain = 0;
  let best: { feature: Feature; boundary: number; leftBps: number; rightBps: number; samples: number } | undefined;
  for (const feature of featureNames) {
    const rows = eligible.flatMap(row => {
      const x = row.features[feature];
      return x === null || !Number.isFinite(x) ? [] : [{ x, y: Number(row.tp1) }];
    }).sort((a, b) => a.x - b.x);
    const n = rows.length;
    if (n < 30 || n / eligible.length < 0.8) continue;
    const positives = rows.reduce((sum, row) => sum + row.y, 0);
    let left = 0;
    for (let i = 1; i <= n - 5; i++) {
      left += rows[i - 1]!.y;
      if (i < 5 || rows[i - 1]!.x === rows[i]!.x) continue;
      const right = positives - left;
      const gain = (impurity(positives, n) - impurity(left, i) - impurity(right, n - i)) / eligible.length;
      if (gain <= bestGain) continue;
      bestGain = gain;
      best = { feature, boundary: rows[i - 1]!.x, leftBps: Math.floor(left * 10000 / i),
        rightBps: Math.floor(right * 10000 / (n - i)), samples: n };
    }
  }
  if (!best) return;
  const info = { schema: 1 as const, trainedBeforeMs, settingsHash, approvalBps: 5000,
    trainingDataHash: hashSettings(eligible), ...best };
  return { ...info, version: hashSettings(info).slice(0, 16) };
}

export function evaluateModel(examples: readonly Example[], model: Model, settingsHash: string) {
  const holdout = examples.filter(row => row.decisionAtMs >= model.trainedBeforeMs);
  const matched = holdout.flatMap(row => row.labelAvailableAtMs !== null && row.tp1 !== null ? [{
    row, score: scoreModel(model, row.features, row.decisionAtMs, settingsHash),
  }] : []);
  const predicted = matched.filter(({ score }) => score.available);
  const approved = predicted.filter(({ score }) => score.available && score.wouldEnter);
  const total = (rows: Example[]) => rows.reduce((sum, row) => sum + BigInt(row.netLamports ?? '0'), 0n);
  return {
    mode: 'fixed_entry_outcome_relabeling', version: model.version, holdoutExamples: holdout.length,
    settingsMatched: settingsHash === model.settingsHash,
    usableLabels: matched.length, scores: predicted.length, approvals: approved.length,
    accuracy: predicted.length ? predicted.filter(({ row, score }) => score.available && score.wouldEnter === row.tp1).length / predicted.length : null,
    creatorLabeledNetLamports: String(total(matched.map(({ row }) => row))),
    shadowAcceptedLabeledNetLamports: String(total(approved.map(({ row }) => row))),
    verdict: 'inconclusive',
  };
}
