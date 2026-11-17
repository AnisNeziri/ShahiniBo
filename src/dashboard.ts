import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import bs58 from 'bs58';
import type { PaperSettings, PaperState, Position } from './engine.ts';
import { isPublicKey } from './identity.ts';
import { Ledger } from './ledger.ts';
import type { RunSnapshot } from './ledger.ts';
import type { FeedEvent, NormalizedEvent } from './protocol-types.ts';
import { buildReport, formatSol } from './report.ts';
import type { ReportOptions } from './report.ts';

type Data = Record<string, unknown>;
type Row = Record<string, SQLOutputValue>;
type Cursor = { tag: string; journal: number; market: number };
type Source = 'market' | 'paper' | 'live' | 'system';
type Activity = {
  id: string; atMs: number; kind: string; source: Source; data: Data;
  mint?: string; creator?: string; operationId?: string; signature?: string;
  links: { mint?: string; explorer?: string }; riskStale?: boolean;
};
type Submission = Omit<Activity, 'atMs'> & { atMs: number | null; state: string; side?: string };
type Feed = { healthy: boolean; stale: boolean; lastAtMs: number | null; reason: string | null; slot: number | null };
type Monitor = { health?: FeedEvent; lastAtMs?: number };
type Run = { id: string; mode: string; revision: number; now: number };
type View = {
  cursor: string; observedAtMs: number; run: Run; feed: Feed;
  positions: Data[]; submissions: Submission[]; performance: Data | null;
};
type Snapshot = View & { activity: Activity[] };
type SourceView = {
  view: View; cursor: Cursor;
  activities: (after?: Cursor) => Activity[] | null;
  coin: (mint: string) => Data;
};
type DashboardOptions = {
  database: string; runId?: string; port?: number; pollMs?: number; now?: () => number; onConnect?: () => void;
};

const historyLimit = 140;
const catchupLimit = 300;
const publicAssets: Record<string, readonly [string, string]> = Object.assign(Object.create(null), {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
});

function object(value: unknown): Data {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
}

function json(value: SQLOutputValue | undefined): Data {
  return typeof value === 'string' ? object(JSON.parse(value)) : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function links(mint: string | undefined, signature?: string): Activity['links'] {
  let validSignature = false;
  if (signature && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
    validSignature = bs58.decode(signature).length === 64;
  }
  return {
    ...(isPublicKey(mint) ? { mint: `https://pump.fun/coin/${mint}` } : {}),
    ...(validSignature ? { explorer: `https://explorer.solana.com/tx/${signature}` } : {}),
  };
}

function serializeCursor(cursor: Cursor): string {
  return `${cursor.tag}:${cursor.journal}:${cursor.market}`;
}

function readCursor(value: string | null): Cursor | undefined {
  if (!value) return;
  const match = /^([a-f0-9]{16}):(\d{1,16}):(\d{1,16})$/.exec(value);
  if (!match) return;
  const journal = Number(match[2]);
  const market = Number(match[3]);
  if (Number.isSafeInteger(journal) && Number.isSafeInteger(market)) return { tag: match[1]!, journal, market };
}

function feedState(now: number, maxAge: number, lastAtMs: number | null, healthy: boolean, reason: string | null, slot: number | null): Feed {
  const stale = !healthy || lastAtMs === null || now - lastAtMs > maxAge;
  return { healthy, stale, lastAtMs, reason: reason ?? (stale ? 'No recent healthy feed' : null), slot };
}

function sorted(rows: Activity[]): Activity[] {
  return rows.sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

function activityWindow(
  cursor: Cursor, after: Cursor | undefined,
  journal: (offset?: number) => Activity[], market: (offset?: number) => Activity[],
): Activity[] | null {
  if (after && (after.tag !== cursor.tag || after.journal > cursor.journal || after.market > cursor.market)) return null;
  const rows = [...journal(after?.journal), ...market(after?.market)];
  if (after && rows.length > catchupLimit) return null;
  return after ? sorted(rows) : sorted(rows).slice(-historyLimit);
}

function paperSource(db: DatabaseSync, ledger: Ledger, opts: DashboardOptions, observedAtMs: number, cached: (run: RunSnapshot<PaperState>) => Data): SourceView {
  const selected = opts.runId ?? string(db.prepare('SELECT id FROM runs ORDER BY rowid DESC LIMIT 1').get()?.id);
  const tag = createHash('sha256').update(resolve(opts.database)).update('\0').update(selected ?? '').digest('hex').slice(0, 16);
  const cursor = { tag, journal: 0, market: 0 };
  if (!selected || !db.prepare('SELECT 1 FROM runs WHERE id = ?').get(selected)) {
    return {
      cursor,
      view: { cursor: serializeCursor(cursor), observedAtMs, run: { id: selected ?? 'waiting', mode: 'waiting', revision: 0, now: observedAtMs },
        feed: feedState(observedAtMs, 0, null, false, 'Waiting for a recorded run', null), positions: [], submissions: [], performance: null },
      activities: () => [], coin: mint => ({ mint, links: links(mint), position: null, decision: null, market: null, observedAtMs }),
    };
  }
  const run = ledger.run<PaperState>(selected);
  const config = run.settings as Partial<PaperSettings>;
  const isPaper = run.mode === 'paper' || run.mode === 'replay';
  const state = run.state;
  const monitor = state as unknown as Monitor;
  const now = run.mode === 'replay' ? state.now : observedAtMs;
  const maxAge = config.maxStateAgeMs ?? 15_000;
  cursor.journal = Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS mark FROM journal WHERE run_id = ?').get(selected)?.mark);
  cursor.market = Number(db.prepare('SELECT COALESCE(MAX(rowid),0) AS mark FROM events WHERE run_id = ?').get(selected)?.mark);
  const latestFeed = isPaper ? json(db.prepare("SELECT data FROM journal WHERE run_id = ? AND kind='feed' ORDER BY seq DESC LIMIT 1").get(selected)?.data) :
    object(monitor.health);
  const feed = feedState(now, maxAge, number(isPaper ? state.lastFeedAtMs : monitor.health?.receivedAtMs), isPaper ? state.feedHealthy : monitor.health?.healthy === true,
    string(latestFeed.reason) ?? null, number(state.lastSlot ?? latestFeed.slot));

  const journalItem = (row: Row): Activity => {
    const data = json(row.data);
    const mint = string(row.mint);
    const kind = String(row.kind);
    const risk = object(data.risk);
    const signature = string(data.signature ?? risk.launchSignature);
    const cutoff = number(risk.cutoffMs);
    return { id: `j:${row.seq}`, atMs: Number(row.at_ms), kind, source: kind === 'decision' || kind === 'feed' || kind === 'finality' ? 'system' : 'paper',
      mint, creator: string(data.creator) ?? (mint ? state.launches?.[mint]?.creator : undefined), data, links: links(mint, signature),
      signature, operationId: string(row.operation_id), ...(kind === 'decision' ? { riskStale: cutoff === null || now - cutoff > maxAge } : {}) };
  };
  const marketItem = (row: Row): Activity => {
    const event = json(row.normalized) as unknown as NormalizedEvent;
    const mint = event.kind !== 'feed' ? event.mint : undefined;
    const signature = event.kind !== 'feed' ? event.signature : undefined;
    const creator = event.kind === 'launch' ? event.creator : mint ? state.launches?.[mint]?.creator : undefined;
    return { id: `m:${row.rowid}`, atMs: event.receivedAtMs, kind: event.kind, source: 'market', mint, creator,
      links: links(mint, signature), signature, data: object(event) };
  };
  const journalRows = "kind IN ('decision','quote','intent','attempt','fill','result','exit_trigger','exit_terminal','exit_unresolved','position_partial','position_closed','feed','finality') AND (kind != 'result' OR json_extract(data,'$.status') != 'filled')";
  const marketRows = "json_extract(normalized,'$.kind') IN ('launch','trade','migration') AND json_extract(normalized,'$.commitment') IN ('confirmed','finalized')";
  const journal = (offset?: number) => {
    if (offset === cursor.journal) return [];
    const rows = offset === undefined
      ? db.prepare(`SELECT * FROM journal WHERE run_id=? AND ${journalRows} ORDER BY seq DESC LIMIT ?`).all(selected, historyLimit)
      : db.prepare(`SELECT * FROM journal WHERE run_id=? AND seq>? AND ${journalRows} ORDER BY seq LIMIT ?`).all(selected, offset, catchupLimit + 1);
    return rows.map(journalItem);
  };
  const market = (offset?: number) => {
    if (offset === cursor.market) return [];
    const rows = offset === undefined
      ? db.prepare(`SELECT rowid, normalized FROM events WHERE run_id=? AND ${marketRows} ORDER BY rowid DESC LIMIT ?`).all(selected, historyLimit)
      : db.prepare(`SELECT rowid, normalized FROM events WHERE run_id=? AND rowid>? AND ${marketRows} ORDER BY rowid LIMIT ?`).all(selected, offset, catchupLimit + 1);
    return rows.map(marketItem);
  };
  const position = (value: Position): Data => {
    const progress = value.exit;
    const originalTokens = progress?.originalTokens ?? value.tokens;
    const balance = BigInt(value.tokens);
    const original = BigInt(originalTokens);
    const proceeds = BigInt(progress?.saleProceedsLamports ?? '0');
    const cost = BigInt(progress?.entryCostLamports ?? value.costLamports);
    const fees = progress ? BigInt(progress.failedFeesLamports) : db.prepare(`SELECT data FROM journal
      WHERE run_id=? AND mint=? AND kind='result' AND json_extract(data,'$.side')='sell' AND json_extract(data,'$.status')='failed'`)
      .all(selected, value.mint).reduce((sum, row) => sum + BigInt(string(json(row.data).feeLamports) ?? '0'), 0n);
    const market = state.market[value.mint];
    const quoteAtMs = market?.event.reserves?.feeBps === undefined ? null : market.event.receivedAtMs;
    const quoteStale = feed.stale || quoteAtMs === null || now - quoteAtMs > maxAge;
    const mark = BigInt(value.markLamports);
    const liquidationLamports = quoteStale || market?.ambiguous || mark === 0n ? null : String(mark - BigInt(value.rentLamports));
    return { ...value, links: links(value.mint, value.signature), originalTokens, remainingTokens: value.tokens,
      realizedLamports: String(proceeds - (original ? cost * (original - balance) / original : 0n) - fees), liquidationLamports,
      quoteAtMs, quoteStale, policy: config.exits ?? { version: config.takeProfitBps == null ? 'unknown' : 'single-exit',
        takeProfits: config.takeProfitBps == null ? [] : [{ label: 'TP1', unit: 'net_pnl_percent', value: String(config.takeProfitBps / 100), sellPercent: '100' }],
        stop: config.stopLossBps == null ? null : { unit: 'net_pnl_percent', value: String(-config.stopLossBps / 100) } } };
  };
  const positions = isPaper ? Object.values(state.positions).map(position) : [];
  const pending = isPaper ? Object.values(state.orders).map(order => ({
    id: `pending:${order.id}`, atMs: order.atMs, kind: 'attempt', source: 'paper' as const, mint: order.mint, operationId: order.id,
    creator: state.launches[order.mint]?.creator, side: order.side, data: object(order), state: order.phase === 'land' ? 'pending' : 'scheduled',
    links: links(order.mint),
  })) : [];
  const failures = db.prepare(`SELECT * FROM journal WHERE run_id=? AND kind='result'
    AND json_extract(data,'$.status') IN ('failed','missed') ORDER BY seq DESC LIMIT 45`).all(selected)
    .map(row => { const item = journalItem(row); return { ...item, state: String(item.data.status), side: string(item.data.side) }; });
  return {
    cursor,
    view: { cursor: serializeCursor(cursor), observedAtMs, run: { id: run.id, mode: run.mode, revision: run.revision, now },
      feed, positions, submissions: [...pending, ...failures], performance: isPaper ? cached(run) : null },
    activities: after => activityWindow(cursor, after, journal, market),
    coin(mint) {
      const row = db.prepare("SELECT * FROM journal WHERE run_id=? AND mint=? AND kind='decision' ORDER BY seq DESC LIMIT 1").get(selected, mint);
      const latest = db.prepare(`SELECT rowid, normalized FROM events WHERE run_id=? AND ${marketRows}
        AND json_extract(normalized,'$.mint')=? ORDER BY rowid DESC LIMIT 1`).get(selected, mint);
      const decision = row ? journalItem(row) : null;
      return { mint, creator: state.launches?.[mint]?.creator ?? decision?.creator, decision, links: links(mint, decision?.signature),
        market: latest ? marketItem(latest) : null, position: positions.find(item => item.mint === mint) ?? null, observedAtMs };
    },
  };
}

function liveSource(db: DatabaseSync, opts: DashboardOptions, observedAtMs: number): SourceView {
  const id = 'live-records';
  const tag = createHash('sha256').update(resolve(opts.database)).update('\0live-records').digest('hex').slice(0, 16);
  const cursor = { tag,
    journal: Number(db.prepare('SELECT COALESCE(MAX(rowid),0) AS mark FROM live_settlement').get()?.mark),
    market: Number(db.prepare('SELECT COALESCE(MAX(rowid),0) AS mark FROM live_decisions').get()?.mark) };
  const recorded = json(db.prepare("SELECT value AS data FROM live_runtime WHERE name='feed'").get()?.data);
  const lastAtMs = number(recorded.receivedAtMs);
  const feed = feedState(observedAtMs, 15_000, lastAtMs, recorded.healthy === true, string(recorded.reason) ?? null, number(recorded.slot));
  const decisionItem = (row: Row): Activity => {
    const data = json(row.evidence);
    const launch = object(data.launch);
    const signature = string(launch.signature);
    const mint = string(launch.mint);
    return { id: `d:${row.rowid}`, atMs: Number(row.atMs), kind: 'decision', source: 'live', mint, signature,
      creator: string(launch.creator), operationId: String(row.id), data, links: links(mint, signature), riskStale: observedAtMs - Number(row.atMs) > 15_000 };
  };
  const settlementItem = (row: Row): Activity => {
    const mint = string(row.mint);
    const signature = string(row.signature);
    const intent = json(row.intent);
    const { intent: _intent, ...publicRow } = row;
    const sol = BigInt(String(row.solDelta)) + BigInt(String(row.rentDelta));
    const tokens = BigInt(String(row.tokenDelta));
    return { id: `s:${row.rowid}`, atMs: Number(row.settledAt), kind: row.result === 'filled' ? 'fill' : 'result', source: 'live', mint, signature,
      operationId: String(row.operationId), creator: string(intent.creator), links: links(mint, signature),
      data: { ...publicRow, trigger: intent.trigger, status: row.result, feeLamports: row.fee,
        netLamports: String(row.side === 'buy' && row.result === 'filled' ? -sol : sol), tokens: String(tokens < 0n ? -tokens : tokens) } };
  };
  const settlements = 'SELECT s.rowid,s.*,a.mint,a.side,a.signature,a.intent FROM live_settlement s JOIN live_attempt a USING(operationId)';
  const journal = (offset?: number) => (offset === undefined
    ? db.prepare(`${settlements} ORDER BY s.rowid DESC LIMIT ?`).all(historyLimit)
    : offset === cursor.journal ? [] : db.prepare(`${settlements} WHERE s.rowid>? ORDER BY s.rowid LIMIT ?`).all(offset, catchupLimit + 1)).map(settlementItem);
  const market = (offset?: number) => (offset === undefined
    ? db.prepare('SELECT rowid,* FROM live_decisions ORDER BY rowid DESC LIMIT ?').all(historyLimit)
    : offset === cursor.market ? [] : db.prepare('SELECT rowid,* FROM live_decisions WHERE rowid>? ORDER BY rowid LIMIT ?')
      .all(offset, catchupLimit + 1)).map(decisionItem);
  const sums = new Map<string, bigint>();
  let realized = 0n;
  let fees = 0n;
  let buys = 0;
  let sells = 0;
  let buyFailures = 0;
  let sellFailures = 0;
  for (const row of db.prepare(settlements).iterate()) {
    const net = BigInt(String(row.realizedPnl));
    realized += net;
    fees += BigInt(String(row.fee));
    if (row.result === 'failed') {
      if (row.side === 'buy') buyFailures++;
      else sellFailures++;
    }
    else if (row.side === 'buy') buys++;
    else sells++;
    const mint = String(row.mint);
    sums.set(mint, (sums.get(mint) ?? 0n) + net);
  }
  const hasLadder = !!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='live_position_exit'").get();
  const positions = db.prepare(hasLadder ? 'SELECT p.*,e.data AS ladder FROM live_position p LEFT JOIN live_position_exit e USING(mint)' :
    'SELECT * FROM live_position').all().map(row => {
    const { ladder, ...safe } = row;
    const { progress, policy } = json(ladder);
    const mint = String(row.mint);
    return { ...safe, mint, exit: progress, policy, originalTokens: object(progress).originalTokens ?? row.tokens, remainingTokens: row.tokens,
      realizedLamports: String(sums.get(mint) ?? 0n), liquidationLamports: null, quoteAtMs: null, quoteStale: true, links: links(mint) };
  });
  const submissions = db.prepare("SELECT rowid,operationId,mint,side,signature,state,broadcasts,detail FROM live_attempt WHERE state!='confirmed' ORDER BY rowid DESC LIMIT 60")
    .all().map(row => {
      const mint = String(row.mint);
      const signature = string(row.signature);
      return { id: `a:${row.rowid}`, atMs: null, kind: row.state === 'failed' ? 'result' : 'attempt', mint, signature,
        source: 'live' as const, side: string(row.side), state: String(row.state), operationId: String(row.operationId), data: row, links: links(mint, signature) };
    });
  return {
    cursor,
    view: { cursor: serializeCursor(cursor), observedAtMs, run: { id, mode: 'live', revision: cursor.journal + cursor.market, now: observedAtMs }, feed,
      positions, submissions, performance: { returns: { realizedNetLamports: String(realized), realizedNetSol: formatSol(realized) },
        orders: { entry: { filled: buys, failed: buyFailures }, exit: { filled: sells, failed: sellFailures } }, fees: { executionLamports: String(fees) } } },
    activities: after => activityWindow(cursor, after, journal, market),
    coin(mint) {
      const row = db.prepare("SELECT rowid,* FROM live_decisions WHERE json_extract(evidence,'$.launch.mint')=? ORDER BY rowid DESC LIMIT 1").get(mint);
      const decision = row ? decisionItem(row) : null;
      return { mint, creator: decision?.creator, decision, links: links(mint, decision?.signature), market: null,
        position: positions.find(item => item.mint === mint) ?? null, observedAtMs };
    },
  };
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

export async function startDashboard(opts: DashboardOptions): Promise<{url: string; close: () => Promise<void>}> {
  const ledger = new Ledger(opts.database, { readOnly: true });
  const clients = new Map<ServerResponse, { after: Cursor; state: string; heartbeatAt: number }>();
  let url = '';
  let address = '';
  let localAddress = '';
  let stopped = false;
  let reportCache: { id: string; revision: number; report: Data } | undefined;
  const cached = (run: RunSnapshot<PaperState>) => {
    if (reportCache?.id === run.id && reportCache.revision === run.revision) return reportCache.report;
    const report = buildReport(ledger, run.id, (run.settings as { policy?: { report?: ReportOptions } }).policy?.report);
    const { closedPositions: _closed, openPositions: _open, settings: _settings, pendingOrders: _pending, ...rest } = report;
    reportCache = { id: run.id, revision: run.revision, report: rest };
    return rest;
  };
  const table = ledger.inspect(db => db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('runs','live_settlement') ORDER BY name DESC").get()?.name);
  if (!table) {
    ledger.close();
    throw new Error('Dashboard requires an initialized ShahiniBot ledger');
  }
  const withSource = <T>(consume: (source: SourceView) => T) => ledger.inspect(db => {
    const now = opts.now?.() ?? Date.now();
    return consume(table === 'live_settlement' ? liveSource(db, opts, now) : paperSource(db, ledger, opts, now, cached));
  });
  const snapshot = (source: SourceView): Snapshot => ({ ...source.view, activity: source.activities() ?? [] });
  const sendSse = (response: ServerResponse, kind: string, data: unknown, cursor?: string) => {
    if (!response.write(`${cursor ? `id: ${cursor}\n` : ''}event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`)) {
      if (response.writableLength > 768 * 1024) response.destroy();
    }
  };
  function update(response: ServerResponse, client: { after: Cursor; state: string; heartbeatAt: number }, source: SourceView): void {
    const { view, cursor } = source;
    const { observedAtMs: _observedAtMs, run, ...stable } = view;
    const stateKey = JSON.stringify({ ...stable, run: { ...run, now: run.mode === 'replay' ? run.now : 0 } });
    if (client.state === stateKey && client.heartbeatAt + 10_000 > view.observedAtMs) return;
    const delta = source.activities(client.after);
    if (delta === null) sendSse(response, 'reset', snapshot(source), view.cursor);
    else {
      if (delta.length) sendSse(response, 'activity', delta, view.cursor);
      sendSse(response, 'state', view, view.cursor);
    }
    client.after = cursor;
    client.state = stateKey;
    client.heartbeatAt = view.observedAtMs;
  }

  const server = createServer((request: IncomingMessage, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (![address, localAddress].includes(request.headers.host ?? '') ||
        (request.headers.origin && ![url, `http://${localAddress}`].includes(request.headers.origin))) {
      sendJson(response, { error: 'Dashboard accepts local requests only' }, 403);
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      sendJson(response, { error: 'Read-only endpoint' }, 405);
      return;
    }
    try {
      const page = new URL(request.url ?? '/', url);
      if (page.pathname === '/api/snapshot') return withSource(source => sendJson(response, snapshot(source)));
      if (page.pathname === '/api/coin') {
        const mint = page.searchParams.get('mint');
        if (!isPublicKey(mint)) return sendJson(response, { error: 'Expected a valid Solana mint' }, 400);
        return withSource(source => sendJson(response, source.coin(mint)));
      }
      if (page.pathname === '/api/events') {
        if (clients.size >= 16) return sendJson(response, { error: 'Dashboard stream limit reached' }, 503);
        const last = request.headers['last-event-id'];
        const after = readCursor(typeof last === 'string' ? last : page.searchParams.get('after'));
        withSource(source => {
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          response.write('retry: 1500\n\n');
          const client = { after: after ?? source.cursor, state: '', heartbeatAt: 0 };
          clients.set(response, client);
          response.once('close', () => clients.delete(response));
          if (after) update(response, client, source);
          else sendSse(response, 'reset', snapshot(source), source.view.cursor);
        });
        opts.onConnect?.();
        return;
      }
      const asset = publicAssets[page.pathname];
      if (asset) {
        const body = readFileSync(new URL(`../web/dashboard/${asset[0]}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': asset[1] });
        response.end(body);
        return;
      }
      sendJson(response, { error: 'Dashboard endpoint not found' }, 404);
    } catch {
      if (response.headersSent) response.destroy();
      else sendJson(response, { error: 'Dashboard data temporarily unavailable' }, 503);
    }
  });
  try {
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(opts.port ?? 4317, '127.0.0.1', () => {
        server.removeListener('error', reject);
        accept();
      });
    });
  } catch (error) {
    ledger.close();
    throw error;
  }
  const binding = server.address();
  if (!binding || typeof binding === 'string') throw new Error('Dashboard could not bind a loopback port');
  address = `127.0.0.1:${binding.port}`;
  localAddress = `localhost:${binding.port}`;
  url = `http://${address}`;
  const timer = setInterval(() => {
    if (!clients.size) return;
    try { withSource(source => { for (const [response, client] of clients) update(response, client, source); }); }
    catch { for (const response of clients.keys()) response.destroy(); }
  }, opts.pollMs ?? 750);
  return {
    url,
    async close() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const response of clients.keys()) response.end();
      await new Promise<void>((accept, reject) => {
        server.close(error => error ? reject(error) : accept());
        server.closeAllConnections();
      });
      ledger.close();
    },
  };
}
