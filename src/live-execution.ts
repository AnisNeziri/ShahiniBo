import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, openSync, unlinkSync, writeSync } from "node:fs";
import type { LaunchEvent } from "./protocol-types.ts";
import { startExit, profitSize, sellProgress, flagLeg, type ExitPolicy, type ExitProgress } from "./exits.ts";

export interface LiveIntent {
  operationId: string;
  mint: string;
  venue: "curve" | "pumpswap";
  side: "buy" | "sell";
  tokens: bigint;
  /** Maximum spend for a buy, minimum gross wallet receipts for a sell. */
  limitLamports: bigint;
  expiresAt: number;
  /** Subscribe slot for buy authorization and the minimum RPC context slot. */
  minimumSlot: number;
  creator?: string;
  sourceSignature?: string;
  trigger?: "take_profit" | "stop_loss" | "time_exit" | "TP1" | "TP2" | "TP3";
  exitPolicy?: ExitPolicy;
}

export interface LiveCaps {
  maxWalletLamports: bigint;
  maxEntryLamports: bigint;
  maxExposureLamports: bigint;
  maxNetworkFeeLamports: bigint;
  maxAccountDepositLamports: bigint;
  dailyLossLamports: bigint;
  maxOpenPositions: number;
  maxBroadcasts: number;
}

export interface SignedAttempt {
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  wire: string;
}

export interface Settlement {
  outcome: "filled" | "failed";
  tokenDelta: bigint;
  solDelta: bigint;
  /** Net increase in refundable wallet-owned token account deposits. */
  rentDelta: bigint;
  fee: bigint;
  slot: number;
  filledAt?: number;
}

export interface LiveTransport {
  wallet: string;
  prepare(intent: LiveIntent, caps: LiveCaps): Promise<SignedAttempt>;
  send(attempt: SignedAttempt): Promise<string>;
  inspect(attempt: SignedAttempt, intent: LiveIntent): Promise<
    | { outcome: "valid" | "seen" | "ambiguous" }
    | Settlement
  >;
}

type StoredIntent = Omit<LiveIntent, "tokens" | "limitLamports"> & {
  tokens: string;
  limitLamports: string;
};

export interface LivePosition {
  mint: string;
  tokens: bigint;
  cost: bigint;
  filledAt: number;
  exit?: { policy: ExitPolicy; progress: ExitProgress };
}

function pack(intent: LiveIntent): string {
  return JSON.stringify({
    operationId: intent.operationId, mint: intent.mint, venue: intent.venue, side: intent.side,
    tokens: String(intent.tokens), limitLamports: String(intent.limitLamports), expiresAt: intent.expiresAt,
    minimumSlot: intent.minimumSlot, creator: intent.creator, sourceSignature: intent.sourceSignature, trigger: intent.trigger,
    exitPolicy: intent.exitPolicy,
  });
}

function unpack(json: string): LiveIntent {
  const intent = JSON.parse(json) as StoredIntent;
  return { ...intent, tokens: BigInt(intent.tokens), limitLamports: BigInt(intent.limitLamports) };
}

interface AttemptRow {
  operationId: string;
  mint: string;
  side: "buy" | "sell";
  intent: string;
  signed: string;
  signature: string;
  state: "signed" | "pending" | "ambiguous" | "confirmed" | "failed";
  broadcasts: number;
  detail: string | null;
}

interface PositionRow {
  mint: string;
  tokens: string;
  cost: string;
  filledAt: number;
  exit?: string | null;
}

type Control = "active" | "paused" | "killed";

function readStatus(db: DatabaseSync) {
  const hasLadder = !!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='live_position_exit'").get();
  const rows = hasLadder
    ? db.prepare("SELECT p.*, e.data AS exit FROM live_position p LEFT JOIN live_position_exit e USING(mint) ORDER BY mint").all()
    : db.prepare("SELECT * FROM live_position ORDER BY mint").all();
  return {
    wallet: db.prepare("SELECT wallet FROM live_lock_identity").get()?.wallet ?? null,
    control: readControl(db),
    attempts: db.prepare(`SELECT operationId,mint,side,signature,state,broadcasts,detail,
      json_extract(intent,'$.trigger') AS trigger, json_extract(intent,'$.tokens') AS intendedTokens FROM live_attempt ORDER BY rowid`).all(),
    positions: rows.map(row => ({ ...row, exit: row.exit ? JSON.parse(String(row.exit)) as unknown : undefined })),
    recentSettlements: db.prepare("SELECT * FROM live_settlement ORDER BY slot DESC LIMIT 20").all(),
    lastFinalizedSlot: db.prepare("SELECT MAX(slot) AS slot FROM live_settlement").get()?.slot ?? null,
    feed: db.prepare("SELECT name,value FROM live_runtime ORDER BY name").all()
      .map(row => ({ name: row.name, value: JSON.parse(String(row.value)) as unknown })),
  };
}

function readControl(db: DatabaseSync): Control {
  return db.prepare("SELECT state FROM live_control WHERE singleton=1").get()?.state as Control ?? "paused";
}

export function liveStatus(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return readStatus(db); } finally { db.close(); }
}

export function setLiveControl(dbPath: string, state: Control): Control {
  if (!existsSync(dbPath)) throw new Error("Live execution database is not initialized");
  const db = new DatabaseSync(dbPath, { allowExtension: false, timeout: 1000 });
  try {
    db.prepare("UPDATE live_control SET state=? WHERE singleton=1 AND (state!='killed' OR ?='killed')").run(state, state);
    const current = readControl(db);
    if (current !== state) throw new Error("The live kill switch is latched");
    return current;
  } finally {
    db.close();
  }
}

export class LiveExecutor {
  readonly #db: DatabaseSync;
  readonly #lockPath: string;
  readonly #lock: number;
  readonly #transport: LiveTransport;
  readonly #caps: LiveCaps;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(dbPath: string, transport: LiveTransport, caps: LiveCaps) {
    this.#lockPath = `${dbPath}.writer.lock`;
    this.#lock = openSync(this.#lockPath, "wx", 0o600);
    this.#transport = transport;
    this.#caps = caps;
    let db: DatabaseSync | undefined;
    try {
      writeSync(this.#lock, String(process.pid) + "\n");
      db = new DatabaseSync(dbPath);
      this.#db = db;
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='runs'").get()) {
        throw new Error("Paper database is not a live execution database");
      }
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS live_lock_identity(wallet TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS live_attempt(
          operationId TEXT PRIMARY KEY, mint TEXT NOT NULL, side TEXT NOT NULL,
          intent TEXT NOT NULL, signed TEXT NOT NULL, signature TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL, broadcasts INTEGER NOT NULL DEFAULT 0, detail TEXT
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS live_one_unresolved
          ON live_attempt(mint, side) WHERE state IN ('signed','pending','ambiguous');
        CREATE TABLE IF NOT EXISTS live_position(
          mint TEXT PRIMARY KEY, tokens TEXT NOT NULL, cost TEXT NOT NULL, filledAt INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS live_position_exit(mint TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS live_settlement(
          operationId TEXT PRIMARY KEY, slot INTEGER NOT NULL, settledAt INTEGER NOT NULL,
          result TEXT NOT NULL, tokenDelta TEXT NOT NULL, solDelta TEXT NOT NULL,
          rentDelta TEXT NOT NULL, fee TEXT NOT NULL, realizedPnl TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS live_control(
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          state TEXT NOT NULL CHECK(state IN ('active','paused','killed'))
        ) STRICT;
        INSERT OR IGNORE INTO live_control VALUES(1,'paused');
        CREATE TABLE IF NOT EXISTS live_runtime(name TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS live_decisions(
          id TEXT PRIMARY KEY, atMs INTEGER NOT NULL, evidence TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS live_exit_trigger(mint TEXT PRIMARY KEY, trigger TEXT NOT NULL) STRICT;
      `);
      const identity = db.prepare("SELECT wallet FROM live_lock_identity").get();
      if (identity && identity.wallet !== transport.wallet) throw new Error("Live database belongs to a different wallet");
      if (!identity) db.prepare("INSERT INTO live_lock_identity VALUES(?)").run(transport.wallet);
    } catch (error) {
      db?.close();
      closeSync(this.#lock);
      unlinkSync(this.#lockPath);
      throw error;
    }
  }

  #queued<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(fn);
    this.#tail = task.catch(() => undefined);
    return task;
  }

  positions(): LivePosition[] {
    const rows = this.#db.prepare("SELECT p.*, e.data AS exit FROM live_position p LEFT JOIN live_position_exit e USING(mint) ORDER BY mint")
      .all() as unknown as PositionRow[];
    return rows.map(({ exit, ...row }) => ({ ...row, tokens: BigInt(row.tokens), cost: BigInt(row.cost),
      ...(exit ? { exit: JSON.parse(exit) as LivePosition['exit'] } : {}) }));
  }

  #writeProgress(position: LivePosition): void {
    if (position.exit) this.#db.prepare("INSERT INTO live_position_exit VALUES(?,?) ON CONFLICT(mint) DO UPDATE SET data=excluded.data")
      .run(position.mint, JSON.stringify(position.exit));
  }

  latchTerminal(mint: string, terminal: NonNullable<ExitProgress['terminal']>): void {
    const found = this.positions().find(item => item.mint === mint);
    if (!found?.exit || found.exit.progress.terminal === 'stop_loss') return;
    found.exit.progress.terminal = terminal;
    this.#writeProgress(found);
  }

  status() {
    return readStatus(this.#db);
  }

  control(): Control {
    return readControl(this.#db);
  }

  recordDecision(id: string, evidence: unknown) {
    this.#db.prepare("INSERT OR IGNORE INTO live_decisions VALUES(?,?,?)").run(id, Date.now(), JSON.stringify(evidence));
  }

  runtime(name: string, value: unknown) {
    this.#db.prepare("INSERT INTO live_runtime VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value")
      .run(name, JSON.stringify(value));
  }

  currentRuntime(name: string): unknown {
    const row = this.#db.prepare("SELECT value FROM live_runtime WHERE name=?").get(name);
    return row ? JSON.parse(String(row.value)) as unknown : undefined;
  }

  checkpoint(): number | undefined {
    const slot = this.currentRuntime("checkpoint");
    return typeof slot === "number" ? slot : undefined;
  }

  trigger(mint: string, candidate?: NonNullable<LiveIntent["trigger"]>): LiveIntent["trigger"] {
    if (candidate) this.#db.prepare("INSERT OR IGNORE INTO live_exit_trigger VALUES(?,?)").run(mint, candidate);
    return this.#db.prepare("SELECT trigger FROM live_exit_trigger WHERE mint=?").get(mint)?.trigger as LiveIntent["trigger"];
  }

  hasSourceSignature(signature: string): boolean {
    return !!this.#db.prepare("SELECT 1 FROM live_attempt WHERE json_extract(intent,'$.sourceSignature')=?").get(signature);
  }

  unsettledLaunches(): LaunchEvent[] {
    return this.#db.prepare(
      "SELECT json_extract(d.evidence,'$.launch') AS launch FROM live_decisions d JOIN live_attempt a ON d.id=a.operationId " +
      "WHERE CAST(json_extract(d.evidence,'$.launch.slot') AS INTEGER)>? AND a.side='buy'",
    ).all(this.checkpoint() ?? 0).map(row => JSON.parse(String(row.launch)) as LaunchEvent);
  }

  mayPlanExit(mint: string, minimumTimeMs: number, maxAttempts: number, trigger?: LiveIntent['trigger']): boolean {
    const summary = this.#db.prepare(
      "SELECT count(*) AS attempts, max(expiresAt) AS lastExpiry FROM " +
      "(SELECT CAST(json_extract(intent,'$.expiresAt') AS INTEGER) AS expiresAt FROM live_attempt WHERE mint=? AND side='sell' " +
      "AND (? IS NULL OR json_extract(intent,'$.trigger')=?))",
    ).get(mint, trigger ?? null, trigger ?? null);
    return Number(summary?.attempts ?? 0) < maxAttempts && Number(summary?.lastExpiry ?? 0) < minimumTimeMs &&
      !this.#unresolved().some(row => row.mint === mint);
  }

  #attempt(id: string): AttemptRow | undefined {
    return this.#db.prepare("SELECT * FROM live_attempt WHERE operationId=?").get(id) as unknown as AttemptRow | undefined;
  }

  #unresolved(): AttemptRow[] {
    return this.#db.prepare("SELECT * FROM live_attempt WHERE state IN ('signed','pending','ambiguous') ORDER BY rowid")
      .all() as unknown as AttemptRow[];
  }

  #state(id: string, state: AttemptRow["state"], detail: string | null = null): void {
    this.#db.prepare("UPDATE live_attempt SET state=?, detail=? WHERE operationId=?").run(state, detail, id);
  }

  execute(intent: LiveIntent, mayBuy: (intent: LiveIntent) => boolean): Promise<AttemptRow["state"]> {
    return this.#queued(async () => {
      const previous = this.#attempt(intent.operationId);
      const serialized = pack(intent);
      if (previous) {
        if (previous.intent !== serialized) throw new Error("Live operation ID reused for a different intent");
        return previous.state;
      }
      const u64Max = (1n << 64n) - 1n;
      if (!intent.operationId || intent.tokens <= 0n || intent.tokens > u64Max ||
          intent.limitLamports <= 0n || intent.limitLamports > u64Max ||
          !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= Date.now() ||
          !Number.isSafeInteger(intent.minimumSlot) || intent.minimumSlot < 0) {
        throw new Error("Invalid or expired live intent");
      }
      const pending = this.#unresolved();
      if (pending.some(row => row.mint === intent.mint)) throw new Error("Unresolved live attempt for this mint");
      const positions = this.positions();
      const owned = positions.find(p => p.mint === intent.mint);
      if (intent.side === "sell") {
        if (!owned) throw new Error("Sell requires a confirmed position");
        const partial = intent.trigger === 'TP1' || intent.trigger === 'TP2' || intent.trigger === 'TP3';
        if (partial && (!owned.exit || owned.exit.progress.terminal ||
            profitSize(owned.exit.policy, owned.exit.progress, owned.tokens, intent.trigger!) !== intent.tokens)) {
          throw new Error("Sell does not match the active take-profit leg");
        }
        if (!partial && owned.tokens !== intent.tokens) throw new Error("Terminal sale must match the entire recorded live position");
      } else {
        if (pending.length) throw new Error("Unresolved live submission blocks new entries");
        if (this.control() !== "active" || !mayBuy(intent)) throw new Error("Entries paused");
        if (owned || this.#db.prepare("SELECT 1 FROM live_settlement s JOIN live_attempt a USING(operationId) WHERE a.mint=? AND a.side='buy' AND s.result='filled'").get(intent.mint)) {
          throw new Error("One filled live entry per mint");
        }
        const worstCost = intent.limitLamports + this.#caps.maxNetworkFeeLamports + this.#caps.maxAccountDepositLamports;
        const exposure = positions.reduce((sum, p) => sum + p.cost, 0n);
        if (worstCost > this.#caps.maxEntryLamports || exposure + worstCost > this.#caps.maxExposureLamports ||
            positions.length >= this.#caps.maxOpenPositions) {
          throw new Error("Live entry or exposure cap exceeded");
        }
        const utcMidnight = new Date();
        utcMidnight.setUTCHours(0, 0, 0, 0);
        const settled = this.#db.prepare("SELECT realizedPnl FROM live_settlement WHERE settledAt>=?").all(utcMidnight.getTime());
        const realized = settled.reduce((sum, row) => sum + BigInt(String(row.realizedPnl)), 0n);
        if (exposure - realized + worstCost > this.#caps.dailyLossLamports) throw new Error("Live daily loss limit reached");
      }
      const signed = await this.#transport.prepare(intent, this.#caps);
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.prepare("INSERT INTO live_attempt(operationId,mint,side,intent,signed,signature,state) VALUES(?,?,?,?,?,?,'signed')")
          .run(intent.operationId, intent.mint, intent.side, serialized, JSON.stringify(signed), signed.signature);
        if (intent.side === 'sell' && owned?.exit && intent.trigger) {
          flagLeg(owned.exit.progress, intent.trigger, 'pending', intent.operationId);
          this.#writeProgress(owned);
        }
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
      if (intent.expiresAt <= Date.now() || (intent.side === "buy" && (this.control() !== "active" || !mayBuy(intent)))) {
        this.#state(intent.operationId, "failed", "signed_but_never_submitted");
        if (intent.side === 'sell' && owned?.exit && intent.trigger) {
          flagLeg(owned.exit.progress, intent.trigger, 'failed', intent.operationId);
          this.#writeProgress(owned);
        }
        return "failed";
      }
      return this.#broadcast(this.#attempt(intent.operationId)!, signed);
    });
  }

  async #broadcast(row: AttemptRow, signed: SignedAttempt): Promise<AttemptRow["state"]> {
    this.#db.prepare("UPDATE live_attempt SET state='pending', broadcasts=broadcasts+1 WHERE operationId=?").run(row.operationId);
    try {
      const signature = await this.#transport.send(signed);
      if (signature !== signed.signature) throw new Error("RPC signature mismatch");
      this.#state(row.operationId, "pending", "acknowledged");
      return "pending";
    } catch {
      this.#state(row.operationId, "ambiguous", "submission_outcome_unknown");
      return "ambiguous";
    }
  }

  recover(mayBuy: (intent: LiveIntent) => boolean): Promise<void> {
    return this.#queued(async () => {
      for (const row of this.#unresolved()) {
        const signed = JSON.parse(row.signed) as SignedAttempt;
        const intent = unpack(row.intent);
        const position = intent.side === 'sell' && intent.trigger?.startsWith('TP')
          ? this.positions().find(item => item.mint === intent.mint) : undefined;
        const superseded = !!position?.exit?.progress.terminal;
        if (row.broadcasts === 0 && (intent.expiresAt <= Date.now() || superseded)) {
          this.#state(row.operationId, "failed", "signed_but_never_submitted");
          if (position?.exit && intent.trigger) {
            flagLeg(position.exit.progress, intent.trigger, 'failed', intent.operationId);
            this.#writeProgress(position);
          }
          continue;
        }
        try {
          const result = await this.#transport.inspect(signed, intent);
          if (result.outcome === "filled" || result.outcome === "failed") this.#settle(row, intent, result);
          else if (!superseded && result.outcome === "valid" && row.broadcasts < this.#caps.maxBroadcasts &&
              Date.now() < intent.expiresAt && (intent.side === "sell" || (this.control() === "active" && mayBuy(intent)))) {
            await this.#broadcast(row, signed);
          } else if (result.outcome === "ambiguous") {
            this.#state(row.operationId, "ambiguous", "finalized_execution_cannot_be_established");
          }
        } catch {
          this.#state(row.operationId, "ambiguous", "reconciliation_unavailable");
        }
      }
    });
  }

  #settle(row: AttemptRow, intent: LiveIntent, result: Settlement): void {
    const { outcome, tokenDelta, solDelta, rentDelta, fee, slot } = result;
    let realized = 0n;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (fee < 0n || fee > this.#caps.maxNetworkFeeLamports) throw new Error("Unexpected finalized transaction fee");
      if (outcome === "failed") {
        if (tokenDelta !== 0n || rentDelta !== 0n || solDelta !== -fee) throw new Error("Unexpected failed settlement deltas");
        realized = -fee;
        const position = intent.side === 'sell' ? this.positions().find(pos => pos.mint === intent.mint) : undefined;
        if (position?.exit) {
          const progress = position.exit.progress;
          progress.failedFeesLamports = String(BigInt(progress.failedFeesLamports) + fee);
          if (intent.trigger) flagLeg(progress, intent.trigger, 'failed', intent.operationId);
          this.#writeProgress(position);
        }
      } else if (intent.side === "buy") {
        const cost = -solDelta - rentDelta;
        if (tokenDelta !== intent.tokens || rentDelta < 0n || rentDelta > this.#caps.maxAccountDepositLamports ||
            cost <= 0n || cost > intent.limitLamports + fee) {
          throw new Error("Unexpected finalized buy balance changes");
        }
        this.#db.prepare("INSERT INTO live_position VALUES(?,?,?,?)")
          .run(intent.mint, String(tokenDelta), String(cost), result.filledAt ?? Date.now());
        if (intent.exitPolicy) this.#writeProgress({ mint: intent.mint, tokens: tokenDelta, cost, filledAt: result.filledAt ?? Date.now(),
          exit: { policy: intent.exitPolicy, progress: startExit(intent.exitPolicy, String(tokenDelta), String(cost)) } });
      } else {
        const position = this.positions().find(pos => pos.mint === intent.mint);
        const proceeds = solDelta + rentDelta;
        if (!position || position.tokens < -tokenDelta || tokenDelta !== -intent.tokens ||
            proceeds < intent.limitLamports - fee) {
          throw new Error("Unexpected finalized sell balance changes");
        }
        const remaining = position.tokens + tokenDelta;
        if (position.exit) sellProgress(position.exit.progress, intent.trigger ?? 'terminal', -tokenDelta, proceeds, row.operationId);
        if (remaining === 0n) {
          realized = proceeds - position.cost;
          this.#db.prepare("DELETE FROM live_position WHERE mint=?").run(intent.mint);
          if (position.exit) this.#writeProgress(position);
        } else {
          if (!position.exit) throw new Error("Partial settlement has no persisted exit policy");
          const initial = BigInt(position.exit.progress.entryCostLamports);
          const original = BigInt(position.exit.progress.originalTokens);
          const remainingCost = initial - initial * (original - remaining) / original;
          realized = proceeds - (position.cost - remainingCost);
          this.#db.prepare("UPDATE live_position SET tokens=?,cost=? WHERE mint=?").run(String(remaining), String(remainingCost), intent.mint);
          this.#writeProgress(position);
        }
      }
      this.#db.prepare("INSERT INTO live_settlement VALUES(?,?,?,?,?,?,?,?,?)").run(
        row.operationId, slot, result.filledAt ?? Date.now(), outcome, String(tokenDelta), String(solDelta), String(rentDelta), String(fee), String(realized));
      this.#state(row.operationId, outcome === "filled" ? "confirmed" : "failed",
        outcome === "failed" ? "on_chain_failure" : null);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#tail;
    this.#db.close();
    closeSync(this.#lock);
    unlinkSync(this.#lockPath);
  }
}
