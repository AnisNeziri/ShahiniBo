import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import type { AccountInfo, Connection } from "@solana/web3.js";
import { AccountLayout, AccountState, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SDK } from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_PROGRAM_ID, canonicalPumpPoolPda, pumpPoolAuthorityPda } from "@pump-fun/pump-swap-sdk";
import { LiveExecutor, liveStatus, setLiveControl } from "../src/live-execution.ts";
import type { LiveCaps, LiveIntent, LiveTransport, Settlement } from "../src/live-execution.ts";
import { SolanaTransport } from "../src/live-solana.ts";
import { validateExitPolicy } from "../src/exits.ts";

const caps: LiveCaps = {
  maxWalletLamports: 2_000_000_000n, maxEntryLamports: 30_000_000n, maxExposureLamports: 60_000_000n,
  maxNetworkFeeLamports: 10_000n, maxAccountDepositLamports: 2_100_000n,
  dailyLossLamports: 75_000_000n, maxOpenPositions: 2, maxBroadcasts: 2,
};

function buy(id = "buy-one", mint = "one"): LiveIntent {
  return { operationId: id, mint, side: "buy", venue: "curve", tokens: 10n, limitLamports: 10_000_000n,
    minimumSlot: 42, expiresAt: Date.now() + 30_000 };
}

test("ambiguous broadcasts persist before send and reconcile once across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shahini-live-"));
  const path = join(dir, "test.live.sqlite");
  let outcome: Awaited<ReturnType<LiveTransport["inspect"]>> = { outcome: "valid" };
  let prepares = 0;
  const broadcasts: string[] = [];
  const transport: LiveTransport = {
    wallet: "dedicated-test-wallet",
    async prepare() {
      prepares++;
      return { signature: "sig", wire: "canonical-wire", blockhash: "hash", lastValidBlockHeight: 100 };
    },
    async send(attempt) {
      assert.equal(liveStatus(path).attempts[0]?.signature, attempt.signature);
      assert.equal(liveStatus(path).attempts[0]?.broadcasts, broadcasts.length + 1);
      broadcasts.push(attempt.wire);
      throw new Error("provider timeout after accepting submission");
    },
    async inspect() { return outcome; },
  };
  const intent = buy();
  let live = new LiveExecutor(path, transport, caps);
  try {
    assert.equal(live.control(), "paused");
    assert.throws(() => new LiveExecutor(path, transport, caps), /EEXIST/);
    setLiveControl(path, "active");
    assert.equal(await live.execute(intent, () => live.control() === "active"), "ambiguous");
    assert.equal(await live.execute(intent, () => true), "ambiguous");
    await assert.rejects(live.execute({ ...intent, tokens: 11n }, () => true), /reused/);
    await assert.rejects(live.execute(buy("other", "other"), () => true), /blocks new entries/);
    await live.close();
    live = new LiveExecutor(path, transport, caps);
    await live.recover(() => true);
    assert.deepEqual(broadcasts, ["canonical-wire", "canonical-wire"]);
    assert.equal(prepares, 1);
    outcome = { outcome: "ambiguous" };
    await live.recover(() => true);
    assert.equal(await live.execute(intent, () => true), "ambiguous");
    assert.equal(live.positions().length, 0);
    outcome = { outcome: "filled", slot: 44, tokenDelta: 10n, solDelta: -12_044_280n,
      rentDelta: 2_039_280n, fee: 5_000n, filledAt: 1_700_000_000_000 };
    await live.recover(() => true);
    await live.recover(() => true);
    assert.equal(await live.execute(intent, () => true), "confirmed");
    assert.deepEqual(live.positions(), [{ mint: "one", tokens: 10n, cost: 10_005_000n, filledAt: 1_700_000_000_000 }]);
    assert.equal(live.status().lastFinalizedSlot, 44);
    assert.equal(prepares, 1);
    assert.equal(live.hasSourceSignature("unknown"), false);
  } finally {
    await live.close();
    // mkdtemp returned this test's own root. Only that directory is removed.
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalized failed sell keeps the entire position and durable kill permits exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shahini-live-"));
  const path = join(dir, "test.live.sqlite");
  const outcomes = new Map<string, Settlement>();
  const transport: LiveTransport = {
    wallet: "dedicated-test-wallet",
    async prepare(intent) {
      return { signature: intent.operationId, wire: intent.operationId, blockhash: "hash", lastValidBlockHeight: 100 };
    },
    async send(attempt) { return attempt.signature; },
    async inspect(attempt) { return outcomes.get(attempt.signature) ?? { outcome: "seen" }; },
  };
  const live = new LiveExecutor(path, transport, caps);
  try {
    const entry = buy();
    setLiveControl(path, "active");
    await live.execute(entry, () => live.control() === "active");
    outcomes.set(entry.operationId, { outcome: "filled", tokenDelta: 10n, solDelta: -10_005_000n,
      fee: 5_000n, rentDelta: 0n, slot: 45 });
    await live.recover(() => true);
    assert.equal(setLiveControl(path, "killed"), "killed");
    assert.throws(() => setLiveControl(path, "active"), /latched/);
    await assert.rejects(live.execute(buy("other", "another"), () => live.control() === "active"), /paused/);
    const sell = { ...entry, operationId: "exit-1", side: "sell", limitLamports: 11_000_000n } as const;
    await assert.rejects(live.execute({ ...sell, tokens: 11n }, () => false), /entire recorded live position/);
    await live.execute(sell, () => false);
    outcomes.set(sell.operationId, { outcome: "failed", tokenDelta: 0n, solDelta: -5_000n, fee: 5_000n, rentDelta: 0n, slot: 46 });
    await live.recover(() => false);
    assert.equal(live.positions()[0]?.tokens, 10n);
    const afterMigration = { ...sell, operationId: "exit-2", venue: "pumpswap" } as const;
    await live.execute(afterMigration, () => false);
    outcomes.set(afterMigration.operationId, { outcome: "filled", tokenDelta: -10n, solDelta: 11_995_000n,
      fee: 5_000n, rentDelta: 0n, slot: 48 });
    await live.recover(() => false);
    assert.equal(live.positions().length, 0);
    assert.equal(live.status().control, "killed");
    assert.deepEqual(live.status().attempts.map(row => row.state), ["confirmed", "failed", "confirmed"]);
  } finally {
    await live.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a timed-out live TP survives restart and the latched stop sells only its finalized remainder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shahini-live-ladder-"));
  const path = join(dir, "ladder.live.sqlite");
  const results = new Map<string, Settlement>();
  const sends: string[] = [];
  const transport: LiveTransport = {
    wallet: "test-wallet",
    async prepare(intent) {
      return { signature: intent.operationId, wire: intent.operationId, blockhash: "hash", lastValidBlockHeight: 100 };
    },
    async send(attempt) {
      sends.push(attempt.signature);
      if (attempt.signature === "tp-one") throw new Error("submission timeout");
      return attempt.signature;
    },
    async inspect(attempt) { return results.get(attempt.signature) ?? { outcome: "seen" }; },
  };
  let live = new LiveExecutor(path, transport, caps);
  try {
    const entry = { ...buy(), tokens: 103n, exitPolicy: validateExitPolicy({ version: "live-fixture",
      takeProfits: [{ label: "TP1", unit: "net_pnl_percent", value: "20", sellPercent: "25" }],
      stop: { unit: "net_pnl_sol", value: "-0.005" } }) };
    setLiveControl(path, "active");
    await live.execute(entry, () => true);
    results.set(entry.operationId, { outcome: "filled", tokenDelta: 103n, solDelta: -10_005_000n,
      fee: 5_000n, rentDelta: 0n, slot: 45 });
    await live.recover(() => true);
    const tp: LiveIntent = { ...entry, operationId: "tp-one", side: "sell", trigger: "TP1", tokens: 25n, limitLamports: 3_000_000n };
    assert.equal(await live.execute(tp, () => false), "ambiguous");
    live.latchTerminal(entry.mint, "stop_loss");
    const stop: LiveIntent = { ...tp, operationId: "stop-one", venue: "pumpswap", tokens: 78n, trigger: "stop_loss", limitLamports: 5_000_000n };
    await assert.rejects(live.execute(stop, () => false), /Unresolved/);
    await live.close();
    live = new LiveExecutor(path, transport, caps);
    assert.equal(live.positions()[0]?.exit?.progress.legs.TP1?.state, "pending");
    assert.equal(live.positions()[0]?.exit?.progress.terminal, "stop_loss");
    results.set(tp.operationId, { outcome: "filled", tokenDelta: -25n, solDelta: 3_200_000n,
      fee: 5_000n, rentDelta: 0n, slot: 47 });
    await live.recover(() => false);
    assert.equal(live.positions()[0]?.tokens, 78n);
    assert.equal(live.positions()[0]?.exit?.progress.legs.TP1?.soldTokens, "25");
    assert.equal(await live.execute(tp, () => false), "confirmed");
    setLiveControl(path, "killed");
    await live.execute(stop, () => false);
    results.set(stop.operationId, { outcome: "filled", tokenDelta: -78n, solDelta: 5_200_000n,
      fee: 5_000n, rentDelta: 0n, slot: 49 });
    await live.recover(() => false);
    assert.equal(live.positions().length, 0);
    assert.deepEqual(sends, ["buy-one", "tp-one", "stop-one"]);
    const pnl = live.status().recentSettlements.reduce((total, row) => total + BigInt(String(row.realizedPnl)), 0n);
    assert.equal(pnl, -1_605_000n);
  } finally {
    await live.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("official curve builder checks accounts, simulates unsigned, then signs with an offline test key", async (t) => {
  const signer = Keypair.fromSeed(new Uint8Array(32).fill(42));
  const pub = (byte: number) => Keypair.fromSeed(new Uint8Array(32).fill(byte)).publicKey;
  const mint = pub(1);
  const creator = pub(2);
  const recipient = pub(3);
  const buyback = pub(4);
  const blockhash = pub(5).toBase58();
  const account = (owner: PublicKey, data = Buffer.alloc(0), lamports = 1_000_000_000): AccountInfo<Buffer> =>
    ({ owner, data, lamports, executable: false, rentEpoch: 0 });
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1_000_000_000_000n,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  const curveData = Buffer.alloc(115);
  createHash("sha256").update("account:BondingCurve").digest().copy(curveData, 0, 0, 8);
  [1_000_000_000_000n, 30_000_000_000n, 800_000_000_000n, 1_000_000_000n, 1_000_000_000_000n]
    .forEach((value, i) => curveData.writeBigUInt64LE(value, 8 + i * 8));
  creator.toBuffer().copy(curveData, 49);
  const z = new BN(0);
  const fees = { lpFeeBps: z, protocolFeeBps: new BN(100), creatorFeeBps: z };
  t.mock.method(PUMP_SDK, "decodeGlobal", () => ({
    feeRecipient: recipient, feeRecipients: [], buybackFeeRecipients: [buyback], feeBasisPoints: new BN(100),
    creatorFeeBasisPoints: z, creatorFeeConfigurable: false,
  }));
  t.mock.method(PUMP_SDK, "decodeFeeConfig", () => ({ flatFees: fees, stableFeeTiers: [], feeTiers: [{
    marketCapLamportsThreshold: z, fees,
  }], exoticFlatFees: { lpFeeBps: z, protocolFeeBps: z, creatorFeeBps: z } }));
  let quoteSol = 0n;
  let tokens = 0n;
  let simulated = 0;
  const rpc = {
    async getMultipleAccountsInfoAndContext(keys: PublicKey[]) {
      return { context: { slot: 11 }, value: keys[0]?.equals(mint)
        ? [account(TOKEN_PROGRAM_ID, mintData), account(PUMP_PROGRAM_ID, curveData), account(SystemProgram.programId)]
        : [account(PUMP_PROGRAM_ID), account(PUMP_FEE_PROGRAM_ID), null] };
    },
    async getLatestBlockhash() { return { blockhash, lastValidBlockHeight: 15 }; },
    async getFeeForMessage() { return { value: 5_000 }; },
    async simulateTransaction(tx: VersionedTransaction) {
      simulated++;
      assert.equal(tx.signatures[0]?.every(byte => byte === 0), true);
      const deposit = 2_039_280;
      const tokenData = Buffer.alloc(AccountLayout.span);
      AccountLayout.encode({
        mint, owner: signer.publicKey, amount: tokens, delegateOption: 0, delegate: PublicKey.default,
        state: AccountState.Initialized, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
        closeAuthorityOption: 0, closeAuthority: PublicKey.default,
      }, tokenData);
      return { value: { err: null, accounts: [
        { ...account(SystemProgram.programId, undefined, 1_000_000_000 - Number(quoteSol) - 5_000 - deposit),
          owner: SystemProgram.programId.toBase58(), data: ["", "base64"] },
        { ...account(TOKEN_PROGRAM_ID, tokenData, deposit),
          owner: TOKEN_PROGRAM_ID.toBase58(), data: [tokenData.toString("base64"), "base64"] },
      ] } };
    },
  } as unknown as Connection;
  const transport = new SolanaTransport(signer, rpc, { feeRecipients: [recipient], buybackRecipients: [buyback],
    maxVenueFeeBps: 300, maxEntryImpactBps: 100, maxExitImpactBps: 100,
    computeUnitLimit: 300_000, microLamportsPerUnit: 0, timeoutMs: 1_000 });
  const quote = await transport.quote("buy", mint.toBase58(), 10_000_000n, 10, creator.toBase58());
  quoteSol = quote.sol;
  tokens = quote.tokens;
  const intent: LiveIntent = { ...buy(), mint: mint.toBase58(), creator: creator.toBase58(), tokens, minimumSlot: 10 };
  await assert.rejects(transport.prepare({ ...intent, creator: recipient.toBase58() }, caps), /verified launch/);
  const signed = await transport.prepare(intent, caps);
  const tx = VersionedTransaction.deserialize(Buffer.from(signed.wire, "base64"));
  assert.equal(signed.blockhash, blockhash);
  assert.equal(tx.signatures[0]?.some(byte => byte !== 0), true);
  assert.equal(simulated, 1);
});

test("official PumpSwap builder uses the canonical SOL pool for a graduated position", async (t) => {
  const signer = Keypair.fromSeed(new Uint8Array(32).fill(40));
  const wallet = signer.publicKey;
  const pub = (byte: number) => Keypair.fromSeed(new Uint8Array(32).fill(byte)).publicKey;
  const mint = pub(1);
  const creator = pub(2);
  const approved = pub(3);
  const poolKey = canonicalPumpPoolPda(mint);
  const baseAccount = getAssociatedTokenAddressSync(mint, wallet);
  const quoteAccount = getAssociatedTokenAddressSync(NATIVE_MINT, wallet);
  const blockhash = pub(4).toBase58();
  const amount = 900_000_000n;
  const supply = 1_000_000_000_000n;
  const deposit = 2_039_280;
  const z = new BN(0);
  const account = (owner: PublicKey, data = Buffer.alloc(0), lamports = 1_000_000_000): AccountInfo<Buffer> =>
    ({ owner, data, lamports, executable: false, rentEpoch: 0 });
  const mintRaw = { mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default } as const;
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode(mintRaw, mintData);
  const curveData = Buffer.alloc(115);
  createHash("sha256").update("account:BondingCurve").digest().copy(curveData, 0, 0, 8);
  curveData[48] = 1;
  creator.toBuffer().copy(curveData, 49);
  function tokenData(amount: bigint) {
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode({
      mint, owner: wallet, amount, delegateOption: 0, delegate: PublicKey.default,
      state: AccountState.Initialized, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
      closeAuthorityOption: 0, closeAuthority: PublicKey.default,
    }, data);
    return data;
  }
  const fees = { lpFeeBps: new BN(25), protocolFeeBps: new BN(30), creatorFeeBps: new BN(10) };
  t.mock.method(OnlinePumpAmmSdk.prototype, "swapSolanaState", async (key: PublicKey) => {
    assert(key.equals(poolKey));
    return { globalConfig: { buybackFeeRecipients: [approved], creatorFeeConfigurable: false }, poolKey,
      pool: { baseMint: mint, quoteMint: NATIVE_MINT, creator: pumpPoolAuthorityPda(mint), coinCreator: creator,
        poolBaseTokenAccount: getAssociatedTokenAddressSync(mint, poolKey, true),
        poolQuoteTokenAccount: getAssociatedTokenAddressSync(NATIVE_MINT, poolKey, true),
        protocolFees: z, creatorFees: z, virtualQuoteReserves: z, creatorFeeBps: z },
      poolBaseAmount: new BN(supply.toString()), poolQuoteAmount: new BN("30000000000"),
      baseTokenProgram: TOKEN_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID, baseMint: mint,
      baseMintAccount: mintRaw, user: wallet, userBaseTokenAccount: baseAccount, userQuoteTokenAccount: quoteAccount,
      userBaseAccountInfo: account(TOKEN_PROGRAM_ID, tokenData(amount), deposit), userQuoteAccountInfo: null,
      feeConfig: { flatFees: fees, feeTiers: [{ marketCapLamportsThreshold: z, fees }] } };
  });
  let proceeds = 0n;
  let simulated = 0;
  const rpc = {
    async getMultipleAccountsInfoAndContext(keys: PublicKey[]) {
      return { context: { slot: 14 }, value: keys[0]?.equals(mint)
        ? [account(TOKEN_PROGRAM_ID, mintData), account(PUMP_PROGRAM_ID, curveData), account(SystemProgram.programId)]
        : [account(PUMP_AMM_PROGRAM_ID), account(PUMP_AMM_PROGRAM_ID), account(PUMP_FEE_PROGRAM_ID),
          account(TOKEN_PROGRAM_ID, tokenData(amount), deposit), null] };
    },
    async getLatestBlockhash() { return { blockhash, lastValidBlockHeight: 19 }; },
    async getFeeForMessage() { return { value: 5_000 }; },
    async simulateTransaction(tx: VersionedTransaction) {
      simulated++;
      assert.equal(tx.signatures[0]?.every(byte => byte === 0), true);
      return { value: { err: null, accounts: [
        { ...account(SystemProgram.programId, undefined, 1_000_000_000 + Number(proceeds) - 5_000),
          owner: SystemProgram.programId.toBase58(), data: ["", "base64"] },
        { ...account(TOKEN_PROGRAM_ID, undefined, deposit),
          owner: TOKEN_PROGRAM_ID.toBase58(), data: [tokenData(0n).toString("base64"), "base64"] },
      ] } };
    },
  } as unknown as Connection;
  const transport = new SolanaTransport(signer, rpc, { feeRecipients: [approved], buybackRecipients: [approved],
    maxVenueFeeBps: 300, maxEntryImpactBps: 100, maxExitImpactBps: 100,
    computeUnitLimit: 300_000, microLamportsPerUnit: 0, timeoutMs: 1_000 });
  const quote = await transport.quote("sell", mint.toBase58(), amount, 13);
  proceeds = quote.sol;
  assert.equal(quote.venue, "pumpswap");
  const intent: LiveIntent = { ...buy(), operationId: "sell-graduated", mint: mint.toBase58(), side: "sell",
    venue: "pumpswap", tokens: amount, limitLamports: proceeds * 99n / 100n, minimumSlot: 13 };
  const signed = await transport.prepare(intent, caps);
  const tx = VersionedTransaction.deserialize(Buffer.from(signed.wire, "base64"));
  assert.equal(tx.signatures[0]?.some(byte => byte !== 0), true);
  assert.equal(simulated, 1);
});
