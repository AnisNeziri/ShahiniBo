import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isPublicKey } from "./identity.ts";
import type { CreatorRecord, Delegation } from "./identity.ts";
import type { PaperSettings } from "./engine.ts";
import type { FeedSettings } from "./feed.ts";
import type { ReportOptions } from "./report.ts";
import { validateExitPolicy } from "./exits.ts";
import { validateModel } from "./model.ts";
import { PUMP_PROGRAM } from "./protocol-types.ts";

type JsonRecord = Record<string, unknown>;

export function object(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function amount(value: unknown, label: string, min = 0n): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
      BigInt(value) < min || BigInt(value) > (1n << 64n) - 1n) {
    throw new Error(`${label} must be an unsigned decimal u64 string`);
  }
  return value;
}

function publicKey(value: unknown, label: string): string {
  if (!isPublicKey(value)) throw new Error(`${label} must encode a 32-byte public key`);
  return value;
}

export function readJson(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`Invalid JSON in ${path}`);
  }
}

function readDelegation(value: unknown): Delegation {
  const item = object(value, "delegation");
  if (item.venue !== PUMP_PROGRAM) throw new Error("Delegation venue must be the official Pump program");
  const issuedAtMs = integer(item.issuedAtMs, "issuedAtMs");
  const verifiedAtMs = integer(item.verifiedAtMs, "verifiedAtMs", issuedAtMs);
  return {
    venue: PUMP_PROGRAM, issuedAtMs, verifiedAtMs,
    expiresAtMs: integer(item.expiresAtMs, "expiresAtMs", verifiedAtMs + 1),
    mint: publicKey(item.mint, "mint"), launchUser: publicKey(item.launchUser, "launchUser"),
    signature: string(item.signature, "signature"),
  };
}

export function loadAllowlist(path: string): { version: string; creators: CreatorRecord[] } {
  const list = object(readJson(path), "allowlist");
  const version = string(list.version, "allowlist.version");
  if (!Array.isArray(list.creators)) throw new Error("allowlist.creators must be an array");
  const wallets = new Set<string>();
  const creators = list.creators.map((value: unknown): CreatorRecord => {
    const entry = object(value, "creator");
    const wallet = publicKey(entry.wallet, "creator.wallet");
    if (wallets.has(wallet)) throw new Error("Duplicate creator wallet in allowlist");
    wallets.add(wallet);
    const method = entry.method;
    if (method !== "public-account" && method !== "wallet-challenge") throw new Error("Invalid verification method");
    const verifiedAtMs = integer(entry.verifiedAtMs, "verifiedAtMs");
    const activeAtMs = integer(entry.activeAtMs, "activeAtMs", verifiedAtMs);
    if (entry.delegations !== undefined && !Array.isArray(entry.delegations)) {
      throw new Error("creator.delegations must be an array");
    }
    return {
      wallet, method, verifiedAtMs, activeAtMs,
      alias: string(entry.alias, "creator.alias"),
      evidenceRef: string(entry.evidenceRef, "creator.evidenceRef"),
      revokedAtMs: entry.revokedAtMs === undefined ? undefined : integer(entry.revokedAtMs, "revokedAtMs", activeAtMs),
      delegations: entry.delegations?.map(readDelegation),
    };
  });
  return { version, creators };
}

function endpoint(value: string, label: string, allowed: readonly string[]): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is not a URL`); }
  if (!allowed.includes(url.protocol)) throw new Error(`Unsupported transport for ${label}`);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!local && (url.protocol === "http:" || url.protocol === "ws:")) {
    throw new Error(`Use an encrypted transport for a remote ${label}`);
  }
  return value;
}

export function loadFeed(value: unknown): FeedSettings {
  const feed = object(value, "feed");
  const rpcVar = string(feed.rpcEnv ?? "SOLANA_RPC_URL", "rpcEnv");
  const wsVar = string(feed.wsEnv ?? "SOLANA_WS_URL", "wsEnv");
  const rpc = process.env[rpcVar] ?? "https://api.mainnet-beta.solana.com";
  const ws = process.env[wsVar];
  if (feed.launchesOnly !== undefined && typeof feed.launchesOnly !== "boolean") {
    throw new Error("feed.launchesOnly must be a boolean");
  }
  return {
    rpcUrl: endpoint(rpc, "RPC", ["https:", "http:"]),
    wsUrl: ws ? endpoint(ws, "WebSocket", ["wss:", "ws:"]) : undefined,
    provider: string(feed.provider, "feed.provider"),
    staleMs: integer(feed.staleMs ?? 15000, "staleMs", 1000, 300000),
    maxQueue: integer(feed.maxQueue ?? 4096, "maxQueue", 1, 8192),
    backlogSlots: integer(feed.backlogSlots ?? 128, "backlogSlots", 1, 256),
    importSlots: integer(feed.importSlots ?? 256, "importSlots", 1, 256),
    hydrationDeadlineMs: integer(feed.hydrationDeadlineMs ?? 3000, "hydrationDeadlineMs", 100, 60000),
    launchesOnly: feed.launchesOnly,
  };
}

function loadPaperSettings(value: unknown): PaperSettings {
  const paper = object(value, "strategy");
  const delay = object(paper.delayMs, "delayMs");
  const exits = paper.exits === undefined ? undefined : validateExitPolicy(paper.exits);
  const risk = paper.riskPolicy === undefined ? undefined : object(paper.riskPolicy, "riskPolicy");
  const settings: PaperSettings = {
    startingLamports: amount(paper.startingLamports, "startingLamports", 1n),
    spendLamports: amount(paper.spendLamports, "spendLamports", 1n),
    maxExposureLamports: amount(paper.maxExposureLamports, "maxExposureLamports", 1n),
    dailyLossLamports: amount(paper.dailyLossLamports, "dailyLossLamports", 1n),
    networkFeeLamports: amount(paper.networkFeeLamports, "networkFeeLamports"),
    priorityFeeLamports: amount(paper.priorityFeeLamports, "priorityFeeLamports"),
    failedFeeLamports: amount(paper.failedFeeLamports, "failedFeeLamports"),
    tokenAccountRentLamports: amount(paper.tokenAccountRentLamports ?? "0", "tokenAccountRentLamports"),
    tipLamports: amount(paper.tipLamports ?? "0", "tipLamports"),
    maxOpenPositions: integer(paper.maxOpenPositions, "maxOpenPositions", 1, 10000),
    takeProfitBps: integer(paper.takeProfitBps ?? (exits ? 2000 : undefined), "takeProfitBps", 1, 10000000),
    stopLossBps: integer(paper.stopLossBps ?? (exits ? 1000 : undefined), "stopLossBps", 1, 10000),
    timeExitMs: integer(paper.timeExitMs, "timeExitMs", 1),
    maxLaunchAgeMs: integer(paper.maxLaunchAgeMs, "maxLaunchAgeMs", 1),
    maxStateAgeMs: integer(paper.maxStateAgeMs, "maxStateAgeMs", 1),
    entryImpactBps: integer(paper.entryImpactBps, "entryImpactBps", 0, 9999),
    exitImpactBps: integer(paper.exitImpactBps, "exitImpactBps", 0, 9999),
    slippageBps: integer(paper.slippageBps, "slippageBps", 0, 9999),
    maxVenueFeeBps: integer(paper.maxVenueFeeBps, "maxVenueFeeBps", 0, 9999),
    maxAttempts: integer(paper.maxAttempts, "maxAttempts", 1, 20),
    retryDelayMs: integer(paper.retryDelayMs, "retryDelayMs", 1),
    minCreatorHistorySamples: paper.minCreatorHistorySamples === undefined ? undefined :
      integer(paper.minCreatorHistorySamples, "minCreatorHistorySamples", 1),
    minCreatorHistoryCoverageBps: paper.minCreatorHistoryCoverageBps === undefined ? undefined :
      integer(paper.minCreatorHistoryCoverageBps, "minCreatorHistoryCoverageBps", 0, 10000),
    minCreatorHistoryReturnBps: paper.minCreatorHistoryReturnBps === undefined ? undefined :
      integer(paper.minCreatorHistoryReturnBps, "minCreatorHistoryReturnBps", -10000),
    minCreatorInitialBuyLamports: paper.minCreatorInitialBuyLamports === undefined ? undefined :
      amount(paper.minCreatorInitialBuyLamports, "minCreatorInitialBuyLamports"),
    maxConcentrationBps: paper.maxConcentrationBps === undefined ? undefined :
      integer(paper.maxConcentrationBps, "maxConcentrationBps", 0, 10000),
    exits,
    riskPolicy: risk && {
      version: string(risk.version, "riskPolicy.version"),
      maxRoundTripLossBps: risk.maxRoundTripLossBps === undefined ? undefined :
        integer(risk.maxRoundTripLossBps, "maxRoundTripLossBps", 0, 10000),
      minDistinctBuyers: risk.minDistinctBuyers === undefined ? undefined :
        integer(risk.minDistinctBuyers, "minDistinctBuyers", 0, 256),
      maxHolderConcentrationBps: risk.maxHolderConcentrationBps === undefined ? undefined :
        integer(risk.maxHolderConcentrationBps, "maxHolderConcentrationBps", 0, 10000),
    },
    delayMs: {
      detection: integer(delay.detection, "delayMs.detection", 0, 3600000),
      decision: integer(delay.decision, "delayMs.decision", 0, 3600000),
      submission: integer(delay.submission, "delayMs.submission", 0, 3600000),
      landing: integer(delay.landing, "delayMs.landing", 0, 3600000),
    },
  };
  return settings;
}

export function loadSettings(path: string, mode: "paper" | "monitor") {
  const input = object(readJson(path), "settings");
  if (input.version !== 1 || input.mode !== mode) throw new Error(`Expected version 1 ${mode} configuration`);
  const base = dirname(resolve(path));
  const database = resolve(base, string(input.database, "database"));
  const capture = resolve(base, string(input.capture, "capture"));
  if (database.toLowerCase().endsWith(".live.sqlite") || database === capture) {
    throw new Error("Use distinct capture and paper or monitor ledger paths");
  }
  if (input.tracker !== undefined && typeof input.tracker !== "boolean") throw new Error("tracker must be a boolean");
  return {
    database,
    capture,
    feedInput: input.feed,
    paper: mode === "paper" ? loadPaperSettings(input.strategy) : undefined,
    allowlist: mode === "paper" ? loadAllowlist(resolve(base, string(input.allowlist, "allowlist"))) : undefined,
    report: input.report === undefined ? undefined : loadReportOptions(input.report),
    tracker: input.tracker === true,
    shadowModel: input.shadowModel === undefined ? undefined : validateModel(readJson(resolve(base, string(input.shadowModel, "shadowModel")))),
  };
}

function loadReportOptions(value: unknown): ReportOptions & { evaluationStartMs?: number; evaluationEndMs?: number } {
  const report = object(value, "report");
  const optionalTime = (field: string) => report[field] === undefined ? undefined : integer(report[field], field);
  if (report.historicalAllowlistVerified !== undefined && typeof report.historicalAllowlistVerified !== "boolean") {
    throw new Error("historicalAllowlistVerified must be a boolean");
  }
  const fx = report.eurReference === undefined ? undefined : object(report.eurReference, "eurReference");
  return {
    evaluationStartMs: optionalTime("evaluationStartMs"),
    evaluationEndMs: optionalTime("evaluationEndMs"),
    fixedCostsLamports: report.fixedCostsLamports === undefined ? undefined : amount(report.fixedCostsLamports, "fixedCostsLamports"),
    provenance: report.provenance === undefined ? undefined : string(report.provenance, "report.provenance"),
    historicalAllowlistVerified: report.historicalAllowlistVerified,
    eurReference: fx && {
      eurCentsPerSol: amount(fx.eurCentsPerSol, "eurCentsPerSol", 1n),
      observedAtMs: integer(fx.observedAtMs, "eurReference.observedAtMs"),
      source: string(fx.source, "eurReference.source"),
    },
  };
}
