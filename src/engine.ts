import { Ledger, type Checkpoint, type JournalEvent } from './ledger.ts';
import { SOL_MINT, type LaunchEvent, type NormalizedEvent, type ProtocolEvent, type Reserves, type Venue } from './protocol-types.ts';
import { afterFill, exitTrigger, minAfterSlippage, quoteBuy, quoteSell, type Quote } from './strategy.ts';
import { startExit, terminalExit, profitExit, sellProgress, flagLeg, type ExitPolicy, type ExitProgress } from './exits.ts';
import { earlyTrade, opportunity, type BalanceEvidence, type EarlyTrade, type RiskPolicy } from './risk.ts';
import { scoreModel, strategyFingerprint, type Model } from './model.ts';
import { trackerAsOf, type TrackerSnapshot } from './tracker.ts';

export interface PaperSettings {
  startingLamports: string;
  spendLamports: string;
  maxExposureLamports: string;
  dailyLossLamports: string;
  networkFeeLamports: string;
  priorityFeeLamports: string;
  failedFeeLamports: string;
  tokenAccountRentLamports?: string;
  tipLamports?: string;
  maxOpenPositions: number;
  takeProfitBps: number;
  stopLossBps: number;
  timeExitMs: number;
  maxLaunchAgeMs: number;
  maxStateAgeMs: number;
  entryImpactBps: number;
  exitImpactBps: number;
  slippageBps: number;
  maxVenueFeeBps: number;
  maxAttempts: number;
  retryDelayMs: number;
  delayMs: { detection: number; decision: number; submission: number; landing: number };
  minCreatorHistorySamples?: number;
  minCreatorHistoryCoverageBps?: number;
  minCreatorHistoryReturnBps?: number;
  minCreatorInitialBuyLamports?: string;
  maxConcentrationBps?: number;
  exits?: ExitPolicy;
  riskPolicy?: RiskPolicy;
}

export interface IdentityVerdict {
  eligible: boolean;
  reason: string;
  alias?: string;
  authorization?: unknown;
}

type VerifyCreator = (launch: LaunchEvent, decisionAtMs: number, chainAtMs: number) => IdentityVerdict;

interface Market {
  event: ProtocolEvent;
  venue: Venue;
  offset?: ReserveDelta;
  ambiguous: boolean;
}

type ReserveKey = 'virtualToken' | 'virtualSol' | 'realToken' | 'realSol';
type ReserveDelta = Record<ReserveKey, string>;
const reserveKeys: readonly ReserveKey[] = ['virtualToken', 'virtualSol', 'realToken', 'realSol'];

export interface Position {
  mint: string;
  creator: string;
  alias?: string;
  tokens: string;
  costLamports: string;
  rentLamports: string;
  entryAtMs: number;
  entryVenue: Venue;
  signature: string;
  markLamports: string;
  attempts: number;
  nextRetryAtMs?: number;
  trigger?: { reason: string; atMs: number };
  unresolved?: string;
  exit?: ExitProgress;
  exitAttempts?: Record<string, number>;
}

export interface Outcome {
  mint: string;
  creator: string;
  alias?: string;
  realizedAtMs: number;
  pnlLamports: string;
  costLamports: string;
  proceedsLamports: string;
  exit?: ExitProgress;
  exitReason?: string;
}

interface Candidate {
  launch: LaunchEvent;
  atMs: number;
  early?: EarlyTrade[];
  balances?: BalanceEvidence[];
  incomplete?: boolean;
}

interface LaunchObservation {
  signature: string;
  creator: string;
  receivedAtMs: number;
  supported: boolean;
  slot?: number;
  identityAuthorized?: boolean;
  late: boolean;
  initialBuyLamports?: string;
  sellLamports?: string;
  sellObservations?: number;
  rolledBack?: boolean;
}

interface Order {
  id: string;
  mint: string;
  side: 'buy' | 'sell';
  atMs: number;
  phase: 'submit' | 'land';
  venue: Venue;
  minimum: string;
  reason: string;
  candidate?: Candidate;
  alias?: string;
  sellTokens?: string;
}

export interface PaperState {
  now: number;
  balanceLamports: string;
  equityLamports: string;
  dailyReferenceLamports: string;
  day: number;
  feedHealthy: boolean;
  lastFeedAtMs?: number;
  lastFeedSignalAtMs?: number;
  lastSlot?: number;
  market: Record<string, Market>;
  launches: Record<string, LaunchObservation>;
  entered: string[];
  positions: Record<string, Position>;
  outcomes: Outcome[];
  candidates: Record<string, Candidate>;
  orders: Record<string, Order>;
}

type SuccessfulQuote = Extract<Quote, { ok: true }>;
type VenueQuote = { quote: SuccessfulQuote; state: Reserves; venue: Venue } | { reason: string };

function eventKey(event: NormalizedEvent): string {
  if (event.kind === 'feed') return JSON.stringify(['feed', event.provider, event.receivedAtMs, event.slot, event.healthy, event.reason]);
  return JSON.stringify([event.signature, event.instructionPath, event.kind, event.commitment, event.slot, event.blockhash]);
}

function orderOf(next: ProtocolEvent, prior: ProtocolEvent): number | undefined {
  if (next.slot !== prior.slot) return next.slot - prior.slot;
  if (next.signature !== prior.signature) {
    if (next.transactionIndex === undefined || prior.transactionIndex === undefined || next.transactionIndex === prior.transactionIndex) return;
    return next.transactionIndex - prior.transactionIndex;
  }
  const count = Math.min(next.instructionPath.length, prior.instructionPath.length);
  for (let i = 0; i < count; i++) {
    const difference = next.instructionPath[i]! - prior.instructionPath[i]!;
    if (difference !== 0) return difference;
  }
  return next.instructionPath.length - prior.instructionPath.length;
}

function quoteData(quote: SuccessfulQuote): Record<string, string | number> {
  return {
    grossLamports: String(quote.grossSol), venueFeeLamports: String(quote.venueFee), netLamports: String(quote.netSol),
    tokens: String(quote.tokens), impactBps: quote.impactBps,
  };
}

export class PaperEngine {
  readonly id: string;
  readonly #mode: 'replay' | 'paper';
  readonly #ledger: Ledger;
  readonly #settings: PaperSettings;
  readonly #verify: VerifyCreator;
  readonly #verifyHistory: VerifyCreator;
  readonly #creatorHistory: readonly Outcome[] | undefined;
  readonly #executionFee: bigint;
  readonly #rent: bigint;
  readonly #model: Model | undefined;
  readonly #modelHash: string;
  readonly #gateModel: boolean;
  readonly #enrichment: ((mint: string) => TrackerSnapshot | undefined) | undefined;
  readonly #wallClock: (() => number) | undefined;
  #state: PaperState;
  #revision: number;
  #journal: JournalEvent[] = [];
  #controlScope: string;

  constructor(options: {
    id: string;
    ledger: Ledger;
    mode: 'replay' | 'paper';
    settings: PaperSettings;
    verifyCreator: VerifyCreator;
    verifyHistory?: VerifyCreator;
    policyProvenance?: unknown;
    controlScope?: string;
    creatorHistory?: readonly Outcome[];
    shadowModel?: Model;
    evaluateModelGate?: boolean;
    enrichment?: (mint: string) => TrackerSnapshot | undefined;
    wallClock?: () => number;
  }) {
    this.id = options.id;
    this.#mode = options.mode;
    this.#ledger = options.ledger;
    this.#settings = options.settings;
    this.#controlScope = options.controlScope ?? 'paper';
    this.#verify = options.verifyCreator;
    this.#verifyHistory = options.verifyHistory ?? options.verifyCreator;
    this.#creatorHistory = options.creatorHistory;
    this.#model = options.shadowModel;
    this.#modelHash = strategyFingerprint(options.settings);
    this.#gateModel = options.mode === 'replay' && options.evaluateModelGate === true;
    this.#enrichment = options.enrichment;
    this.#wallClock = options.mode === 'paper' ? options.wallClock : undefined;
    this.#executionFee = BigInt(options.settings.networkFeeLamports) +
      BigInt(options.settings.priorityFeeLamports) + BigInt(options.settings.tipLamports ?? '0');
    this.#rent = BigInt(options.settings.tokenAccountRentLamports ?? '0');
    const initial: PaperState = {
      now: 0, balanceLamports: options.settings.startingLamports, equityLamports: options.settings.startingLamports,
      dailyReferenceLamports: options.settings.startingLamports, day: -1, feedHealthy: options.mode === 'replay',
      market: {}, launches: {}, entered: [], positions: {}, outcomes: [], candidates: {}, orders: {},
    };
    const snapshot = this.#ledger.initialize(this.id, options.mode, {
      engineVersion: 1, ...options.settings, ...(options.policyProvenance === undefined ? {} : { policy: options.policyProvenance }),
    }, initial);
    this.#state = snapshot.state;
    this.#revision = snapshot.revision;
  }

  get state(): PaperState {
    return structuredClone(this.#state);
  }

  accept(event: NormalizedEvent, raw?: unknown, checkpoint?: { name: string; point: Checkpoint }): void {
    const key = eventKey(event);
    const receiptAndHydration = event.receivedAtMs + (event.kind !== 'feed' &&
      (this.#mode === 'paper' || event.sourceTiming === 'confirmed_block' || event.sourceTiming === 'executed_transaction')
      ? event.hydrationMs ?? 0 : 0);
    const now = Math.max(this.#state.now, receiptAndHydration);
    this.#advance(now, false);
    if (this.#ledger.hasEvent(this.id, key)) {
      this.#record('duplicate', { kind: event.kind, key });
      this.#mark();
      this.#commit(undefined, checkpoint);
      return;
    }
    if (this.#mode === 'replay' && receiptAndHydration < now && event.kind === 'launch' && !event.sourceTiming) {
      event = { ...event, late: true };
    }
    const otherCommitment = event.kind === 'feed' || event.kind === 'status' ? undefined
      : event.commitment === 'confirmed' ? 'finalized' : event.commitment === 'finalized' ? 'confirmed' : undefined;
    if (otherCommitment && event.kind !== 'feed' && this.#ledger.hasEvent(this.id, eventKey({ ...event, commitment: otherCommitment }))) {
      this.#record('finality', { status: event.commitment, signature: event.signature, slot: event.slot }, event.mint);
    } else {
      this.#update(event);
    }
    this.#mark();
    this.#commit({ key, receivedAtMs: event.receivedAtMs, normalized: event, raw }, checkpoint);
  }

  advance(toMs: number): void {
    if (!Number.isSafeInteger(toMs)) throw new Error('Invalid clock timestamp');
    this.#advance(Math.max(toMs, this.#state.now), true);
    this.#mark();
    this.#commit();
  }

  finish(): PaperState {
    this.advance(this.#state.now);
    return this.state;
  }

  #commit(event?: Parameters<Ledger['save']>[0]['event'], checkpoint?: { name: string; point: Checkpoint }): void {
    try {
      this.#ledger.save({ id: this.id, revision: this.#revision, state: this.#state, journal: this.#journal,
        ...(event ? { event } : {}), ...(checkpoint ? { checkpoint } : {}) });
      this.#revision++;
    } catch (error) {
      const snapshot = this.#ledger.run<PaperState>(this.id);
      this.#state = snapshot.state;
      this.#revision = snapshot.revision;
      throw error;
    } finally {
      this.#journal = [];
    }
  }

  #record(kind: string, data: unknown, mint?: string, operationId?: string): void {
    this.#journal.push({
      kind, atMs: this.#state.now, data, ...(mint ? { mint } : {}), ...(operationId ? { operationId } : {}),
    });
  }

  #update(event: NormalizedEvent): void {
    const state = this.#state;
    if (event.kind === 'feed') {
      if (event.receivedAtMs < (state.lastFeedSignalAtMs ?? 0)) return;
      state.feedHealthy = event.healthy;
      if (event.healthy && event.reason === 'archive_slot_complete' && event.slot !== undefined) {
        state.lastSlot = Math.max(state.lastSlot ?? 0, event.slot);
      }
      if (!event.healthy) for (const candidate of Object.values(state.candidates)) candidate.incomplete = true;
      state.lastFeedSignalAtMs = event.receivedAtMs;
      if (event.healthy) state.lastFeedAtMs = Math.max(state.lastFeedAtMs ?? 0, event.receivedAtMs);
      this.#record('feed', { healthy: event.healthy, reason: event.reason, slot: event.slot });
      return;
    }
    if (event.kind === 'status' || event.commitment === 'rolled_back' || event.commitment === 'observed') {
      this.#record('finality', { status: event.commitment, signature: event.signature, slot: event.slot }, event.mint);
      if (event.commitment !== 'rolled_back') return;
      state.feedHealthy = false;
      state.lastFeedSignalAtMs = Math.max(state.lastFeedSignalAtMs ?? 0, event.receivedAtMs);
      for (const market of Object.values(state.market)) {
        if (market.event.signature === event.signature) market.ambiguous = true;
      }
      for (const [mint, candidate] of Object.entries(state.candidates)) {
        if (candidate.early?.some(trade => trade.signature === event.signature) ||
            candidate.balances?.some(row => row.signature === event.signature)) {
          candidate.incomplete = true;
          candidate.early = candidate.early?.filter(trade => trade.signature !== event.signature);
          candidate.balances = candidate.balances?.filter(row => row.signature !== event.signature);
        }
        if (candidate.launch.signature !== event.signature) continue;
        delete state.candidates[mint];
        this.#considerEntry(candidate, 'rolled_back_launch');
      }
      for (const [key, order] of Object.entries(state.orders)) {
        if (order.side === 'buy' && order.candidate?.launch.signature === event.signature) {
          this.#fail(key, order, 'rolled_back_launch', false);
        }
      }
      for (const position of Object.values(state.positions)) {
        if (position.signature === event.signature) position.unresolved = 'rolled_back_launch_after_modeled_fill';
      }
      for (const launch of Object.values(state.launches)) {
        if (launch.signature === event.signature) launch.rolledBack = true;
      }
      for (const outcome of state.outcomes) {
        if (state.launches[outcome.mint]?.signature === event.signature) {
          this.#record('fork_tainted_outcome', { reason: 'rolled_back_launch_after_closed_position' }, outcome.mint);
        }
      }
      return;
    }
    state.lastSlot = Math.max(state.lastSlot ?? 0, event.slot, event.observedHeadSlot ?? 0);
    if (!event.late) state.lastFeedAtMs = Math.max(state.lastFeedAtMs ?? 0, event.receivedAtMs);
    if (event.kind === 'launch' && state.launches[event.mint] === undefined) {
      state.launches[event.mint] = {
        signature: event.signature, creator: event.creator, supported: event.supported && event.quoteMint === SOL_MINT,
        receivedAtMs: event.receivedAtMs, late: event.late === true, slot: event.slot,
        identityAuthorized: this.#verifyHistory(event, state.now, event.blockTimeMs ?? event.receivedAtMs).eligible,
        ...(event.creatorInitialBuyLamports !== undefined ? { initialBuyLamports: event.creatorInitialBuyLamports } : {}),
      };
      this.#record('launch', {
        creator: event.creator, supported: event.supported, quoteMint: event.quoteMint,
        concentrationBps: event.concentrationBps ?? null, linkedWalletExposureBps: event.linkedWalletExposureBps ?? null,
        receiptMs: event.receivedAtMs, hydrationMs: event.hydrationMs, late: event.late === true, slot: event.slot,
        signature: event.signature, sourceTiming: event.sourceTiming,
      }, event.mint);
      state.candidates[event.mint] = { launch: event, atMs: state.now + this.#settings.delayMs.detection + this.#settings.delayMs.decision,
        early: [], balances: [], incomplete: !state.feedHealthy || event.late === true };
    }
    if (event.quoteMint !== SOL_MINT || (event.kind === 'launch' ? !event.supported : !event.canonical)) return;
    const buyerEvidence = state.candidates[event.mint];
    if (buyerEvidence && event.kind !== 'migration' && event.ownerBalances?.length && !event.late) {
      const observed = buyerEvidence.balances ??= [];
      if (observed.length + event.ownerBalances.length > 512) buyerEvidence.incomplete = true;
      else for (const row of event.ownerBalances) observed.push({ ...row, signature: event.signature, availableAtMs: state.now });
    }
    if (event.kind === 'trade' && state.candidates[event.mint]) {
      const candidate = state.candidates[event.mint]!;
      const trade = earlyTrade(event, state.now);
      if (event.late || (candidate.early?.length ?? 0) >= 256) candidate.incomplete = true;
      else if (trade) (candidate.early ??= []).push(trade);
    }
    if (event.kind === 'trade' && !event.late && event.quoteAmount !== undefined && /^\d+$/.test(event.quoteAmount)) {
      const launch = state.launches[event.mint];
      if (launch && !launch.rolledBack && event.trader === launch.creator) {
        if (event.side === 'buy' && event.signature === launch.signature && launch.initialBuyLamports === undefined) {
          launch.initialBuyLamports = event.quoteAmount;
        } else if (event.side === 'sell') {
          launch.sellLamports = String(BigInt(launch.sellLamports ?? 0) + BigInt(event.quoteAmount));
          launch.sellObservations = (launch.sellObservations ?? 0) + 1;
        }
      }
    }
    const venue = event.kind === 'launch' ? 'curve' : event.kind === 'migration' ? 'pumpswap' : event.venue;
    const market = state.market[event.mint];
    if (market) {
      if (market.event.slot === event.slot && market.event.blockhash && event.blockhash && market.event.blockhash !== event.blockhash) {
        market.ambiguous = true;
        this.#record('market_unknown', { reason: 'fork_identity_conflict' }, event.mint);
        return;
      }
      const order = orderOf(event, market.event);
      if (order === undefined) {
        market.ambiguous = true;
        this.#record('market_unknown', { reason: 'transaction_order_unknown' }, event.mint);
        return;
      }
      if (order < 0) {
        this.#record('market_reordered', { observedSlot: event.slot, currentSlot: market.event.slot }, event.mint);
        return;
      }
      if (order === 0 || (market.venue === 'pumpswap' && venue === 'curve')) return;
    }
    state.market[event.mint] = {
      event, venue, ambiguous: event.late === true,
      ...(market?.venue === venue && market.offset ? { offset: market.offset } : {}),
    };
    if (event.kind === 'migration') this.#record('migration', { venue, hasReserves: event.reserves !== undefined }, event.mint);
  }

  #setClock(atMs: number): void {
    const day = Math.floor(atMs / 86_400_000);
    if (this.#state.day !== day) {
      this.#state.day = day;
      this.#state.dailyReferenceLamports = this.#state.equityLamports;
    }
    this.#state.now = atMs;
  }

  #advance(target: number, inclusive: boolean): void {
    const state = this.#state;
    let next = this.#nextAt();
    while (next < target || (inclusive && next === target)) {
      this.#setClock(next);
      this.#mark();
      this.#step();
      next = this.#nextAt();
    }
    this.#setClock(target);
    for (const [mint, market] of Object.entries(state.market)) {
      if (target - market.event.receivedAtMs > this.#settings.maxStateAgeMs && !state.positions[mint] && !state.candidates[mint] &&
        !state.orders[this.#orderKey(mint, 'buy')]) delete state.market[mint];
    }
  }

  #nextAt(): number {
    let next = Infinity;
    for (const candidate of Object.values(this.#state.candidates)) {
      if (this.#decisionSlotReady(candidate)) next = Math.min(next, candidate.atMs);
      else next = Math.min(next, candidate.launch.receivedAtMs + this.#settings.maxLaunchAgeMs + 1);
    }
    for (const order of Object.values(this.#state.orders)) next = Math.min(next, order.atMs);
    for (const [mint, position] of Object.entries(this.#state.positions)) {
      if (this.#state.orders[this.#orderKey(mint, 'sell')] || position.unresolved === 'rolled_back_launch_after_modeled_fill') continue;
      if (this.#settings.exits && position.exit) {
        if (position.nextRetryAtMs !== undefined && position.nextRetryAtMs > this.#state.now) {
          next = Math.min(next, position.nextRetryAtMs);
        } else if (this.#ladderQuote(position)) {
          next = Math.min(next, this.#state.now);
        } else if (!position.exit.terminal) {
          const deadline = position.entryAtMs + this.#settings.timeExitMs;
          if (deadline > this.#state.now) next = Math.min(next, deadline);
        }
        continue;
      }
      if (position.nextRetryAtMs !== undefined) {
        next = Math.min(next, position.nextRetryAtMs);
      } else if (!position.trigger) {
        const quote = this.#venueQuote(position.mint, 'sell', BigInt(position.tokens));
        const net = 'quote' in quote ? quote.quote.netSol : undefined;
        const elapsed = this.#state.now - position.entryAtMs;
        next = Math.min(next, exitTrigger(net, BigInt(position.costLamports), elapsed, this.#settings)
          ? this.#state.now : position.entryAtMs + this.#settings.timeExitMs);
      } else if (position.attempts < this.#settings.maxAttempts &&
        'quote' in this.#venueQuote(position.mint, 'sell', BigInt(position.tokens))) {
        next = Math.min(next, this.#state.now);
      }
    }
    return Math.max(next, this.#state.now);
  }

  #step(): void {
    const state = this.#state;
    for (const [key, order] of Object.entries(state.orders)) {
      if (order.atMs > state.now) continue;
      if (order.phase === 'submit') this.#submit(key, order);
      else this.#land(key, order);
    }
    this.#mark();
    for (const [mint, position] of Object.entries(state.positions)) {
      if (!state.orders[this.#orderKey(mint, 'sell')]) this.#considerExit(position);
    }
    for (const [mint, candidate] of Object.entries(state.candidates)) {
      const ready = this.#decisionSlotReady(candidate);
      if (ready && candidate.atMs > state.now) continue;
      if (!ready && state.now - candidate.launch.receivedAtMs <= this.#settings.maxLaunchAgeMs) continue;
      delete state.candidates[mint];
      this.#considerEntry(candidate, ready ? undefined : 'confirmed_slot_not_available_before_deadline');
    }
  }

  #decisionSlotReady(candidate: Candidate): boolean {
    const launch = candidate.launch;
    const ordered = launch.sourceTiming === 'confirmed_block' || launch.sourceTiming === 'historical_block' ||
      (launch.sourceTiming === undefined && launch.provider !== 'recorded-synthetic' &&
        launch.blockhash !== undefined && launch.transactionIndex !== undefined);
    return this.#mode !== 'replay' || !ordered || (this.#state.lastSlot ?? 0) > launch.slot;
  }

  #reserves(mint: string, venueState: Market): Reserves | undefined {
    const { event, ambiguous, offset } = venueState;
    const now = Math.max(this.#state.now, this.#wallClock?.() ?? this.#state.now);
    if (ambiguous || !event.reserves || now - event.receivedAtMs > this.#settings.maxStateAgeMs) return;
    const reserves = { ...event.reserves };
    if (reserveKeys.some((key) => !/^\d+$/.test(reserves[key]))) {
      this.#record('market_unknown', { reason: 'invalid_reserves' }, mint);
      return;
    }
    if (offset) {
      for (const key of reserveKeys) {
        reserves[key] = String(BigInt(reserves[key]) + BigInt(offset[key]));
      }
    }
    return reserves;
  }

  #venueQuote(mint: string, side: 'buy' | 'sell', amount: bigint): VenueQuote {
    if (!this.#state.feedHealthy) return { reason: 'feed_unhealthy' };
    const market = this.#state.market[mint];
    const state = market && this.#reserves(mint, market);
    if (!market || !state) return { reason: 'venue_state_missing_or_stale' };
    const limits = {
      impactBps: side === 'buy' ? this.#settings.entryImpactBps : this.#settings.exitImpactBps,
      maxVenueFeeBps: this.#settings.maxVenueFeeBps, executionFee: this.#executionFee,
    };
    const quote = side === 'buy' ? quoteBuy(amount, state, limits) : quoteSell(amount, state, limits);
    return quote.ok ? { quote, state, venue: market.venue } : { reason: quote.reason };
  }

  #entryRisk(candidate: Candidate, order?: Order): string | undefined {
    const state = this.#state;
    const { launch } = candidate;
    const settings = this.#settings;
    const now = Math.max(state.now, this.#wallClock?.() ?? state.now);
    if (launch.late || now - (launch.blockTimeMs ?? launch.receivedAtMs) > settings.maxLaunchAgeMs) return 'stale_launch';
    if (!launch.supported || launch.quoteMint !== SOL_MINT) return launch.unsupportedReason ?? 'unsupported_launch';
    if (state.entered.includes(launch.mint)) return 'mint_already_entered';
    if (!state.feedHealthy ||
      (this.#mode === 'paper' && now - (state.lastFeedAtMs ?? 0) > settings.maxStateAgeMs)) return 'feed_unhealthy_or_stale';
    if (this.#mode === 'paper' && this.#ledger.control(this.#controlScope) !== 'active') return 'entries_disabled';
    if (BigInt(state.dailyReferenceLamports) - BigInt(state.equityLamports) >= BigInt(settings.dailyLossLamports)) return 'daily_loss_halt';
    const held = Object.values(state.positions);
    const buying = Object.values(state.orders).filter((item) => item.side === 'buy' && item.id !== order?.id);
    if (held.length + buying.length >= settings.maxOpenPositions) return 'position_limit';
    const buyBudget = BigInt(settings.spendLamports) + this.#executionFee;
    const positionBudget = buyBudget + this.#rent;
    const reserved = BigInt(buying.length) * positionBudget;
    const exposure = held.reduce((sum, position) => sum + BigInt(position.costLamports) + BigInt(position.rentLamports), 0n) + reserved;
    if (exposure + positionBudget > BigInt(settings.maxExposureLamports)) return 'exposure_limit';
    if (BigInt(state.balanceLamports) - reserved < buyBudget + this.#rent) return 'insufficient_paper_balance';
  }

  #history(launch: LaunchEvent) {
    const state = this.#state;
    const maturedBefore = state.now - this.#settings.timeExitMs;
    const earlier = Object.entries(state.launches).filter(([mint, item]) =>
      item.creator === launch.creator && mint !== launch.mint && (item.slot === undefined ? item.receivedAtMs < launch.receivedAtMs : item.slot < launch.slot)
      && item.identityAuthorized === true && !item.late && !item.rolledBack && item.supported);
    const prior = earlier.filter(([, item]) => item.receivedAtMs <= maturedBefore);
    const mints = new Set(prior.map(([mint]) => mint));
    const outcomes = (this.#creatorHistory ?? state.outcomes).filter((item) => mints.has(item.mint) && item.realizedAtMs < state.now);
    const totalCost = outcomes.reduce((sum, item) => sum + BigInt(item.costLamports), 0n);
    const pnl = outcomes.reduce((sum, item) => sum + BigInt(item.pnlLamports), 0n);
    return {
      priorLaunches: earlier.length, sampleSize: outcomes.length, maturedLaunches: prior.length,
      coverageBps: prior.length ? Math.floor(outcomes.length * 10_000 / prior.length) : 0,
      modeledPnlLamports: String(pnl), returnBps: totalCost ? Number(pnl * 10_000n / totalCost) : null,
      creatorInitialBuyLamports: state.launches[launch.mint]?.initialBuyLamports ?? null,
      priorCreatorInitialBuysKnown: prior.filter(([, item]) => item.initialBuyLamports !== undefined).length,
      priorCreatorSellsObserved: prior.reduce((sum, [, item]) => sum + (item.sellObservations ?? 0), 0),
      priorCreatorSellLamportsObserved: String(prior.reduce((sum, [, item]) => sum + BigInt(item.sellLamports ?? 0), 0n)),
      concentrationBps: launch.concentrationBps ?? null, linkedWalletExposureBps: launch.linkedWalletExposureBps ?? null,
    };
  }

  #considerEntry(candidate: Candidate, forcedRejection?: string): void {
    const { launch } = candidate;
    const state = this.#state;
    const settings = this.#settings;
    const history = this.#history(launch);
    const identity = this.#verify(launch, state.now, launch.blockTimeMs ?? launch.receivedAtMs);
    const entry = this.#venueQuote(launch.mint, 'buy', BigInt(settings.spendLamports));
    const exit = 'quote' in entry ? quoteSell(entry.quote.tokens, afterFill(entry.state, entry.quote, 'buy'), {
      impactBps: settings.exitImpactBps, maxVenueFeeBps: settings.maxVenueFeeBps, executionFee: this.#executionFee,
    }) : undefined;
    const market = state.market[launch.mint]?.event;
    const decisionSlot = state.lastSlot ?? null;
    const snapshot = opportunity({ launch, cutoffMs: state.now, cutoffSlot: decisionSlot,
      trades: candidate.early ?? [], balances: candidate.balances ?? [], tapeIncomplete: candidate.incomplete ?? true, history,
      policy: settings.riskPolicy, quoteError: 'reason' in entry ? entry.reason : exit?.ok === false ? exit.reason : null,
      quote: 'quote' in entry && market ? { reserves: entry.state, quoteReceiptMs: market.receivedAtMs, quoteSlot: market.slot,
        provider: market.provider,
        entryNetLamports: String(entry.quote.netSol), exitNetLamports: exit?.ok ? String(exit.netSol) : null,
        entryImpactBps: entry.quote.impactBps, exitImpactBps: exit?.ok ? exit.impactBps : null } : null,
    });
    const shadow = scoreModel(this.#model, snapshot.features, state.now, this.#modelHash);
    const decision = { creator: launch.creator, history, identity, receiptMs: launch.receivedAtMs,
      launchSlot: launch.slot, decisionSlot, decisionAtMs: state.now, sourceTiming: launch.sourceTiming ?? null,
      processedAtMs: this.#wallClock?.() ?? null, hydrationMs: launch.hydrationMs ?? null, risk: snapshot, shadow,
      enrichment: trackerAsOf(this.#enrichment?.(launch.mint), state.now, 15_000) };
    const reject = (reason: string) => this.#record('decision', { ...decision, shadowWouldEnterAfterHardRules: false,
      result: 'rejected', reason }, launch.mint);
    const risk = forcedRejection ?? this.#entryRisk(candidate);
    if (risk) return reject(risk);
    if (!identity.eligible) return reject(identity.reason);
    if (settings.minCreatorHistorySamples !== undefined && history.sampleSize < settings.minCreatorHistorySamples) return reject('creator_history_sample_limit');
    if (settings.minCreatorHistoryCoverageBps !== undefined && history.coverageBps < settings.minCreatorHistoryCoverageBps) return reject('creator_history_coverage_limit');
    if (settings.minCreatorHistoryReturnBps !== undefined &&
      (history.returnBps === null || history.returnBps < settings.minCreatorHistoryReturnBps)) return reject('creator_history_return_limit');
    if (settings.minCreatorInitialBuyLamports !== undefined &&
      (history.creatorInitialBuyLamports === null || BigInt(history.creatorInitialBuyLamports) < BigInt(settings.minCreatorInitialBuyLamports))) {
      return reject('creator_initial_buy_limit');
    }
    if (settings.maxConcentrationBps !== undefined &&
      (history.concentrationBps === null || history.concentrationBps > settings.maxConcentrationBps)) return reject('concentration_limit');
    if ('reason' in entry) return reject(entry.reason);
    if (!exit?.ok) return reject(`entry_exit_quote_${exit?.reason ?? 'missing'}`);
    if (!snapshot.approved) return reject(snapshot.adjustments[0]!);
    if (this.#gateModel && (!shadow.available || !shadow.wouldEnter)) return reject('shadow_model_counterfactual_veto');
    this.#record('decision', { ...decision, shadowWouldEnterAfterHardRules: shadow.available && shadow.wouldEnter,
      result: 'eligible', reason: identity.reason }, launch.mint);
    this.#order({
      id: `${launch.mint}:buy`, mint: launch.mint, side: 'buy', venue: entry.venue,
      minimum: String(minAfterSlippage(entry.quote.tokens, settings.slippageBps)), reason: 'qualified_launch', candidate,
      ...(identity.alias ? { alias: identity.alias } : {}),
    }, entry.quote);
  }

  #considerExit(position: Position): void {
    if (position.unresolved === 'rolled_back_launch_after_modeled_fill') return;
    if (position.exit && this.#settings.exits) {
      this.#considerLadderExit(position);
      return;
    }
    const now = this.#state.now;
    const quote = this.#venueQuote(position.mint, 'sell', BigInt(position.tokens));
    if (!position.trigger) {
      const reason = exitTrigger('quote' in quote ? quote.quote.netSol : undefined, BigInt(position.costLamports),
        now - position.entryAtMs, this.#settings);
      if (!reason) return;
      position.trigger = { reason, atMs: now };
      this.#record('exit_trigger', position.trigger, position.mint);
    }
    if (position.nextRetryAtMs !== undefined && now < position.nextRetryAtMs) return;
    delete position.nextRetryAtMs;
    if (position.attempts >= this.#settings.maxAttempts) return;
    if ('reason' in quote) {
      if (position.unresolved !== quote.reason) this.#record('exit_unresolved', { reason: quote.reason }, position.mint);
      position.unresolved = quote.reason;
      return;
    }
    position.attempts++;
    this.#order({
      id: `${position.mint}:sell:${position.attempts}`, mint: position.mint, side: 'sell', venue: quote.venue, reason: position.trigger.reason,
      minimum: String(minAfterSlippage(quote.quote.netSol, this.#settings.slippageBps)),
    }, quote.quote);
  }

  #ladderQuote(position: Position) {
    if (!position.exit || !this.#settings.exits) return;
    const size = BigInt(position.tokens);
    const full = this.#venueQuote(position.mint, 'sell', size);
    const end = position.exit.terminal;
    if (end) {
      if ('reason' in full || (position.exitAttempts?.[end] ?? 0) >= this.#settings.maxAttempts) return;
      return { reason: end, tokens: size, ...full };
    }
    const leg = profitExit(this.#settings.exits, position.exit, size, 'quote' in full ? full.quote.netSol : undefined, tokens => {
      const quote = this.#venueQuote(position.mint, 'sell', tokens);
      return 'quote' in quote ? quote.quote.netSol : undefined;
    }, label => (position.exitAttempts?.[label] ?? 0) < this.#settings.maxAttempts);
    if (!leg) return;
    const quote = this.#venueQuote(position.mint, 'sell', leg.tokens);
    if ('quote' in quote) return { reason: leg.label, tokens: leg.tokens, ...quote };
  }

  #considerLadderExit(position: Position): void {
    const now = this.#state.now;
    if (position.nextRetryAtMs !== undefined && position.nextRetryAtMs > now) return;
    const result = this.#ladderQuote(position);
    if (!result) return;
    delete position.nextRetryAtMs;
    const exitAttempts = position.exitAttempts ??= {};
    exitAttempts[result.reason] = (exitAttempts[result.reason] ?? 0) + 1;
    position.attempts++;
    const id = `${position.mint}:sell:${position.attempts}`;
    flagLeg(position.exit!, result.reason, 'pending', id);
    this.#record('exit_trigger', { reason: result.reason, policyVersion: position.exit!.policyVersion,
      tokens: String(result.tokens), atMs: now }, position.mint);
    this.#order({
      id, mint: position.mint, side: 'sell', venue: result.venue,
      reason: result.reason, sellTokens: String(result.tokens),
      minimum: String(minAfterSlippage(result.quote.netSol, this.#settings.slippageBps)),
    }, result.quote);
  }

  #orderKey(mint: string, side: 'buy' | 'sell'): string {
    return `${mint}:${side}`;
  }

  #order(order: Omit<Order, 'phase' | 'atMs'>, quote: SuccessfulQuote): void {
    const atMs = this.#state.now + this.#settings.delayMs.submission;
    const { mint, side, id, reason, venue, minimum } = order;
    this.#state.orders[this.#orderKey(mint, side)] = { ...order, phase: 'submit', atMs };
    this.#record('quote', { side, venue, ...quoteData(quote) }, mint, id);
    this.#record('intent', { side, reason, venue, minimum, submitAtMs: atMs, sellTokens: order.sellTokens }, mint, id);
  }

  #currentOrderQuote(order: Order): VenueQuote {
    const position = this.#state.positions[order.mint];
    if (order.side === 'sell' && !position) return { reason: 'position_missing' };
    const amount = BigInt(order.side === 'buy' ? this.#settings.spendLamports : order.sellTokens ?? position!.tokens);
    return this.#venueQuote(order.mint, order.side, amount);
  }

  #orderRejection(order: Order, quote: VenueQuote): string | undefined {
    if (order.candidate) {
      const reason = this.#entryRisk(order.candidate, order);
      if (reason) return reason;
    }
    if ('reason' in quote) return quote.reason;
    if (order.side === 'sell' && order.phase === 'submit' && order.reason.startsWith('TP') &&
        this.#state.positions[order.mint]?.exit?.terminal) return 'tp_superseded_by_terminal';
    if (order.venue !== quote.venue) return 'venue_changed';
    if ((order.side === 'buy' ? quote.quote.tokens : quote.quote.netSol) < BigInt(order.minimum)) return 'slippage_limit';
    if (order.side === 'buy') {
      const exit = quoteSell(quote.quote.tokens, afterFill(quote.state, quote.quote, 'buy'), {
        impactBps: this.#settings.exitImpactBps, maxVenueFeeBps: this.#settings.maxVenueFeeBps, executionFee: this.#executionFee,
      });
      if (!exit.ok) return `entry_exit_quote_${exit.reason}`;
    }
  }

  #submit(key: string, order: Order): void {
    const rejection = this.#orderRejection(order, this.#currentOrderQuote(order));
    if (rejection) return this.#fail(key, order, rejection, false);
    this.#record('attempt', { side: order.side, venue: order.venue, landingAtMs: this.#state.now + this.#settings.delayMs.landing },
      order.mint, order.id);
    order.atMs = this.#state.now + this.#settings.delayMs.landing;
    order.phase = 'land';
  }

  #fail(key: string, order: Order, reason: string, landed: boolean): void {
    const state = this.#state;
    delete state.orders[key];
    const failFee = BigInt(this.#settings.failedFeeLamports);
    const balance = BigInt(state.balanceLamports);
    const fee = landed ? (failFee > balance ? balance : failFee) : 0n;
    state.balanceLamports = String(balance - fee);
    this.#record('result', { side: order.side, status: landed ? 'failed' : 'missed', reason, feeLamports: String(fee) }, order.mint, order.id);
    const position = state.positions[order.mint];
    if (order.side === 'sell' && position) {
      position.costLamports = String(BigInt(position.costLamports) + fee);
      if (position.exit) {
        position.exit.failedFeesLamports = String(BigInt(position.exit.failedFeesLamports) + fee);
        flagLeg(position.exit, order.reason, 'failed', order.id);
      }
      const attempts = position.exit ? position.exitAttempts?.[order.reason] ?? 0 : position.attempts;
      position.unresolved = attempts >= this.#settings.maxAttempts ? 'exit_attempt_limit' : reason;
      if (attempts < this.#settings.maxAttempts && reason !== 'tp_superseded_by_terminal') {
        position.nextRetryAtMs = state.now + Math.max(1, this.#settings.retryDelayMs);
      }
    }
  }

  #land(key: string, order: Order): void {
    const state = this.#state;
    const result = this.#currentOrderQuote(order);
    const rejection = this.#orderRejection(order, result);
    if (rejection || 'reason' in result) return this.#fail(key, order, rejection ?? 'quote_unavailable', true);
    delete state.orders[key];
    const { quote, venue } = result;
    const original = state.market[order.mint]!.event.reserves!;
    const adjusted = afterFill(result.state, quote, order.side);
    const offset = {} as ReserveDelta;
    for (const field of reserveKeys) offset[field] = String(BigInt(adjusted[field]) - BigInt(original[field]));
    state.market[order.mint]!.offset = offset;
    const held = state.positions[order.mint];
    const rent = order.side === 'buy' ? this.#rent : BigInt(held!.tokens) === quote.tokens ? BigInt(held!.rentLamports) : 0n;
    if (order.side === 'buy') {
      const { launch } = order.candidate!;
      state.balanceLamports = String(BigInt(state.balanceLamports) - quote.netSol - rent);
      state.entered.push(launch.mint);
      state.positions[launch.mint] = {
        mint: launch.mint, creator: launch.creator, ...(order.alias ? { alias: order.alias } : {}), tokens: String(quote.tokens),
        costLamports: String(quote.netSol), rentLamports: String(rent), entryAtMs: state.now, entryVenue: venue,
        signature: launch.signature, markLamports: '0', attempts: 0,
        ...(this.#settings.exits ? { exit: startExit(this.#settings.exits, String(quote.tokens), String(quote.netSol)) } : {}),
      };
    } else {
      const position = state.positions[order.mint]!;
      state.balanceLamports = String(BigInt(state.balanceLamports) + quote.netSol + rent);
      const remaining = BigInt(position.tokens) - quote.tokens;
      if (position.exit) sellProgress(position.exit, order.reason, quote.tokens, quote.netSol, order.id);
      if (remaining > 0n) {
        position.tokens = String(remaining);
        delete position.unresolved;
        this.#record('position_partial', { reason: order.reason, tokensSold: String(quote.tokens),
          remainingTokens: position.tokens, exit: structuredClone(position.exit) }, order.mint, order.id);
      } else {
        const proceeds = position.exit ? BigInt(position.exit.saleProceedsLamports) : quote.netSol;
        const outcome: Outcome = {
          mint: position.mint, creator: position.creator, ...(position.alias ? { alias: position.alias } : {}),
          realizedAtMs: state.now, pnlLamports: String(proceeds - BigInt(position.costLamports)),
          costLamports: position.costLamports, proceedsLamports: String(proceeds),
          exitReason: order.reason, ...(position.exit ? { exit: position.exit } : {}),
        };
        state.outcomes.push(outcome);
        this.#record('position_closed', outcome, order.mint, order.id);
        delete state.positions[order.mint];
      }
    }
    this.#record('fill', {
      side: order.side, venue, ...quoteData(quote), rentLamports: String(rent),
      networkFeeLamports: this.#settings.networkFeeLamports, priorityFeeLamports: this.#settings.priorityFeeLamports,
      tipLamports: this.#settings.tipLamports ?? '0',
    }, order.mint, order.id);
    this.#record('result', { side: order.side, status: 'filled' }, order.mint, order.id);
  }

  #mark(): void {
    let equity = BigInt(this.#state.balanceLamports);
    for (const position of Object.values(this.#state.positions)) {
      const estimate = this.#venueQuote(position.mint, 'sell', BigInt(position.tokens));
      if (position.exit && this.#settings.exits && position.unresolved !== 'rolled_back_launch_after_modeled_fill') {
        const terminal = terminalExit(this.#settings.exits, position.exit, BigInt(position.tokens),
          'quote' in estimate ? estimate.quote.netSol : undefined, this.#state.now - position.entryAtMs, this.#settings.timeExitMs);
        if (terminal && terminal !== position.exit.terminal) {
          position.exit.terminal = terminal;
          delete position.nextRetryAtMs;
          this.#record('exit_terminal', { reason: terminal, policyVersion: position.exit.policyVersion }, position.mint);
        }
        if (terminal && 'reason' in estimate) position.unresolved = estimate.reason;
      }
      position.markLamports = 'quote' in estimate && position.unresolved !== 'rolled_back_launch_after_modeled_fill'
        ? String(estimate.quote.netSol + BigInt(position.rentLamports)) : '0';
      equity += BigInt(position.markLamports);
    }
    const value = String(equity);
    if (value !== this.#state.equityLamports) {
      this.#state.equityLamports = value;
      this.#record('equity', { equityLamports: value });
    }
  }
}
