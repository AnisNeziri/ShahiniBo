# Operator runbook

For the ladder settings, sample decisions, latency comparisons and training
commands see [opportunity and exit research](MILESTONE.md).

## Creator review

Have one operator collect evidence and the other review it before activation.
Use a statement published through a creator-controlled account that asserts the
wallet, or an Ed25519 signature verified against a one-time identity challenge.
Record the evidence reference, stable alias, wallet, method, verification time
and activation time privately. Use Unix UTC milliseconds for timestamps. Keep
the allowlist empty until review is complete and advance its version with each
approved edit. Record revocations as timestamps and retain prior versions for
replay. The service uses the configured verification record as the operator's
attestation. It does not fetch social accounts during decisions.

An approved delegation is a detached, standard base64 Ed25519 signature made
by the creator over the UTF-8 encoding of a compact JSON array. Its exact
ordered elements are `ShahiniBot:mainnet-beta:pump-launch-authorization:v1`,
creator wallet, official Pump program address, mint, launch user,
issuedAtMs, expiresAtMs. The local record also includes verifiedAtMs, the
time the approval became available. Use the byte encoding in
[`delegationMessage`](src/identity.ts) with no trailing newline. The
approved launch user must sign the launch transaction.

## Paper collection and research

1. Start with a bounded read-only monitor. Check whether subscriptions become
   healthy and a finalized checkpoint advances. Check how much provider quota
   the recorder consumes before running unattended.
2. Give the paper service and archive import separate storage. Retain the
   immutable tapes, configs, allowlist versions, provider coverage and actual
   hosting/RPC costs. Restrict access to the database and raw capture. Apply
   retention and disk quotas at the host level.
3. Choose the strategy and fee/latency scenarios on an earlier window. Freeze
   them and evaluate on a later window. For the primary creator comparison,
   use identity evidence available at decision time. Mark retrospective runs
   without that evidence exploratory.
4. Compare the filtered and baseline runs on the same tape. Inspect skipped
   launches, unresolved exposure, quote gaps, the role of the best creator
   and trade, and how size, costs and latency affect the difference. Record a
   timestamped external FX rate yourself if you need EUR conversion.

For unattended Linux paper service, run `node src/cli.ts run paper --config
/absolute/path/to/paper.private.json` with the project as its working directory
under a dedicated service account. Supply provider variables through the
service manager's restricted environment file. Use a graceful SIGTERM and
verify the last checkpoint after restart. Keep one writer per run.
Changing paper settings or allowlist versions changes the default run ID.
Pause new buys and drain outstanding paper exposure under the existing
configuration before switching that database to a revised policy.

## Isolated live execution

The opt-in command is `npm run bot -- run live --config /absolute/path/to/live.private.json`.
See [the live policy and recovery procedure](LIVE.md) and the disabled
[`config/live.example.json`](config/live.example.json). The
[live schema](config/live.schema.json) describes a filled and enabled policy.
Use a separate live policy, dedicated wallet, and live database. Do not start
with funded mainnet keys as a test. Run the offline tests and reproduce the
paper demo, validate each enabled route against a compatible local validator,
check the SDK audit, and reconcile the wallet and every outstanding attempt
before allowing entries. Set the balance, exposure, size, loss, fee, rent,
slippage, and retry caps expressly in that policy. Keep the key file outside
the repository under the service account's access controls.

Pause entries on unexpected exposure, feed gaps or ambiguous settlement.
Inspect pending signatures and wallet balances against finalized history.
Record the evidence with your co-operator. Reuse a still-valid signed attempt
only through the recovery workflow. A new blockhash means a new signature
and can spend again. If manual settlement was necessary, reconcile it before
resuming the same wallet and journal. Preserve the database and never remove a
writer lock while a process might still hold it.
