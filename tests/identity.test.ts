import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import bs58 from "bs58";
import { delegationMessage, verifyCreator } from "../src/identity.ts";
import type { CreatorRecord, Delegation } from "../src/identity.ts";
import { PUMP_PROGRAM, SOL_MINT } from "../src/protocol-types.ts";
import type { LaunchEvent } from "../src/protocol-types.ts";

test("point-in-time creator matching and exact, scoped delegated launch authorization", () => {
  const creator = generateKeyPairSync("ed25519");
  const wallet = bs58.encode(creator.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const payer = "Vote111111111111111111111111111111111111111";
  const entry: CreatorRecord = {
    wallet, alias: "test creator", method: "wallet-challenge", evidenceRef: "fixture",
    verifiedAtMs: 1, activeAtMs: 2, revokedAtMs: 30,
  };
  const direct: LaunchEvent = {
    kind: "launch", mint: "mint-a", quoteMint: SOL_MINT, creator: wallet, launchUser: wallet,
    signers: [wallet], supported: true, provider: "synthetic", slot: 1, signature: "sig",
    receivedAtMs: 10, instructionPath: [0], commitment: "confirmed",
  };
  const delegate = { ...direct, launchUser: payer, signers: [payer] };
  const delegation: Delegation = {
    mint: delegate.mint, launchUser: payer, venue: PUMP_PROGRAM,
    issuedAtMs: 5, verifiedAtMs: 8, expiresAtMs: 20, signature: "",
  };
  delegation.signature = sign(null, delegationMessage(wallet, delegation), creator.privateKey).toString("base64");

  assert.equal(verifyCreator(direct, [entry], 10).reason, "creator-signed-launch");
  assert.equal(verifyCreator(direct, [entry], 30).eligible, false);
  assert.equal(verifyCreator(direct, [entry], 10, 1).eligible, false);
  assert.equal(verifyCreator(delegate, [entry], 10).reason, "creator-signer-mismatch");
  entry.delegations = [delegation];
  assert.deepEqual(verifyCreator(delegate, [entry], 10).authorization, delegation);
  assert.equal(verifyCreator(delegate, [entry], 7, 6).eligible, false);
  assert.equal(verifyCreator(delegate, [entry], 20).eligible, false);
  assert.equal(verifyCreator({ ...delegate, signers: [] }, [entry], 10).eligible, false);
  assert.equal(verifyCreator({ ...delegate, mint: "mint-b" }, [entry], 10).eligible, false);
  assert.equal(verifyCreator(delegate, [{ ...entry, delegations: [{ ...delegation, expiresAtMs: 21 }] }], 10).eligible, false);
});
