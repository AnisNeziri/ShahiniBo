import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { PUMP_PROGRAM } from "./protocol-types.ts";
import type { LaunchEvent } from "./protocol-types.ts";

export interface Delegation {
  mint: string;
  launchUser: string;
  venue: typeof PUMP_PROGRAM;
  signature: string;
  issuedAtMs: number;
  verifiedAtMs: number;
  expiresAtMs: number;
}

export interface CreatorRecord {
  alias: string;
  wallet: string;
  method: "public-account" | "wallet-challenge";
  evidenceRef: string;
  verifiedAtMs: number;
  activeAtMs: number;
  revokedAtMs?: number;
  delegations?: Delegation[];
}

export interface IdentityVerdict {
  eligible: boolean;
  reason: string;
  alias?: string;
  authorization?: Delegation;
}

export function isPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  return bs58.decode(value).length === 32;
}

export function delegationMessage(wallet: string, approval: Delegation): Buffer {
  return Buffer.from(JSON.stringify([
    "ShahiniBot:mainnet-beta:pump-launch-authorization:v1",
    wallet, approval.venue, approval.mint, approval.launchUser,
    approval.issuedAtMs, approval.expiresAtMs,
  ]));
}

function validSignature(wallet: string, approval: Delegation): boolean {
  try {
    const bytes = Buffer.from(approval.signature, "base64");
    if (bytes.length !== 64 || bytes.toString("base64") !== approval.signature) return false;
    const key = createPublicKey({
      format: "der", type: "spki",
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bs58.decode(wallet)]),
    });
    return verify(null, delegationMessage(wallet, approval), key, bytes);
  } catch {
    return false;
  }
}

export function verifyCreator(
  launch: LaunchEvent,
  entries: readonly CreatorRecord[],
  decisionAtMs: number,
  chainAtMs = launch.blockTimeMs ?? launch.receivedAtMs,
): IdentityVerdict {
  const asOf = Math.min(chainAtMs, decisionAtMs);
  const entry = entries.find(candidate =>
    candidate.wallet === launch.creator &&
    candidate.verifiedAtMs <= asOf &&
    candidate.activeAtMs <= asOf &&
    (candidate.revokedAtMs === undefined || decisionAtMs < candidate.revokedAtMs));
  if (!entry) return { eligible: false, reason: "creator-not-active-at-launch" };
  if (launch.launchUser === entry.wallet && launch.signers.includes(entry.wallet)) {
    return { eligible: true, reason: "creator-signed-launch", alias: entry.alias };
  }
  const authorization = entry.delegations?.find(approval =>
    approval.mint === launch.mint &&
    approval.launchUser === launch.launchUser &&
    launch.signers.includes(approval.launchUser) &&
    approval.venue === PUMP_PROGRAM &&
    approval.issuedAtMs <= chainAtMs &&
    approval.verifiedAtMs <= decisionAtMs &&
    decisionAtMs < approval.expiresAtMs &&
    validSignature(entry.wallet, approval));
  if (authorization) {
    return { eligible: true, reason: "signed-delegation", alias: entry.alias, authorization };
  }
  return { eligible: false, reason: "creator-signer-mismatch", alias: entry.alias };
}
