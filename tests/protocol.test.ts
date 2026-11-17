import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { canonicalPoolAddress, decodeTransaction } from "../src/protocol.ts";
import type { RpcTransaction } from "../src/protocol.ts";
import { PUMPSWAP_PROGRAM, PUMP_PROGRAM, SOL_MINT, TOKEN_PROGRAM } from "../src/protocol-types.ts";

const provenance = { provider: "fixture", receivedAtMs: 1_800_000_000_000, commitment: "finalized" as const };
const fixture = (name: string): RpcTransaction => {
  const contents = readFileSync(new URL(`../fixtures/${name}.redacted.json`, import.meta.url), "utf8");
  return (JSON.parse(contents) as { transaction: RpcTransaction }).transaction;
};

const publicCreate = () => fixture("public-create-v0");
const mint = "4wgn7wZCspYYjcB8ccfVjjguff8yUt9aywCa8fyEpump";
const creator = "F9gve2MzQY1WHeSX3Cjiwsw9TFbq4nN5pFXsx4ZLDCUT";
const curve = "2KM6CxFY8seXcKGbSirzkVTbpGUBUetE3qAmwtBqSAfY";
const system = "11111111111111111111111111111111";

test("public v0 launch and initial buy resolve loaded accounts and decode exact reserves and fees", () => {
  const raw = publicCreate();
  assert.equal(raw.version, 0);
  assert.ok(raw.meta?.loadedAddresses?.readonly.length);
  const [launch, trade] = decodeTransaction(raw, provenance);
  assert.ok(launch?.kind === "launch" && trade?.kind === "trade");
  assert.equal(launch.mint, mint);
  assert.equal(launch.creator, creator);
  assert.equal(launch.launchUser, creator);
  assert.ok(launch.signers.includes(creator));
  assert.equal(launch.bondingCurve, curve);
  assert.equal(launch.quoteMint, SOL_MINT);
  assert.equal(launch.supported, true);
  assert.deepEqual(launch.tokenExtensions, ["metadataPointer", "tokenMetadata"]);
  assert.equal(launch.reserves?.realSol, "0");
  assert.equal(launch.creatorInitialBuyLamports, "1466275660");
  assert.equal(trade.quoteAmount, "1466275660");
  assert.equal(trade.side, "buy");
  assert.equal(trade.canonical, true);
  assert.deepEqual(trade.reserves, {
    virtualToken: "1023000000000000", realToken: "743100000000000", virtualSol: "31466275660",
    realSol: "1466275660", feeBps: 125, complete: false,
  });
});

test("failed public v1 transaction does not emit a launch despite running CreateV2", () => {
  const raw = fixture("public-failed-v1");
  assert.equal(raw.version, 1);
  assert.notEqual(raw.meta?.err, null);
  assert.deepEqual(decodeTransaction(raw, provenance), []);
});

test("inner CreateV2 uses the actual inner program and transaction signers", () => {
  const raw = publicCreate();
  const msg = raw.transaction.message;
  const creation = msg.instructions[2]!;
  const inner = raw.meta!.innerInstructions!.find(group => group.index === 2)!;
  // Put the genuine compiled create under an artificial router. Anchor event
  // CPI and token initializers keep their relative stacks.
  msg.instructions[2] = { ...msg.instructions[0]!, accounts: [] };
  inner.instructions = [
    { ...creation, stackHeight: 2 },
    ...inner.instructions.map(ix => ({ ...ix, stackHeight: ix.stackHeight! + 1 })),
  ];
  const [launch] = decodeTransaction(raw, provenance);
  assert.ok(launch?.kind === "launch");
  assert.deepEqual(launch.instructionPath, [2, 0]);
  assert.equal(launch.creator, creator);
  assert.equal(launch.supported, true);
  inner.instructions[0]!.programIdIndex = msg.instructions[0]!.programIdIndex;
  assert.equal(decodeTransaction(raw, provenance).some(event => event.kind === "launch"), false);
});

test("unsupported launch quote and Token-2022 mint extension are recorded without an eligible launch", () => {
  const raw = publicCreate();
  const launchIx = raw.transaction.message.instructions[2]!;
  launchIx.accounts.push(launchIx.accounts[5]!);
  let [launch] = decodeTransaction(raw, provenance);
  assert.ok(launch?.kind === "launch");
  // The account quote disagrees with the chain's event. Either source rules
  // this mutation out, even when a fabricated event mentions native SOL.
  assert.equal(launch.supported, false);
  assert.equal(launch.unsupportedReason, "unsupported_quote_mint");
  launchIx.accounts.pop();
  const inner = raw.meta!.innerInstructions!.find(group => group.index === 2)!;
  const pointer = inner.instructions.find(ix => bs58.decode(ix.data)[0] === 39)!;
  pointer.data = bs58.encode(Buffer.of(26, 0)); // a different extension operation
  [launch] = decodeTransaction(raw, provenance);
  assert.ok(launch?.kind === "launch");
  assert.equal(launch.supported, false);
  assert.equal(launch.unsupportedReason, "token2022_extensions_unknown");
});

test("legacy create does not infer creator signature from the decoded creator field", () => {
  const raw: RpcTransaction = {
    slot: 10, meta: { err: null },
    transaction: { signatures: ["payer", "mint"], message: {
      accountKeys: [creator, mint, curve, PUMP_PROGRAM, TOKEN_PROGRAM, system],
      header: { numRequiredSignatures: 2 },
      instructions: [{
        programIdIndex: 3, accounts: [1, 5, 2, 5, 5, 5, 5, 0, 5, 4, 5, 5, 5, 3],
        data: bs58.encode(Buffer.concat([Buffer.from("181ec82805080777", "hex"),
          Buffer.alloc(12), Buffer.from(bs58.decode(system))])),
      }],
    } },
  };
  const [launch] = decodeTransaction(raw, provenance);
  assert.ok(launch?.kind === "launch");
  assert.equal(launch.createInstruction, "create");
  assert.equal(launch.creator, system);
  assert.equal(launch.launchUser, creator);
  assert.deepEqual(launch.signers, [creator, mint]);
  assert.equal(launch.supported, true);
  assert.equal(launch.reserves, undefined);
});

test("migration derives the canonical PumpSwap pool from the zero index and mint", () => {
  const pool = canonicalPoolAddress(mint, SOL_MINT);
  const raw: RpcTransaction = {
    slot: 20, meta: { err: null },
    transaction: { signatures: ["payer"], message: {
      accountKeys: [creator, mint, curve, PUMP_PROGRAM, PUMPSWAP_PROGRAM, SOL_MINT, pool],
      header: { numRequiredSignatures: 1 },
      instructions: [{
        programIdIndex: 3, accounts: [0, 0, 1, 2, 0, 0, 0, 0, 4, 6, 0, 0, 0, 0, 5, 0, 0, 0, 0],
        data: bs58.encode(Buffer.from("9beae792ec9ea21e", "hex")),
      }],
    } },
  };
  const [event] = decodeTransaction(raw, provenance);
  assert.ok(event?.kind === "migration");
  assert.equal(event.pool, pool);
  assert.equal(event.canonical, true);
  assert.equal(event.reserves, undefined);
  raw.transaction.message.instructions[0]!.accounts[9] = 0;
  const [forged] = decodeTransaction(raw, provenance);
  assert.ok(forged?.kind === "migration");
  assert.equal(forged.canonical, false);
});

test("PumpSwap sells use canonical post-trade vault balances minus fees held for sweep", () => {
  const pool = canonicalPoolAddress(mint, SOL_MINT);
  const authority = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")],
    new PublicKey(PUMPSWAP_PROGRAM))[0].toBase58();
  const key = (address: string) => Buffer.from(bs58.decode(address));
  const ints = (...values: bigint[]) => {
    const data = Buffer.alloc(values.length * 8);
    for (const [i, value] of values.entries()) data.writeBigUInt64LE(value, 8 * i);
    return data;
  };
  const sell = { programIdIndex: 5, accounts: [3, 0, 4, 1, 2, 4, 4, 7, 8],
    data: bs58.encode(Buffer.from("33e685a4017f83ad", "hex")) };
  const swapEvent = Buffer.concat([
    Buffer.from("e445a52e51cb9a1d3e2f370aa503dc2a", "hex"),
    ints(1n, 400n, 10n, 500n, 500n, 100_000n, 5000n, 25n, 20n, 1n, 5n, 1n, 24n, 20n),
    key(pool), key(creator), key(system), key(system), key(system), key(system), key(creator),
    ints(30n, 1n, 0n, 0n, 5000n, 1n, BigInt.asUintN(64, -10n), (1n << 64n) - 1n),
    Buffer.of(0), ints(1_000_000n, 0n, 0n, 1n),
  ]);
  const raw: RpcTransaction = {
    slot: 20, meta: {
      err: null, postTokenBalances: [
        { accountIndex: 7, mint, uiTokenAmount: { amount: "100400" } },
        { accountIndex: 8, mint: SOL_MINT, uiTokenAmount: { amount: "4980" } },
      ],
      innerInstructions: [{ index: 0, instructions: [
        { programIdIndex: 5, accounts: [6], data: bs58.encode(swapEvent), stackHeight: 2 },
      ] }],
    },
    transaction: { signatures: ["payer"], message: {
      accountKeys: [creator, mint, SOL_MINT, pool, system, PUMPSWAP_PROGRAM, authority, curve, PUMP_PROGRAM],
      header: { numRequiredSignatures: 1 },
      instructions: [sell],
    } },
  };
  const [trade] = decodeTransaction(raw, provenance);
  assert.ok(trade?.kind === "trade");
  assert.equal(trade.side, "sell");
  assert.equal(trade.canonical, true);
  assert.deepEqual(trade.reserves, {
    virtualToken: "100400", realToken: "100400", virtualSol: "4970", realSol: "4970", feeBps: 55, complete: false,
  });
  raw.transaction.message.instructions.push(sell);
  const ambiguous = decodeTransaction(raw, provenance);
  assert.equal(ambiguous.length, 2);
  assert.ok(ambiguous.every(event => event.reserves === undefined));
});
