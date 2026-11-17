import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  PUMPSWAP_PROGRAM, PUMP_PROGRAM, SOL_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
} from "./protocol-types.ts";
import type { EventProvenance, LaunchEvent, ProtocolEvent, Reserves, TradeEvent } from "./protocol-types.ts";

interface CompiledInstruction {
  accounts: number[];
  programIdIndex: number;
  data: string;
  stackHeight?: number | null;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

export interface RpcTransaction {
  slot: number;
  blockTime?: number | null;
  version?: string | number;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      header: { numRequiredSignatures: number };
      instructions: CompiledInstruction[];
    };
  };
  meta: {
    err: unknown;
    fee?: number;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: { index: number; instructions: CompiledInstruction[] }[] | null;
    postTokenBalances?: TokenBalance[] | null;
    preTokenBalances?: TokenBalance[] | null;
  } | null;
}

export type TransactionProvenance = Omit<EventProvenance, "instructionPath" | "signature" | "slot">;

export interface RawTransactionRecord {
  transaction: RpcTransaction;
  provenance: TransactionProvenance;
}

interface Instruction {
  path: number[];
  program: string;
  accounts: string[];
  indices: number[];
  data: Buffer;
  parent?: Instruction;
}

const defaultPubkey = "11111111111111111111111111111111";
const pda = (seeds: Buffer[], program: string) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0].toBase58();
const bytes = (address: string) => Buffer.from(new PublicKey(address).toBytes());
const eventAuthority = new Map([PUMP_PROGRAM, PUMPSWAP_PROGRAM].map(program =>
  [program, pda([Buffer.from("__event_authority")], program)]));
const tag = (hex: string) => Buffer.from(hex, "hex");
const create = tag("181ec82805080777");
const createV2 = tag("d6904cec5f8b31b4");
const cpiEvent = tag("e445a52e51cb9a1d");
const createEvent = tag("1b72a94ddeeb6376");
const curveTradeEvent = tag("bddb7fd34ee661ee");
const completeEvent = tag("5f72619cd42e9808");
const migrateEvent = tag("b9e95db95c94ea94");
const swapBuyEvent = tag("67f4521f2cf57777");
const swapSellEvent = tag("3e2f370aa503dc2a");
const legacyMigrate = tag("9beae792ec9ea21e");
const migrateV2 = tag("bbcb121fceedfe29");
const swapPoolMutation = new Set([
  "f223c68952e1f2b6", "b712469c946da122", "694406af000723a2", // deposit, withdraw, boost
]);

const curveTrades = new Map<string, readonly ["buy" | "sell", number, number, number?]>([
  ["66063d1201daebea", ["buy", 2, 3]],
  ["38fc74089edfcd5f", ["buy", 2, 3]],
  ["33e685a4017f83ad", ["sell", 2, 3]],
  ["b817ee6167c5d33d", ["buy", 1, 9, 2]],
  ["c2ab1c46684d5b2f", ["buy", 1, 9, 2]],
  ["5df6823ce7e940b2", ["sell", 1, 9, 2]],
  ["07051dc4f5176550", ["buy", 1, 5, 2]],
  ["e1f7501ed5b38488", ["buy", 1, 5, 2]],
  ["1c92de7726c469d5", ["sell", 1, 5, 2]],
]);

const swapTrades = new Map<string, "buy" | "sell">([
  ["66063d1201daebea", "buy"],
  ["c62e1552b4d9e870", "buy"],
  ["c2ab1c46684d5b2f", "buy"],
  ["b817ee6167c5d33d", "buy"],
  ["33e685a4017f83ad", "sell"],
  ["5df6823ce7e940b2", "sell"],
]);

function canonicalCurve(mint: string, address: string | undefined): boolean {
  return pda([Buffer.from("bonding-curve"), bytes(mint)], PUMP_PROGRAM) === address;
}

export function canonicalPoolAddress(mint: string, quoteMint: string): string {
  const authority = pda([Buffer.from("pool-authority"), bytes(mint)], PUMP_PROGRAM);
  return pda([Buffer.from("pool"), Buffer.alloc(2), bytes(authority), bytes(mint), bytes(quoteMint)], PUMPSWAP_PROGRAM);
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new RangeError(`missing ${field}`);
  return value;
}

function normalizeQuote(address: string | undefined): string {
  if (address === undefined) throw new RangeError("missing quote mint");
  return address === defaultPubkey ? SOL_MINT : address;
}

class Reader {
  private data: Buffer;
  private offset: number;

  constructor(data: Buffer, offset = 0) {
    this.data = data;
    this.offset = offset;
  }

  get remaining(): number { return this.data.length - this.offset; }

  skip(length: number): void {
    if (length > this.remaining || length < 0) throw new RangeError("truncated instruction or event");
    this.offset += length;
  }

  u8(): number {
    const result = this.data.readUInt8(this.offset);
    this.offset += 1;
    return result;
  }

  bool(): boolean {
    const value = this.u8();
    if (value > 1) throw new RangeError("invalid boolean");
    return value === 1;
  }

  u32(): number {
    const result = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    return result;
  }

  u64(): bigint {
    const result = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return result;
  }

  i128(): bigint {
    const low = this.u64();
    const high = BigInt.asIntN(64, this.u64());
    return (high << 64n) + low;
  }

  key(): string {
    const start = this.offset;
    this.skip(32);
    return bs58.encode(this.data.subarray(start, this.offset));
  }

  skipString(): void { this.skip(this.u32()); }

  skipMetadata(): void {
    this.skipString();
    this.skipString();
    this.skipString();
  }
}

function flatten(raw: RpcTransaction, keys: string[]): Instruction[] {
  const result: Instruction[] = [];
  const inner = new Map(raw.meta?.innerInstructions?.map(group => [group.index, group.instructions]));
  const add = (compiled: CompiledInstruction, path: number[], parent?: Instruction): Instruction => {
    const item: Instruction = {
      path, program: required(keys[compiled.programIdIndex], "compiled program"), indices: compiled.accounts,
      accounts: compiled.accounts.map(index => required(keys[index], "compiled account")),
      data: Buffer.from(bs58.decode(compiled.data)), parent,
    };
    result.push(item);
    return item;
  };
  raw.transaction.message.instructions.forEach((compiled, index) => {
    const ancestors = new Map<number, Instruction>([[1, add(compiled, [index])]]);
    inner.get(index)?.forEach((child, childIndex) => {
      const height = child.stackHeight;
      // Older RPC records omit stack height. Decode the instruction but never
      // assign its event data to a prospective parent without nesting proof.
      const parent = typeof height === "number" ? ancestors.get(height - 1) : undefined;
      const inst = add(child, [index, childIndex], parent);
      if (typeof height === "number") {
        for (const depth of ancestors.keys()) if (depth >= height) ancestors.delete(depth);
        ancestors.set(height, inst);
      } else {
        for (const depth of ancestors.keys()) if (depth > 1) ancestors.delete(depth);
      }
    });
  });
  return result;
}

function matchingEvent(instructions: Instruction[], parent: Instruction, discriminator: Buffer): Reader | undefined {
  const matches = instructions.filter(ix => ix.parent === parent && ix.program === parent.program &&
    ix.accounts[0] === eventAuthority.get(ix.program) && ix.data.subarray(0, 8).equals(cpiEvent) &&
    ix.data.subarray(8, 16).equals(discriminator));
  const match = matches[0];
  return matches.length === 1 && match ? new Reader(match.data, 16) : undefined;
}

// Token-2022 mint extension initializers are instructions touching this mint.
// Unknown token instructions touching a newly created mint make it review-only.
function launchMintExtensions(instructions: Instruction[], mint: string): string[] | undefined {
  const observed = new Set<string>();
  for (const ix of instructions) {
    if (ix.program !== TOKEN_2022_PROGRAM || ix.accounts[0] !== mint) continue;
    const opcode = ix.data[0];
    if (opcode === 0 || opcode === 20) { // InitializeMint / InitializeMint2
      if (ix.data.length !== 35 || ix.data[1] !== 6 || ix.data[34] !== 0) return undefined;
      observed.add("initializeMint");
    } else if (ix.data.subarray(0, 2).equals(Buffer.of(39, 0)) && ix.data.length === 66) {
      if (!ix.data.subarray(34).equals(bytes(mint))) return undefined;
      observed.add("metadataPointer");
    } else if (ix.data.subarray(0, 8).equals(tag("d2e11ea258b84d8d"))) {
      observed.add("tokenMetadata");
    } else if (ix.data.subarray(0, 8).equals(tag("d7e4a6e45464567b")) ||
        opcode === 6 || opcode === 7 || opcode === 14 || opcode === 21) {
      // Update metadata authority, set authority, mint-to and size queries.
      continue;
    } else {
      return undefined;
    }
  }
  if (!observed.delete("initializeMint") || !observed.has("metadataPointer")) return undefined;
  return [...observed].sort();
}

function decodeLaunch(ix: Instruction, instructions: Instruction[], signers: string[],
  provenance: EventProvenance, v2: boolean): LaunchEvent {
  const args = new Reader(ix.data, 8);
  args.skipMetadata();
  const creator = args.key();
  const mayhem = v2 && args.bool();
  const cashback = v2 && args.remaining >= 1 && args.bool();
  const customFee = v2 && args.remaining >= 8 ? args.u64() : 0n;
  const rewards = v2 && args.remaining >= 1 && args.bool();
  const [mint, , bondingCurve] = ix.accounts;
  const launchUser = ix.accounts[v2 ? 5 : 7];
  const tokenProgram = ix.accounts[v2 ? 7 : 9];
  let quoteMint = v2 && ix.accounts[16] ? normalizeQuote(ix.accounts[16]) : SOL_MINT;
  if (!mint || !bondingCurve || !launchUser || !tokenProgram) throw new RangeError("missing launch accounts");
  const tokenExtensions = v2 ? launchMintExtensions(instructions, mint) : [];
  let reserves: Reserves | undefined;
  let inconsistentEvent = false;
  const event = matchingEvent(instructions, ix, createEvent);
  if (event) {
    event.skipMetadata();
    const eventMint = event.key();
    const eventCurve = event.key();
    const eventUser = event.key();
    const eventCreator = event.key();
    event.skip(8); // timestamp
    const virtualToken = event.u64();
    const virtualSol = event.u64();
    const realToken = event.u64();
    event.skip(8); // total supply
    const eventTokenProgram = event.remaining >= 32 ? event.key() : tokenProgram;
    const eventMayhem = event.remaining >= 1 ? event.bool() : mayhem;
    const eventCashback = event.remaining >= 1 ? event.bool() : cashback;
    const eventQuote = event.remaining >= 32 ? normalizeQuote(event.key()) : quoteMint;
    inconsistentEvent = eventMint !== mint || eventCurve !== bondingCurve || eventUser !== launchUser ||
      eventCreator !== creator || eventTokenProgram !== tokenProgram || eventQuote !== quoteMint ||
      eventMayhem !== mayhem || eventCashback !== cashback;
    if (quoteMint === SOL_MINT) quoteMint = eventQuote;
    if (quoteMint === SOL_MINT && !inconsistentEvent) {
      reserves = { virtualToken: virtualToken.toString(), virtualSol: virtualSol.toString(),
        realToken: realToken.toString(), realSol: "0", complete: false };
    }
  }
  const unsupportedReason = !canonicalCurve(mint, bondingCurve) ? "noncanonical_bonding_curve"
    : !signers.includes(mint) ? "launch_mint_not_transaction_signer"
    : quoteMint !== SOL_MINT ? "unsupported_quote_mint"
    : inconsistentEvent ? "inconsistent_create_event"
    : tokenProgram !== (v2 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM) ? "unsupported_token_program"
    : mayhem || cashback || rewards || customFee > 0n || args.remaining > 0 ? "unsupported_launch_configuration"
    : !tokenExtensions ? "token2022_extensions_unknown"
    : undefined;
  return {
    ...provenance, kind: "launch", mint, quoteMint, creator, launchUser, signers, bondingCurve,
    tokenProgram, tokenExtensions, supported: !unsupportedReason, unsupportedReason, reserves,
    createInstruction: v2 ? "create_v2" : "create",
  };
}

function totalFee(...parts: bigint[]): number | undefined {
  const total = parts.reduce((sum, value) => sum + value, 0n);
  return total < 10_000n ? Number(total) : undefined;
}

function readCurveTrade(event: Reader, trade: TradeEvent): void {
  if (event.key() !== trade.mint) return;
  const quoteAmount = event.u64();
  const tokenAmount = event.u64();
  if (event.bool() !== (trade.side === "buy")) return;
  trade.trader = event.key();
  trade.quoteAmount = quoteAmount.toString();
  trade.tokenAmount = tokenAmount.toString();
  event.skip(8);
  const virtualSol = event.u64();
  const virtualToken = event.u64();
  const realSol = event.u64();
  const realToken = event.u64();
  let protocolFee = 0n;
  let creatorFee = 0n;
  let hasFeeEvidence = false;
  let special = false;
  if (event.remaining >= 96) {
    event.skip(32); // fee recipient
    protocolFee = event.u64();
    event.skip(40); // fee, creator
    creatorFee = event.u64();
    event.skip(8);
    hasFeeEvidence = true;
  }
  if (event.remaining >= 33) event.skip(33);
  if (event.remaining >= 4) event.skipString(); // ix_name
  if (event.remaining >= 1) special = event.bool();
  if (event.remaining >= 16) {
    const cashbackFee = event.u64();
    special ||= cashbackFee > 0n;
    event.skip(8);
  }
  if (event.remaining >= 16) {
    event.skip(16); // buyback is a share of the protocol fee
  }
  if (event.remaining >= 4) event.skip(event.u32() * 34);
  if (event.remaining >= 32 && normalizeQuote(event.key()) !== trade.quoteMint) return;
  if (event.remaining >= 24) event.skip(24);
  if (event.remaining >= 8 && event.u64() > 0n) return; // holder rewards configuration
  if (trade.quoteMint !== SOL_MINT || special) return;
  trade.reserves = {
    virtualSol: virtualSol.toString(), virtualToken: virtualToken.toString(),
    realSol: realSol.toString(), realToken: realToken.toString(),
    feeBps: hasFeeEvidence ? totalFee(protocolFee, creatorFee) : undefined,
    complete: realToken === 0n,
  };
}

function balance(raw: RpcTransaction, accountIndex: number | undefined, mint: string): string | undefined {
  const value = raw.meta?.postTokenBalances?.find(item => item.accountIndex === accountIndex && item.mint === mint)
    ?.uiTokenAmount.amount;
  return value && /^\d+$/.test(value) ? value : undefined;
}

function readSwapTrade(event: Reader, trade: TradeEvent, raw: RpcTransaction, ix: Instruction): void {
  event.skip(8); // timestamp
  const tokenAmount = event.u64();
  event.skip(5 * 8);
  const quoteAmount = event.u64();
  const lpFee = event.u64();
  event.skip(8);
  const protocolFee = event.u64();
  event.skip(3 * 8);
  if (event.key() !== trade.venueAccount) return;
  trade.trader = event.key();
  trade.tokenAmount = tokenAmount.toString();
  trade.quoteAmount = quoteAmount.toString();
  event.skip(5 * 32);
  let creatorFee = 0n;
  if (event.remaining >= 16) {
    creatorFee = event.u64();
    event.skip(8);
  }
  if (trade.side === "buy" && event.remaining >= 41) {
    event.skip(41);
    if (event.remaining >= 4) event.skipString();
  }
  if (event.remaining >= 16) {
    if (event.u64() > 0n) return; // cashback configuration
    event.skip(8);
  }
  if (event.remaining >= 16) {
    event.skip(16); // buyback is a share of the protocol fee
  }
  const virtualQuoteAdjustment = event.remaining >= 16 ? event.i128() : 0n;
  if (virtualQuoteAdjustment > 0n || (event.remaining >= 1 && event.bool())) return; // boost
  if (event.remaining >= 8) event.skip(8);
  if (event.remaining >= 8 && event.u64() > 0n) return; // holder rewards
  const base = balance(raw, ix.indices[7], trade.mint);
  const quote = balance(raw, ix.indices[8], trade.quoteMint);
  if (base && quote && trade.quoteMint === SOL_MINT) {
    const effectiveQuote = BigInt(quote) + virtualQuoteAdjustment;
    if (effectiveQuote <= 0n) return;
    const netQuote = effectiveQuote.toString();
    trade.reserves = { virtualToken: base, realToken: base, virtualSol: netQuote, realSol: netQuote,
      feeBps: totalFee(lpFee, protocolFee, creatorFee), complete: false };
  }
}

export function mentionsProtocol(raw: RpcTransaction): boolean {
  return [raw.transaction.message.accountKeys, raw.meta?.loadedAddresses?.readonly ?? [],
    raw.meta?.loadedAddresses?.writable ?? []].some(keys =>
    keys.includes(PUMP_PROGRAM) || keys.includes(PUMPSWAP_PROGRAM));
}

export function decodeTransaction(raw: RpcTransaction, provenance: TransactionProvenance): ProtocolEvent[] {
  if (!raw.meta || raw.meta.err !== null || !mentionsProtocol(raw)) return [];
  const { accountKeys, header } = raw.transaction.message;
  const signature = raw.transaction.signatures[0];
  const signatureCount = header.numRequiredSignatures;
  if (!signature || !Number.isSafeInteger(signatureCount) || signatureCount < 1 ||
      signatureCount > accountKeys.length || raw.transaction.signatures.length !== signatureCount) return [];
  const keys = [...accountKeys, ...raw.meta.loadedAddresses?.writable ?? [], ...raw.meta.loadedAddresses?.readonly ?? []];
  const signers = accountKeys.slice(0, signatureCount);
  const instructions = flatten(raw, keys);
  const output: ProtocolEvent[] = [];
  const swapPoolTouches = new Map<string, number>();
  for (const ix of instructions) {
    if (ix.program === PUMPSWAP_PROGRAM && ix.accounts[0]) {
      const pool = ix.accounts[0];
      swapPoolTouches.set(pool, (swapPoolTouches.get(pool) ?? 0) + 1);
    }
  }
  for (const ix of instructions) {
    const common: EventProvenance = {
      ...provenance, signature, slot: raw.slot, instructionPath: ix.path,
      blockTimeMs: typeof raw.blockTime === "number" ? raw.blockTime * 1000 : undefined,
    };
    const discriminator = ix.data.subarray(0, 8);
    const hex = discriminator.toString("hex");
    const isV2 = discriminator.equals(createV2);
    if (ix.program === PUMP_PROGRAM && (isV2 || discriminator.equals(create))) {
      output.push(decodeLaunch(ix, instructions, signers, common, isV2));
    } else if (ix.program === PUMP_PROGRAM && (discriminator.equals(legacyMigrate) || discriminator.equals(migrateV2))) {
      const v2 = discriminator.equals(migrateV2);
      const mint = required(ix.accounts[2], "migration base mint");
      const quoteMint = normalizeQuote(ix.accounts[v2 ? 3 : 14]);
      const pool = required(ix.accounts[v2 ? 10 : 9], "migration pool");
      const canonical = ix.accounts[v2 ? 9 : 8] === PUMPSWAP_PROGRAM && pool === canonicalPoolAddress(mint, quoteMint);
      const evidence = matchingEvent(instructions, ix, migrateEvent);
      if (evidence) {
        evidence.skip(32);
        if (evidence.key() !== mint) throw new RangeError("inconsistent migration mint");
        evidence.skip(3 * 8 + 32 + 8);
        if (evidence.key() !== pool) throw new RangeError("inconsistent migration pool");
      }
      const base = swapPoolTouches.get(pool) === 1 ? balance(raw, ix.indices[17], mint) : undefined;
      const quote = swapPoolTouches.get(pool) === 1 ? balance(raw, ix.indices[18], quoteMint) : undefined;
      output.push({ ...common, kind: "migration", mint, quoteMint, canonical, pool,
        reserves: canonical && quoteMint === SOL_MINT && base && quote ? {
          virtualToken: base, realToken: base, virtualSol: quote, realSol: quote, complete: false,
        } : undefined });
    } else if (ix.program === PUMP_PROGRAM && curveTrades.has(hex)) {
      const layout = curveTrades.get(hex);
      if (!layout) continue;
      const [side, mintIndex, venueIndex, quoteIndex] = layout;
      const mint = required(ix.accounts[mintIndex], "trade base mint");
      const quoteMint = quoteIndex === undefined ? SOL_MINT : normalizeQuote(ix.accounts[quoteIndex]);
      // A prior v2 deployment included an extra fee account before the curve.
      // Validate both layouts against the mint-derived PDA before using reserves.
      const venueAccount = quoteIndex !== undefined && venueIndex === 9 &&
        !canonicalCurve(mint, ix.accounts[venueIndex]) && canonicalCurve(mint, ix.accounts[10])
        ? ix.accounts[10] : ix.accounts[venueIndex];
      const trade: TradeEvent = { ...common, kind: "trade", mint, quoteMint, venue: "curve", side, signers,
        canonical: canonicalCurve(mint, venueAccount), venueAccount };
      const evidence = matchingEvent(instructions, ix, curveTradeEvent);
      if (evidence && trade.canonical) readCurveTrade(evidence, trade);
      const completed = matchingEvent(instructions, ix, completeEvent);
      if (completed && trade.reserves) {
        completed.skip(32);
        if (completed.key() === mint && completed.key() === venueAccount) trade.reserves.complete = true;
      }
      output.push(trade);
    } else if (ix.program === PUMPSWAP_PROGRAM) {
      const side = swapTrades.get(hex);
      if (!side && !swapPoolMutation.has(hex)) continue;
      const mint = required(ix.accounts[3], "pool base mint");
      const quoteMint = normalizeQuote(ix.accounts[4]);
      const venueAccount = required(ix.accounts[0], "swap pool");
      const trade: TradeEvent = { ...common, kind: "trade", mint, quoteMint, venue: "pumpswap", side: side ?? "update", signers,
        canonical: venueAccount === canonicalPoolAddress(mint, quoteMint), venueAccount };
      if (side && trade.canonical && swapPoolTouches.get(venueAccount) === 1) {
        const evidence = matchingEvent(instructions, ix, side === "buy" ? swapBuyEvent : swapSellEvent);
        if (evidence) readSwapTrade(evidence, trade, raw, ix);
      }
      output.push(trade);
    }
  }
  for (const event of output) {
    if (event.kind !== "launch") continue;
    const creatorBuys = output.filter((trade): trade is TradeEvent => trade.kind === "trade" &&
      trade.side === "buy" && trade.mint === event.mint && trade.trader === event.creator &&
      trade.canonical && trade.quoteMint === SOL_MINT && trade.quoteAmount !== undefined);
    if (creatorBuys.length) {
      event.creatorInitialBuyLamports = creatorBuys
        .reduce((total, trade) => total + BigInt(trade.quoteAmount ?? "0"), 0n).toString();
    }
  }
  const vaultOwners = new Set(output.flatMap(event =>
    event.kind === "launch" ? event.bondingCurve ? [event.bondingCurve] : [] :
      event.kind === "trade" ? event.venueAccount ? [event.venueAccount] : [] : event.pool ? [event.pool] : []));
  const lastForMint = new Map<string, LaunchEvent | TradeEvent>();
  for (const event of output) if (event.kind === "launch" || event.kind === "trade" && event.canonical) lastForMint.set(event.mint, event);
  if (raw.meta.postTokenBalances) {
    const post = raw.meta.postTokenBalances;
    const touched = new Set(post.map(row => row.accountIndex));
    const balances = [...post, ...(raw.meta.preTokenBalances ?? []).filter(row => !touched.has(row.accountIndex))
      .map(row => ({ ...row, uiTokenAmount: { amount: "0" } }))];
    for (const row of balances) {
      const event = lastForMint.get(row.mint);
      const account = keys[row.accountIndex];
      if (!event || !account || !row.owner || vaultOwners.has(row.owner) ||
          !/^\d{1,20}$/.test(row.uiTokenAmount.amount)) continue;
      (event.ownerBalances ??= []).push({ account, owner: row.owner, amount: row.uiTokenAmount.amount });
    }
  }
  return output;
}
