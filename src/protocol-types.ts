export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type Venue = "curve" | "pumpswap";
export type Commitment = "observed" | "confirmed" | "finalized" | "rolled_back";
export interface OwnerBalance {
  account: string;
  owner: string;
  amount: string;
}

export interface Reserves {
  virtualToken: string;
  virtualSol: string;
  realToken: string;
  realSol: string;
  feeBps?: number;
  complete: boolean;
}

export interface EventProvenance {
  provider: string;
  receivedAtMs: number;
  slot: number;
  transactionIndex?: number;
  instructionPath: number[];
  signature: string;
  blockhash?: string;
  blockTimeMs?: number;
  commitment: Commitment;
  late?: boolean;
  hydrationMs?: number;
  sourceTiming?: "confirmed_block" | "historical_block" | "transaction_sampler" | "executed_transaction";
  observedHeadSlot?: number;
}

export interface LaunchEvent extends EventProvenance {
  kind: "launch";
  mint: string;
  quoteMint: string;
  creator: string;
  launchUser: string;
  signers: string[];
  supported: boolean;
  unsupportedReason?: string;
  reserves?: Reserves;
  tokenProgram?: string;
  tokenExtensions?: string[];
  createInstruction?: "create" | "create_v2";
  bondingCurve?: string;
  concentrationBps?: number;
  linkedWalletExposureBps?: number;
  creatorInitialBuyLamports?: string;
  ownerBalances?: OwnerBalance[];
}

export interface TradeEvent extends EventProvenance {
  kind: "trade";
  mint: string;
  quoteMint: string;
  venue: Venue;
  side: "buy" | "sell" | "update";
  canonical: boolean;
  reserves?: Reserves;
  venueAccount?: string;
  trader?: string;
  tokenAmount?: string;
  quoteAmount?: string;
  signers?: string[];
  ownerBalances?: OwnerBalance[];
}

export interface MigrationEvent extends EventProvenance {
  kind: "migration";
  mint: string;
  quoteMint: string;
  canonical: boolean;
  reserves?: Reserves;
  pool?: string;
}

export interface StatusEvent extends EventProvenance {
  kind: "status";
  mint?: string;
  reason?: string;
}

export interface FeedEvent {
  kind: "feed";
  provider: string;
  receivedAtMs: number;
  healthy: boolean;
  reason?: string;
  slot?: number;
  subscriptions?: number;
  queueDepth?: number;
  droppedMessages?: number;
  finalizedSlot?: number;
}

export type ProtocolEvent = LaunchEvent | TradeEvent | MigrationEvent;
export type NormalizedEvent = ProtocolEvent | StatusEvent | FeedEvent;
