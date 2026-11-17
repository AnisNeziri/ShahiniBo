import { createHash } from "node:crypto";
import BN from "bn.js";
import bs58 from "bs58";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import type { AccountInfo, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, getExtensionTypes,
  getMetadataPointerState, unpackAccount, unpackMint,
} from "@solana/spl-token";
import {
  GLOBAL_PDA, GLOBAL_VOLUME_ACCUMULATOR_PDA, PUMP_EVENT_AUTHORITY_PDA, PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SDK, bondingCurvePda, creatorVaultPda,
  getBuySolAmountFromTokenAmount, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount,
  userVolumeAccumulatorPda,
} from "@pump-fun/pump-sdk";
import {
  GLOBAL_CONFIG_PDA, PUMP_AMM_EVENT_AUTHORITY_PDA, PUMP_AMM_FEE_CONFIG_PDA, PUMP_AMM_PROGRAM_ID, PUMP_AMM_SDK,
  OnlinePumpAmmSdk, canonicalPumpPoolPda, pumpPoolAuthorityPda, sellBaseInput,
  userVolumeAccumulatorPda as ammUserVolumeAccumulatorPda,
} from "@pump-fun/pump-swap-sdk";
import type { LiveCaps, LiveIntent, LiveTransport, Settlement, SignedAttempt } from "./live-execution.ts";

export interface RouteLimits {
  feeRecipients: PublicKey[];
  buybackRecipients: PublicKey[];
  maxVenueFeeBps: number;
  maxEntryImpactBps: number;
  maxExitImpactBps: number;
  computeUnitLimit: number;
  microLamportsPerUnit: number;
  timeoutMs: number;
}

interface RouteQuote {
  venue: LiveIntent["venue"];
  tokens: bigint;
  sol: bigint;
  slot: number;
  ata: PublicKey;
  ataAmount: bigint;
  ataDeposit: bigint;
  walletLamports: bigint;
  tokenProgram: PublicKey;
  makeInstructions(limit: bigint): Promise<TransactionInstruction[]>;
}

const asBig = (value: BN) => BigInt(value.toString());
const asBn = (value: bigint) => new BN(value.toString());
const ataFor = (mint: PublicKey, owner: PublicKey, program = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(mint, owner, true, program);
const knownTokenProgram = (key: PublicKey) => key.equals(TOKEN_PROGRAM_ID) || key.equals(TOKEN_2022_PROGRAM_ID);

function bigintAmount(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid RPC balance");
  return BigInt(value);
}

function sameKeys(ix: TransactionInstruction, keys: readonly PublicKey[]): boolean {
  return ix.keys.length === keys.length && keys.every((key, index) => key.equals(ix.keys[index]!.pubkey));
}

function checkTrade(
  ix: TransactionInstruction, program: PublicKey, side: LiveIntent["side"], keys: PublicKey[],
  tokens: bigint, limit: bigint, wallet: PublicKey, curve: boolean,
): void {
  const discriminator = createHash("sha256").update(`global:${side}_v2`).digest().subarray(0, 8);
  const extra = side === "buy" && curve ? 1 : 0;
  if (!ix.programId.equals(program) || !sameKeys(ix, keys) || ix.data.length !== 24 + extra ||
      !ix.data.subarray(0, 8).equals(discriminator) || ix.data.readBigUInt64LE(8) !== tokens ||
      ix.data.readBigUInt64LE(16) !== limit || (extra && ix.data[24] !== 0) ||
      ix.keys.some(k => k.isSigner !== k.pubkey.equals(wallet))) {
    throw new Error("Unrecognized trade instruction, accounts, signer, or amount");
  }
}

function checkImpact(
  side: LiveIntent["side"], tokens: bigint, backupTokens: bigint, backupSol: bigint,
  rawSol: bigint, sol: bigint, limits: RouteLimits,
): void {
  if (sol <= 0n || rawSol <= 0n || backupTokens <= 0n || backupSol <= 0n) throw new Error("Unusable route quote");
  const bps = 10_000n;
  const spot = tokens * backupSol;
  const execution = rawSol * backupTokens;
  const fee = side === "buy" ? sol - rawSol : rawSol - sol;
  const impact = side === "buy" ? execution - spot : spot - execution;
  const impactCap = side === "buy" ? limits.maxEntryImpactBps : limits.maxExitImpactBps;
  if (fee < 0n || fee * bps > rawSol * BigInt(limits.maxVenueFeeBps) ||
      impact * bps > spot * BigInt(impactCap)) {
    throw new Error("Live venue fee or price impact exceeds cap");
  }
}

function checkMint(mint: PublicKey, account: AccountInfo<Buffer> | null) {
  if (!account || !knownTokenProgram(account.owner)) throw new Error("Unsupported mint owner");
  const info = unpackMint(mint, account, account.owner);
  const extensions = getExtensionTypes(info.tlvData);
  const pointer = getMetadataPointerState(info);
  if (!info.isInitialized || info.freezeAuthority || info.mintAuthority ||
      extensions.some(type => type !== ExtensionType.MetadataPointer && type !== ExtensionType.TokenMetadata) ||
      (extensions.includes(ExtensionType.MetadataPointer) && !pointer?.metadataAddress?.equals(mint))) {
    throw new Error("Active mint authorities or unsupported Token-2022 mint extensions require review");
  }
  return { info, program: account.owner };
}

function checkTokenAccount(
  address: PublicKey, account: AccountInfo<Buffer> | null, mint: PublicKey, owner: PublicKey, program: PublicKey,
) {
  if (!account) return { amount: 0n, deposit: 0n };
  const data = unpackAccount(address, account, program);
  if (!data.isInitialized || data.isFrozen || data.delegate || data.closeAuthority ||
      getExtensionTypes(data.tlvData).some(type => type !== ExtensionType.ImmutableOwner) ||
      !data.mint.equals(mint) || !data.owner.equals(owner)) throw new Error("Unexpected token account configuration");
  return { amount: data.amount, deposit: bigintAmount(account.lamports) };
}

export function createConnection(endpoint: string, timeoutMs: number) {
  return new Connection(endpoint, {
    commitment: "confirmed", disableRetryOnRateLimit: true,
    fetch: (url, init) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) } as RequestInit),
  });
}

export class SolanaTransport implements LiveTransport {
  readonly wallet: string;
  readonly #signer: Keypair;
  readonly #rpc: Connection;
  readonly #limits: RouteLimits;

  constructor(signer: Keypair, rpc: Connection, limits: RouteLimits) {
    this.wallet = signer.publicKey.toBase58();
    this.#signer = signer;
    this.#rpc = rpc;
    this.#limits = limits;
  }

  async quote(side: "buy" | "sell", mintAddress: string, amount: bigint, minimumSlot: number, creator?: string,
    exactTokens = false): Promise<RouteQuote> {
    const mint = new PublicKey(mintAddress);
    const wallet = this.#signer.publicKey;
    const curve = bondingCurvePda(mint);
    const cfg = { commitment: "confirmed" as const, minContextSlot: minimumSlot };
    const initial = await this.#rpc.getMultipleAccountsInfoAndContext([mint, curve, wallet], cfg);
    const [mintAccount, curveAccount, walletAccount] = initial.value;
    const token = checkMint(mint, mintAccount ?? null);
    if (!curveAccount?.owner.equals(PUMP_PROGRAM_ID) || !walletAccount?.owner.equals(SystemProgram.programId) ||
        walletAccount.data.length !== 0) throw new Error("Unrecognized curve or wallet account");
    const bondingCurve = PUMP_SDK.decodeBondingCurve(curveAccount);
    if ((!bondingCurve.quoteMint.equals(PublicKey.default) && !bondingCurve.quoteMint.equals(NATIVE_MINT)) ||
        bondingCurve.isMayhemMode || bondingCurve.isCashbackCoin || bondingCurve.isHolderReward) {
      throw new Error("Unsupported live curve configuration");
    }
    const ata = ataFor(mint, wallet, token.program);
    const walletLamports = bigintAmount(walletAccount.lamports);
    if (bondingCurve.complete) {
      if (side === "buy") throw new Error("Live entries require a fresh bonding curve");
      return this.#poolSell(mint, wallet, token.program, ata, amount, initial.context.slot, walletLamports);
    }
    if (side === "buy" && (!creator || !bondingCurve.creator.equals(new PublicKey(creator)))) {
      throw new Error("Curve creator does not match the verified launch");
    }
    const context = await this.#rpc.getMultipleAccountsInfoAndContext([GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, ata],
      { ...cfg, minContextSlot: initial.context.slot });
    const [globalInfo, feeInfo, ataInfo] = context.value;
    if (!globalInfo?.owner.equals(PUMP_PROGRAM_ID) || !feeInfo?.owner.equals(PUMP_FEE_PROGRAM_ID)) {
      throw new Error("Unrecognized live fee state");
    }
    const global = PUMP_SDK.decodeGlobal(globalInfo);
    const feeConfig = PUMP_SDK.decodeFeeConfig(feeInfo);
    const associated = checkTokenAccount(ata, ataInfo ?? null, mint, wallet, token.program);
    const allowed = (approved: PublicKey[], current: PublicKey[]) =>
      approved.find(key => current.some(known => key.equals(known)) && !key.equals(PublicKey.default));
    const feeRecipient = allowed(this.#limits.feeRecipients, [global.feeRecipient, ...global.feeRecipients]);
    const buybackFeeRecipient = allowed(this.#limits.buybackRecipients, global.buybackFeeRecipients);
    if (!feeRecipient || !buybackFeeRecipient) throw new Error("No approved curve fee recipient");
    const state = { global, feeConfig, mintSupply: asBn(token.info.supply), bondingCurve, quoteMint: NATIVE_MINT };
    const tokens = side === "buy" && !exactTokens
      ? asBig(getBuyTokenAmountFromSolAmount({ ...state, amount: asBn(amount) }))
      : amount;
    const virtualToken = asBig(bondingCurve.virtualTokenReserves);
    const virtualSol = asBig(bondingCurve.virtualQuoteReserves);
    if (tokens <= 0n || (side === "buy" && (tokens >= virtualToken || tokens >= asBig(bondingCurve.realTokenReserves)))) {
      throw new Error("Insufficient live curve liquidity");
    }
    const rawSol = side === "buy"
      ? tokens * virtualSol / (virtualToken - tokens) + 1n
      : tokens * virtualSol / (virtualToken + tokens);
    const sol = side === "buy"
      ? asBig(getBuySolAmountFromTokenAmount({ ...state, amount: asBn(tokens) }))
      : asBig(getSellSolAmountFromTokenAmount({ ...state, amount: asBn(tokens) }));
    if (side === "sell" && rawSol > asBig(bondingCurve.realQuoteReserves)) throw new Error("Insufficient real curve SOL");
    checkImpact(side, tokens, virtualToken, virtualSol, rawSol, sol, this.#limits);
    return {
      venue: "curve", tokens, sol, slot: context.context.slot, ata, ataAmount: associated.amount,
      ataDeposit: associated.deposit, walletLamports, tokenProgram: token.program,
      makeInstructions: async limit => {
        const args = { mint, user: wallet, creator: bondingCurve.creator, amount: asBn(tokens), quoteAmount: asBn(limit),
          tokenProgram: token.program, feeRecipient, buybackFeeRecipient };
        const trade = side === "buy" ? await PUMP_SDK.getBuyV2InstructionRaw(args) : await PUMP_SDK.getSellV2InstructionRaw(args);
        const vault = creatorVaultPda(args.creator);
        const volume = userVolumeAccumulatorPda(wallet);
        const sharing = PublicKey.findProgramAddressSync([Buffer.from("sharing-config"), mint.toBuffer()], PUMP_FEE_PROGRAM_ID)[0];
        checkTrade(trade, PUMP_PROGRAM_ID, side, [
          GLOBAL_PDA, mint, NATIVE_MINT, token.program, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
          feeRecipient, ataFor(NATIVE_MINT, feeRecipient), buybackFeeRecipient, ataFor(NATIVE_MINT, buybackFeeRecipient),
          curve, ataFor(mint, curve, token.program), ataFor(NATIVE_MINT, curve), wallet, ata, ataFor(NATIVE_MINT, wallet),
          vault, ataFor(NATIVE_MINT, vault), sharing, ...(side === "buy" ? [GLOBAL_VOLUME_ACCUMULATOR_PDA] : []),
          volume, ataFor(NATIVE_MINT, volume), PUMP_FEE_CONFIG_PDA, PUMP_FEE_PROGRAM_ID, SystemProgram.programId,
          PUMP_EVENT_AUTHORITY_PDA, PUMP_PROGRAM_ID,
        ], tokens, limit, wallet, true);
        return side === "buy" && !ataInfo
          ? [createAssociatedTokenAccountIdempotentInstruction(wallet, ata, wallet, mint, token.program), trade]
          : [trade];
      },
    };
  }

  async #poolSell(mint: PublicKey, wallet: PublicKey, tokenProgram: PublicKey, ata: PublicKey,
    tokens: bigint, slot: number, walletLamports: bigint): Promise<RouteQuote> {
    const poolKey = canonicalPumpPoolPda(mint);
    const quoteAta = ataFor(NATIVE_MINT, wallet);
    const cfg = { commitment: "confirmed" as const, minContextSlot: slot };
    const accounts = await this.#rpc.getMultipleAccountsInfoAndContext([poolKey, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, ata, quoteAta], cfg);
    const [poolInfo, globalInfo, feeInfo, userAtaInfo, userQuoteInfo] = accounts.value;
    if (!poolInfo?.owner.equals(PUMP_AMM_PROGRAM_ID) || !globalInfo?.owner.equals(PUMP_AMM_PROGRAM_ID) ||
        !feeInfo?.owner.equals(PUMP_FEE_PROGRAM_ID) || userQuoteInfo) throw new Error("Unsupported canonical pool state or existing wallet WSOL ATA");
    const state = await new OnlinePumpAmmSdk(this.#rpc).swapSolanaState(poolKey, wallet);
    const pool = state.pool;
    if (!pool.baseMint.equals(mint) || !pool.quoteMint.equals(NATIVE_MINT) ||
        !pool.creator.equals(pumpPoolAuthorityPda(mint)) || !state.baseTokenProgram.equals(tokenProgram) ||
        !state.quoteTokenProgram.equals(TOKEN_PROGRAM_ID) || !state.userBaseTokenAccount.equals(ata) ||
        !state.userQuoteTokenAccount.equals(quoteAta) || state.userQuoteAccountInfo || !state.feeConfig ||
        pool.isMayhemMode || pool.isCashbackCoin || pool.isHolderReward ||
        !pool.poolBaseTokenAccount.equals(ataFor(mint, poolKey, tokenProgram)) ||
        !pool.poolQuoteTokenAccount.equals(ataFor(NATIVE_MINT, poolKey))) throw new Error("Unsupported canonical pool configuration");
    const approved = this.#limits.buybackRecipients.find(key => !key.equals(PublicKey.default) &&
      state.globalConfig.buybackFeeRecipients.some(known => known.equals(key)));
    if (!approved) throw new Error("No approved PumpSwap buyback recipient");
    const approvedAta = ataFor(NATIVE_MINT, approved);
    // The v2 builder chooses from this array. Supplying one already verified member makes selection deterministic.
    const restrictedState = { ...state, globalConfig: { ...state.globalConfig, buybackFeeRecipients: [approved] } };
    const quote = sellBaseInput({
      base: asBn(tokens), slippage: 0, baseReserve: state.poolBaseAmount, quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: pool.virtualQuoteReserves, feeBucketsTotal: pool.protocolFees.add(pool.creatorFees),
      globalConfig: state.globalConfig, baseMintAccount: state.baseMintAccount, baseMint: mint, coinCreator: pool.coinCreator,
      creator: pool.creator, feeConfig: state.feeConfig, quoteMint: NATIVE_MINT, creatorFeeBps: pool.creatorFeeBps,
    });
    const sol = asBig(quote.uiQuote);
    checkImpact("sell", tokens, asBig(state.poolBaseAmount), asBig(state.poolQuoteAmount.add(pool.virtualQuoteReserves)),
      asBig(quote.internalQuoteAmountOut), sol, this.#limits);
    const owned = checkTokenAccount(ata, userAtaInfo ?? null, mint, wallet, tokenProgram);
    return {
      venue: "pumpswap", tokens, sol, slot: accounts.context.slot, ata, ataAmount: owned.amount,
      ataDeposit: owned.deposit, walletLamports, tokenProgram,
      makeInstructions: async limit => {
        const instructions = await PUMP_AMM_SDK.sellV2Instructions(restrictedState, asBn(tokens), asBn(limit));
        const [create, trade, close] = instructions;
        const ataKeys = [wallet, quoteAta, wallet, NATIVE_MINT, SystemProgram.programId, TOKEN_PROGRAM_ID];
        if (instructions.length !== 3 || !create || !trade || !close ||
            !create.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || !sameKeys(create, ataKeys) ||
            !create.data.equals(Buffer.from([1])) || !close.programId.equals(TOKEN_PROGRAM_ID) ||
            !sameKeys(close, [quoteAta, wallet, wallet]) || !close.data.equals(Buffer.from([9]))) {
          throw new Error("Unexpected PumpSwap WSOL account setup");
        }
        checkTrade(trade, PUMP_AMM_PROGRAM_ID, "sell", [
          poolKey, wallet, GLOBAL_CONFIG_PDA, mint, NATIVE_MINT, ata, quoteAta, pool.poolBaseTokenAccount,
          pool.poolQuoteTokenAccount, tokenProgram, TOKEN_PROGRAM_ID, SystemProgram.programId, ammUserVolumeAccumulatorPda(wallet),
          PUMP_AMM_FEE_CONFIG_PDA, approvedAta, PUMP_AMM_EVENT_AUTHORITY_PDA, PUMP_AMM_PROGRAM_ID,
        ], tokens, limit, wallet, false);
        return instructions;
      },
    };
  }

  async prepare(intent: LiveIntent, caps: LiveCaps): Promise<SignedAttempt> {
    const quote = await this.quote(intent.side, intent.mint, intent.tokens, intent.minimumSlot, intent.creator, true);
    if (quote.venue !== intent.venue || quote.tokens !== intent.tokens ||
        (intent.side === "buy" && quote.sol > intent.limitLamports) ||
        (intent.side === "sell" && (quote.sol < intent.limitLamports || quote.ataAmount < intent.tokens))) {
      throw new Error("Live route, ownership or price changed");
    }
    if (intent.side === "buy" && quote.walletLamports > caps.maxWalletLamports) throw new Error("Live wallet balance cap exceeded");
    const prepDebit = caps.maxNetworkFeeLamports + caps.maxAccountDepositLamports +
      (intent.side === "buy" ? intent.limitLamports : 0n);
    if (quote.walletLamports < prepDebit) throw new Error("Insufficient SOL for bounded trade and account setup");
    const limits = this.#limits;
    const swapInstructions = await quote.makeInstructions(intent.limitLamports);
    const wallet = this.#signer.publicKey;
    const latest = await this.#rpc.getLatestBlockhash({ commitment: "confirmed", minContextSlot: quote.slot });
    const message = new TransactionMessage({
      payerKey: wallet, recentBlockhash: latest.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: limits.computeUnitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: limits.microLamportsPerUnit }),
        ...swapInstructions,
      ],
    }).compileToV0Message();
    if (message.header.numRequiredSignatures !== 1 || !message.staticAccountKeys[0]!.equals(wallet)) throw new Error("Unexpected live signers");
    const fee = (await this.#rpc.getFeeForMessage(message, "confirmed")).value;
    if (fee === null || bigintAmount(fee) > caps.maxNetworkFeeLamports) throw new Error("Unusable live network fee");
    const tx = new VersionedTransaction(message);
    // First simulate the exact message with empty signatures. Only sign after instruction and balance checks pass.
    const simulation = await this.#rpc.simulateTransaction(tx, {
      commitment: "confirmed", minContextSlot: quote.slot, sigVerify: false, replaceRecentBlockhash: false,
      accounts: { encoding: "base64", addresses: [wallet.toBase58(), quote.ata.toBase58()] },
    });
    const [postWallet, postToken] = simulation.value.accounts ?? [];
    if (simulation.value.err || !postWallet || !postToken || !postToken.data[0] ||
        postWallet.owner !== SystemProgram.programId.toBase58()) throw new Error("Live simulation failed or omitted balances");
    const checked = checkTokenAccount(quote.ata, {
      lamports: postToken.lamports, rentEpoch: postToken.rentEpoch, owner: new PublicKey(postToken.owner),
      executable: postToken.executable, data: Buffer.from(postToken.data[0], "base64"),
    }, new PublicKey(intent.mint), wallet, quote.tokenProgram);
    const rent = checked.deposit - quote.ataDeposit;
    const grossWalletDelta = bigintAmount(postWallet.lamports) - quote.walletLamports + rent + bigintAmount(fee);
    if (rent < 0n || rent > caps.maxAccountDepositLamports ||
        checked.amount - quote.ataAmount !== (intent.side === "buy" ? intent.tokens : -intent.tokens) ||
        (intent.side === "buy" ? grossWalletDelta >= 0n || -grossWalletDelta > intent.limitLamports
          : grossWalletDelta < intent.limitLamports)) throw new Error("Unacceptable simulated wallet balance changes");
    tx.sign([this.#signer]);
    return { blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight,
      signature: bs58.encode(tx.signatures[0]!), wire: Buffer.from(tx.serialize()).toString("base64") };
  }

  send(attempt: SignedAttempt): Promise<string> {
    return this.#rpc.sendRawTransaction(Buffer.from(attempt.wire, "base64"),
      { maxRetries: 0, skipPreflight: false, preflightCommitment: "confirmed" });
  }

  async inspect(attempt: SignedAttempt, intent: LiveIntent): Promise<{ outcome: "valid" | "seen" | "ambiguous" } | Settlement> {
    const resp = await this.#rpc.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true });
    const status = resp.value[0];
    if (status && status.confirmationStatus !== "finalized") return { outcome: "seen" };
    if (!status) {
      const height = await this.#rpc.getBlockHeight("finalized");
      if (height <= attempt.lastValidBlockHeight) return { outcome: "valid" };
    }
    const landed = await this.#rpc.getTransaction(attempt.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    const meta = landed?.meta;
    if (!landed || !meta || landed.transaction.signatures[0] !== attempt.signature ||
        landed.transaction.message.staticAccountKeys[0]?.toBase58() !== this.wallet) return { outcome: "ambiguous" };
    const preSol = meta.preBalances[0];
    const postSol = meta.postBalances[0];
    if (preSol === undefined || postSol === undefined || !meta.preTokenBalances || !meta.postTokenBalances) {
      return { outcome: "ambiguous" };
    }
    function ownerTokens(
      side: NonNullable<typeof meta>["preTokenBalances"], balances: number[], wallet: string,
    ) {
      const result = { tokens: 0n, rent: 0n };
      for (const balance of side ?? []) {
        if (balance.owner !== wallet || balance.mint !== intent.mint) continue;
        const lamports = balances[balance.accountIndex];
        if (lamports === undefined) throw new Error("Missing finalized token account lamports");
        result.tokens += BigInt(balance.uiTokenAmount.amount);
        result.rent += bigintAmount(lamports);
      }
      return result;
    }
    const pre = ownerTokens(meta.preTokenBalances, meta.preBalances, this.wallet);
    const post = ownerTokens(meta.postTokenBalances, meta.postBalances, this.wallet);
    return { outcome: meta.err ? "failed" : "filled", slot: landed.slot, fee: bigintAmount(meta.fee),
      filledAt: landed.blockTime == null ? undefined : landed.blockTime * 1000,
      solDelta: bigintAmount(postSol) - bigintAmount(preSol), tokenDelta: post.tokens - pre.tokens, rentDelta: post.rent - pre.rent };
  }
}
