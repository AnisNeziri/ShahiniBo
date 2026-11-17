# Opportunity and exit research

The paper engine records a versioned risk snapshot for every entry decision,
including rejections. Creator verification, venue support, freshness, size,
exposure and slippage continue to gate entries. The model is observational in
`run paper`. A replay can run a separately labeled policy that vetoes entries
based on a frozen model. That counterfactual cannot submit transactions.

## Run the two fixtures

```text
npm run bot -- replay --input fixtures/ladder-events.jsonl --config fixtures/ladder.demo.json --run-id ladder-demo
npm run bot -- decision --db data/ladder.sqlite --run-id ladder-demo
npm run bot -- replay --input fixtures/tp3-events.jsonl --config fixtures/tp3.demo.json --run-id price-demo
```

The first fixture uses a 0.10 SOL entry, TP1 at +20% on 25% of the original
fill, TP2 at +0.02 SOL on another 25%, and a −0.005 SOL stop on the
remainder. It includes a spoofed creator. The separate price fixture
exercises TP3 after canonical PumpSwap migration. Every price and return
in these fixtures is synthetic.

## Configure exits

Use `strategy.exits` in a paper config or `rules.exits` in a live policy.
There are up to three labeled legs. Each `sellPercent` is a decimal string
and a percentage of the original confirmed fill. The combined percentage
cannot exceed 100%. The service rounds each leg down to the token base
unit. A leg whose amount rounds to zero is recorded as skipped. A stop or
time limit covers any remainder, including rounding dust if it can be sold.
The [exit schema](config/exit-policy.schema.json) describes the shape and
the fixture provides a complete example.

| Unit | Trigger calculation | Precision |
| --- | --- | --- |
| `net_pnl_percent` | Net P&L divided by the original filled cost basis | Two decimal places in percent |
| `net_pnl_sol` | Realized net sale proceeds plus a bounded liquidation quote for the remainder, less original entry cost and failed sell fees | Nine decimal places in SOL |
| `executable_sol_per_token` | Net executable proceeds for the proposed leg divided by its token amount. For the stop, use the whole confirmed remainder. | Up to 18 decimal places in SOL per whole six-decimal Pump token |

In paper the executable quote deducts venue, modeled network and priority
fees and configured tips. In live planning it deducts venue fees and the
configured maximum network fee. Accounting uses actual finalized SOL and
token deltas, separating refundable rent from profit. Net loss levels are
negative and token-price thresholds are positive.

A terminal stop takes priority over unsent take-profit legs. If a sell may
have been submitted, the service reconciles it before planning a sale for the
remaining tokens. Ambiguous live history keeps that position blocked. When
several targets cross together, the planner processes TP1 through TP3 in
order and quotes again after each fill. Existing configs without `exits`
and previously persisted positions retain the single-exit behavior. Freeze
the exit rules and time limit for any replay comparison.

## Inspect risk and train a shadow model

Optional `strategy.riskPolicy` fields are `version`, `maxRoundTripLossBps`,
`minDistinctBuyers`, and `maxHolderConcentrationBps`. An enabled rule rejects
missing evidence for its input. Trade-attributed net holdings are a proxy.
Post-transaction balances cover only touched accounts with a known owner and
exclude recognized curve and pool vaults. Neither measure supplies total wallet
holdings or complete token concentration. Bundle evidence is unknown without
explicit provenance. Buyers appearing together in one slot are reported
separately from verified signers. Late trades, data gaps and rollbacks affect
the coverage fields. Creator history excludes spoofed, rolled-back and
same-slot launches and needs matured results available before the decision.

```text
npm run bot -- features --db data/ladder.sqlite --run-id ladder-demo --output data/ladder-features.json
npm run bot -- train --input data/ladder-features.json --split-ms 1700000064000 --output data/ladder-model.json
```

The fixture has one resolved verified launch, so the command reports
insufficient data and writes no model. Use a verified allowlist frozen
before collecting a real dataset. Export a larger creator-only replay
with the same execution and exit assumptions. Choose a UTC millisecond split
before looking at the holdout. Training requires 30 resolved examples, both
outcomes represented by at least five examples, and a feature with at least
80% training coverage. Missed or failed entries are negative labels with
their charged fees. Unresolved or fork-tainted positions have unknown labels.

When training succeeds, evaluate the artifact on a later window or on the
holdout portion of the export. The artifact records its training data hash,
split time and settings fingerprint. Set `shadowModel` in a private paper
config to the path of the model file. The ledger records the feature, cutoff
and score, or why the score was unavailable.

```text
npm run bot -- evaluate --input data/real-features.json --model data/real-model.json
npm run bot -- replay --input data/real-tape.jsonl --config config/paper.private.json
```

The evaluation command relabels outcomes under fixed entries. The replay
comparison also simulates capital constraints for the creator, risk and
model policies. A single-exit versus ladder comparison reports both runs and
the common subset with identical entry time, quantity, fees and venue.
Different portfolio paths may admit different later entries. The report
shows how many entries were excluded from the paired subset and how many
positions remain open. Neither output establishes a real trading advantage
without a sufficient out-of-sample dataset.

## Measure a provider and optional enrichment

For an ordered feed benchmark, set `SOLANA_RPC_URL` and `SOLANA_WS_URL`
to a provider that can sustain confirmed hydration and finalized reconciliation.
Start the recorder, then import the matching finalized slot window. Use a
fresh output filename for each import. Restart the same run ID and ledger
to exercise checkpoint recovery. The sampler example is suitable for a short
public read-only check and marks its launches ineligible for strategy entry.

```text
npm run bot -- run monitor --config config/monitor.example.json --seconds 60 --run-id provider-window
npm run bot -- import --config config/monitor.example.json --from-slot FIRST --to-slot LAST --output data/finalized-window.jsonl
npm run bot -- measure --input data/monitor-feed.jsonl --reference data/finalized-window.jsonl --deadline-ms 5000
```

For Yellowstone, collect successful executed, confirmed transactions on a
supported host using the provider's client and synchronized observer clocks.
The comparison consumes a normalized JSONL tape with `kind: "launch"`,
`sourceTiming: "executed_transaction"`, transaction signature, mint,
executed slot, local `receivedAtMs` and `hydrationMs`. Keep the normal launch
fields from [the event types](src/protocol-types.ts) and let local hydration be
zero only if the subscribed transaction already carries the data used for the
decision. The comparison pairs finalized signatures and reports missing
launches and the share with usable data by the receipt-relative deadline.
Raw Yellowstone packet capture remains provider-side.

```text
npm run bot -- measure --input data/monitor-feed.jsonl --reference data/finalized-window.jsonl --alternate data/yellowstone-executed.jsonl --deadline-ms 5000
```

An eligible paper decision records the launch slot, latest observed slot,
provider receipt, hydration, scheduled feature cutoff and actual local
processing time. Landing in paper and replay remains modeled. Ordered
confirmed-block replay cannot take credit for a decision in the launch slot,
even when block timestamps tie. p95 is reported from 20 samples and p99 from
100. Historical block times are explicitly labeled.

Set `tracker: true` in a monitor or paper config to collect Solana Tracker
enrichment and provide `SOLANA_TRACKER_API_KEY` through the environment.
The worker is bounded, deduplicates mints and honors rate-limit backoff.
Decision records only expose the snapshot if it was locally available by
the cutoff. Provider risk time must be present and recent for eligibility.
A pool update timestamp is retained separately from risk time. The rule
and model decisions currently use the captured on-chain features. Tracker
evidence is retained for analysis and does not make the loop wait.

```text
npm run bot -- tracker --mint 4wgn7wZCspYYjcB8ccfVjjguff8yUt9aywCa8fyEpump
npm run bot -- replay --input data/paper-feed.jsonl --config config/paper.private.json --enrichment-db data/paper.sqlite --enrichment-run PAPER_RUN_ID
```
