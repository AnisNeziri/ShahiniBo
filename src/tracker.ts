import { isPublicKey } from './identity.ts';

const endpoint = 'https://data.solanatracker.io/tokens/';
export interface TrackerSnapshot {
  provider: 'solana-tracker';
  mint: string;
  launchReceiptMs: number;
  startedAtMs: number;
  fetchedAtMs: number;
  providerAtMs: number | null;
  poolUpdatedAtMs: number | null;
  status: 'ok' | 'timeout' | 'rate_limited' | 'http_error' | 'invalid_response' | 'network_error';
  findings: { score?: number; top10Percent?: number; rugged?: boolean; holderCount?: number;
    findings?: { name: string; level?: string; score?: number }[] };
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function number(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
}

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1_000_000_000_000 ? value : null;
}

export function trackerFindings(input: unknown) {
  const body = record(input);
  const risk = record(body.risk);
  const findings: TrackerSnapshot['findings'] = {};
  const score = number(risk.score);
  const top10 = number(risk.top10, 100);
  const holders = number(body.holders);
  if (score !== undefined) findings.score = score;
  if (top10 !== undefined) findings.top10Percent = top10;
  if (holders !== undefined) findings.holderCount = holders;
  if (typeof risk.rugged === 'boolean') findings.rugged = risk.rugged;
  if (Array.isArray(risk.risks)) findings.findings = risk.risks.slice(0, 50).flatMap(value => {
    const entry = record(value);
    return typeof entry.name === 'string' ? [{ name: entry.name.slice(0, 120),
      ...(typeof entry.level === 'string' ? { level: entry.level.slice(0, 40) } : {}),
      ...(number(entry.score) !== undefined ? { score: number(entry.score) } : {}) }] : [];
  });
  const pools = Array.isArray(body.pools) ? body.pools.slice(0, 50) : [];
  const latest = pools.reduce<number>((best, pool) => Math.max(best, timestamp(record(pool).lastUpdated) ?? 0), 0);
  return { providerAtMs: timestamp(risk.lastUpdated ?? risk.timestamp), poolUpdatedAtMs: latest || null, findings };
}

export function trackerAsOf(snapshot: TrackerSnapshot | undefined, cutoffMs: number, maxAgeMs: number) {
  if (!snapshot) return { eligible: false, reason: 'not_available_at_decision' };
  if (snapshot.fetchedAtMs > cutoffMs) return { eligible: false, reason: 'received_after_decision' };
  if (snapshot.status !== 'ok') return { eligible: false, reason: snapshot.status };
  if (snapshot.providerAtMs === null) return { eligible: false, reason: 'provider_risk_timestamp_unknown', snapshot };
  if (snapshot.providerAtMs > snapshot.fetchedAtMs || cutoffMs - snapshot.providerAtMs > maxAgeMs) {
    return { eligible: false, reason: 'stale_or_future_provider_time', snapshot };
  }
  if (Object.keys(snapshot.findings).length === 0) return { eligible: false, reason: 'risk_fields_omitted', snapshot };
  return { eligible: true, reason: 'point_in_time', snapshot };
}

function retryDelay(value: string | null, now: number): number {
  if (!value) return 1000;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.min(60_000, Math.max(1000, ms)) : 1000;
}

async function readResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new SyntaxError('Tracker response has no body');
  const decoder = new TextDecoder();
  let total = 0;
  let json = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > 1_048_576) {
        await reader.cancel();
        throw new SyntaxError('Tracker response is too large');
      }
      json += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(json + decoder.decode());
  } finally { reader.releaseLock(); }
}

interface WorkerOptions {
  key: string; save: (value: TrackerSnapshot) => void; fetch?: typeof fetch; timeoutMs?: number;
  concurrency?: number; maxQueue?: number; minIntervalMs?: number; alreadyFetched?: (mint: string) => boolean;
  onError?: () => void;
}

export class TrackerWorker {
  #queue: { mint: string; received: number }[] = [];
  #seen = new Map<string, number>();
  #active = new Set<Promise<void>>();
  #abort = new AbortController();
  #blockedUntil = 0;
  #nextAt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #dropped = 0;
  readonly #options: WorkerOptions;

  constructor(options: WorkerOptions) {
    this.#options = options;
  }

  get dropped() { return this.#dropped; }

  enqueue(mint: string, received: number): void {
    if (this.#abort.signal.aborted || !isPublicKey(mint) || this.#seen.has(mint) || this.#options.alreadyFetched?.(mint)) return;
    if (this.#queue.length >= (this.#options.maxQueue ?? 64)) { this.#dropped++; return; }
    this.#seen.set(mint, received);
    if (this.#seen.size > 4096) this.#seen.delete(this.#seen.keys().next().value!);
    this.#queue.push({ mint, received });
    if (!this.#timer) this.#timer = setTimeout(() => this.#pump(), 0);
  }

  #pump(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#abort.signal.aborted || !this.#queue.length || this.#active.size >= (this.#options.concurrency ?? 2)) return;
    const wait = Math.max(this.#nextAt, this.#blockedUntil) - Date.now();
    if (wait > 0) {
      this.#timer = setTimeout(() => this.#pump(), wait);
      return;
    }
    const { mint, received } = this.#queue.shift()!;
    this.#nextAt = Date.now() + (this.#options.minIntervalMs ?? 250);
    const request = this.#fetch(mint, received).catch(() => this.#options.onError?.()).finally(() => {
      this.#active.delete(request);
      this.#pump();
    });
    this.#active.add(request);
    this.#pump();
  }

  async #fetch(mint: string, launchReceiptMs: number): Promise<void> {
    const startedAtMs = Date.now();
    const timed = AbortSignal.timeout(this.#options.timeoutMs ?? 2000);
    const signal = AbortSignal.any([timed, this.#abort.signal]);
    let status: TrackerSnapshot['status'] = 'network_error';
    let result = trackerFindings(null);
    try {
      const response = await (this.#options.fetch ?? fetch)(endpoint + mint, {
        headers: { 'x-api-key': this.#options.key }, signal, redirect: 'error',
      });
      if (response.status === 429) {
        this.#blockedUntil = Math.max(this.#blockedUntil, Date.now() + retryDelay(response.headers.get('retry-after'), Date.now()));
        status = 'rate_limited';
      } else if (!response.ok) status = 'http_error';
      else {
        const body = await readResponse(response);
        if (record(record(body).token).mint !== mint) status = 'invalid_response';
        else {
          status = 'ok';
          result = trackerFindings(body);
        }
      }
    } catch (error) {
      status = timed.aborted ? 'timeout' : error instanceof SyntaxError ? 'invalid_response' : 'network_error';
    }
    if (this.#abort.signal.aborted) return;
    this.#options.save({ provider: 'solana-tracker', mint, launchReceiptMs, startedAtMs, fetchedAtMs: Date.now(), status, ...result });
  }

  async close(): Promise<void> {
    this.#abort.abort();
    clearTimeout(this.#timer);
    await Promise.allSettled(this.#active);
  }
}
