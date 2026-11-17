import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type RunRow = {
  id: string;
  mode: string;
  settings: string;
  state: string;
  revision: number;
};

export type RunSnapshot<State = unknown> = {
  id: string;
  mode: string;
  settings: unknown;
  state: State;
  revision: number;
};

export type JournalEvent = {
  kind: string;
  atMs: number;
  mint?: string;
  operationId?: string;
  data: unknown;
};

export type Checkpoint = {
  slot: number;
  blockhash?: string;
  updatedAtMs: number;
};

function hydrate<State>(row: RunRow): RunSnapshot<State> {
  return {
    id: row.id,
    mode: row.mode,
    settings: JSON.parse(row.settings),
    state: JSON.parse(row.state) as State,
    revision: row.revision,
  };
}

export class Ledger {
  readonly #db: DatabaseSync;
  readonly #readOnly: boolean;

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    if (path !== ':memory:' && !options.readOnly) mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path, options);
    this.#readOnly = options.readOnly ?? false;
    this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
    if (options.readOnly) return;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, mode TEXT NOT NULL, settings TEXT NOT NULL,
        state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL REFERENCES runs(id), event_key TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL, normalized TEXT NOT NULL, raw TEXT,
        PRIMARY KEY (run_id, event_key)
      );
      CREATE TABLE IF NOT EXISTS journal (
        seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL, at_ms INTEGER NOT NULL, mint TEXT, operation_id TEXT, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_run ON journal(run_id, seq);
      CREATE TABLE IF NOT EXISTS checkpoints (name TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS enrichment (
        run_id TEXT NOT NULL REFERENCES runs(id), mint TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (run_id, mint)
      );
      CREATE TABLE IF NOT EXISTS controls (
        scope TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'killed'))
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  inspect<T>(read: (db: DatabaseSync) => T): T {
    if (!this.#readOnly) throw new Error('Inspection requires a read-only ledger');
    this.#db.exec('BEGIN');
    try {
      const result = read(this.#db);
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  saveEnrichment(runId: string, mint: string, data: unknown): void {
    this.#db.prepare('INSERT OR IGNORE INTO enrichment VALUES (?, ?, ?)').run(runId, mint, JSON.stringify(data));
  }

  enrichment<Event>(runId: string, mint: string): Event | undefined {
    const row = this.#db.prepare('SELECT data FROM enrichment WHERE run_id = ? AND mint = ?').get(runId, mint);
    return row ? JSON.parse(String(row.data)) as Event : undefined;
  }

  enrichments<Event>(runId: string): Event[] {
    if (!this.#db.prepare("SELECT name FROM sqlite_schema WHERE name='enrichment'").get()) return [];
    return this.#db.prepare('SELECT data FROM enrichment WHERE run_id = ? ORDER BY mint').all(runId)
      .map(row => JSON.parse(String(row.data)) as Event);
  }

  initialize<State>(id: string, mode: string, settings: unknown, initial: State): RunSnapshot<State> {
    this.#db.prepare('INSERT OR IGNORE INTO runs(id, mode, settings, state) VALUES (?, ?, ?, ?)')
      .run(id, mode, JSON.stringify(settings), JSON.stringify(initial));
    const snapshot = this.run<State>(id);
    if (snapshot.mode !== mode || JSON.stringify(snapshot.settings) !== JSON.stringify(settings)) {
      throw new Error(`Run ${id} already exists with different settings or mode`);
    }
    return snapshot;
  }

  run<State = unknown>(id: string): RunSnapshot<State> {
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!row) throw new Error(`Unknown run ID ${id}`);
    return hydrate<State>(row);
  }

  runs<State = unknown>(): RunSnapshot<State>[] {
    const rows = this.#db.prepare('SELECT * FROM runs ORDER BY rowid DESC').all() as RunRow[];
    return rows.map(hydrate<State>);
  }

  journal(id: string): JournalEvent[] {
    const rows = this.#db.prepare(
      'SELECT kind, at_ms, mint, operation_id, data FROM journal WHERE run_id = ? ORDER BY seq',
    ).all(id);
    return rows.map((row) => ({
      kind: String(row.kind),
      atMs: Number(row.at_ms),
      ...(row.mint === null ? {} : { mint: String(row.mint) }),
      ...(row.operation_id === null ? {} : { operationId: String(row.operation_id) }),
      data: JSON.parse(String(row.data)) as unknown,
    }));
  }

  events<Event = unknown>(id: string): Event[] {
    return this.#db.prepare('SELECT normalized FROM events WHERE run_id = ? ORDER BY rowid')
      .all(id).map((row) => JSON.parse(String(row.normalized)) as Event);
  }

  unfinalizedEvents<Event>(id: string, finalizedSlot: number | undefined): Event[] {
    // This bound is independent of WebSocket receipt queue limits. A full
    // ordered block can contain arbitrarily many protocol instruction events.
    const bound = 100_000;
    const rows = this.#db.prepare(`
      WITH reverted AS (
        SELECT DISTINCT json_extract(normalized, '$.blockhash') AS blockhash
        FROM events WHERE run_id = ?
        AND json_extract(normalized, '$.commitment') = 'rolled_back'
        AND json_extract(normalized, '$.slot') > ?
        AND json_type(normalized, '$.blockhash') = 'text'
      )
      SELECT normalized FROM events WHERE run_id = ?
      AND json_extract(normalized, '$.commitment') = 'confirmed'
      AND json_extract(normalized, '$.kind') IN ('launch', 'trade', 'migration')
      AND json_extract(normalized, '$.slot') > ?
      AND json_type(normalized, '$.blockhash') = 'text'
      AND json_extract(normalized, '$.blockhash') NOT IN (SELECT blockhash FROM reverted)
      ORDER BY rowid LIMIT ?
    `).all(id, finalizedSlot ?? -1, id, finalizedSlot ?? -1, bound + 1);
    if (rows.length > bound) throw new Error('Unfinalized recovery exceeds the ledger event bound');
    return rows.map(row => JSON.parse(String(row.normalized)) as Event);
  }

  hasEvent(id: string, key: string): boolean {
    return this.#db.prepare('SELECT 1 FROM events WHERE run_id = ? AND event_key = ?').get(id, key) !== undefined;
  }

  save<State>(args: {
    id: string;
    revision: number;
    state: State;
    journal: readonly JournalEvent[];
    event?: { key: string; receivedAtMs: number; normalized: unknown; raw?: unknown };
    checkpoint?: { name: string; point: Checkpoint };
  }): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#db.prepare('UPDATE runs SET state = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
        .run(JSON.stringify(args.state), args.id, args.revision);
      if (result.changes !== 1) throw new Error(`Concurrent writer for run ${args.id}`);
      if (args.event) {
        const { key, receivedAtMs, normalized, raw } = args.event;
        this.#db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)')
          .run(args.id, key, receivedAtMs, JSON.stringify(normalized), raw === undefined ? null : JSON.stringify(raw));
      }
      const insert = this.#db.prepare(
        'INSERT INTO journal(run_id, kind, at_ms, mint, operation_id, data) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const event of args.journal) {
        insert.run(args.id, event.kind, event.atMs, event.mint ?? null, event.operationId ?? null, JSON.stringify(event.data));
      }
      if (args.checkpoint) this.saveCheckpoint(args.checkpoint.name, args.checkpoint.point);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  checkpoint(name: string): Checkpoint | undefined {
    const row = this.#db.prepare('SELECT data FROM checkpoints WHERE name = ?').get(name);
    return row ? JSON.parse(String(row.data)) as Checkpoint : undefined;
  }

  saveCheckpoint(name: string, point: Checkpoint): void {
    const current = this.checkpoint(name);
    if (current && point.slot < current.slot) throw new Error('Checkpoint would move backwards');
    this.#db.prepare('INSERT INTO checkpoints VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data')
      .run(name, JSON.stringify(point));
  }

  control(scope: string): 'active' | 'paused' | 'killed' {
    const row = this.#db.prepare('SELECT state FROM controls WHERE scope = ?').get(scope);
    return (row?.state as 'active' | 'paused' | 'killed' | undefined) ?? 'active';
  }

  setControl(scope: string, state: 'active' | 'paused' | 'killed'): void {
    this.#db.prepare('INSERT INTO controls VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET state = excluded.state')
      .run(scope, state);
  }
}
