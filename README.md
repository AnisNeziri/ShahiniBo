# ShahiniBot

One Node.js service for recording official Pump.fun launches and testing whether
a preverified creator rule improves net executable returns. The modeled strategy
buys with a fixed SOL budget and supports a single exit or partial take-profit
legs followed by a stop or time exit. It can follow the position from the bonding
curve to the canonical PumpSwap pool when the feed verifies the migration.

See [opportunity and exit research](MILESTONE.md) for the risk report, shadow
model, Solana Tracker setup, feed measurement and TP ladder demo.
Use the [local dashboard](DASHBOARD.md) to watch a running paper ledger or
replay the activity demo in a browser.

Install Node 24 using the version in `.nvmrc`. Run the following from the project
root in PowerShell or on Linux. If PowerShell blocks the npm script shim, use
`npm.cmd`.

```text
npm ci
npm run check
npm test
npm run bot -- --help
```

## Offline demo

```text
npm run bot -- replay --input fixtures/pumpfun-events.jsonl --config fixtures/paper.demo.json --run-id fixture-demo
npm run bot -- report --run-id fixture-demo --db data/demo.sqlite
npm run bot -- status --db data/demo.sqlite
```

The synthetic tape includes a creator-signed launch, a spoofed creator, a duplicate,
a failed sell followed by recovery, and an exit after migration. The demo config
contains a synthetic allowlist. The standard example starts with an empty
allowlist and is useful as a negative control.

```text
npm run bot -- replay --input fixtures/pumpfun-events.jsonl --config config/paper.example.json
```

Replay prints a JSON report with a stable run ID and a matched baseline. Point
reports at the run's database using `--db`. Replay keeps its source JSONL immutable.
Paper wallet amounts are integer lamports and token base units, with limits in
basis points. Results for the tape are modeled and cannot establish profitability.

## Record and run paper

The read-only feed needs an HTTP RPC endpoint with transaction and block history
and a compatible Solana WebSocket endpoint. The default is the public mainnet
RPC, which can rate-limit hydration and finalized backfill. Set the provider
URLs in the environment for unattended capture. Keep credentials out of JSON
config and terminal output. The RPC and WebSocket environment variable names can
be changed in the config.

For a lower volume public RPC smoke test use `config/monitor.public.example.json`.
This mode samples launch notifications and hydrates them individually. Its data
has incomplete coverage and is marked ineligible for trades and matched replay.
See [protocol and feed coverage](PROTOCOL.md) for the supported layouts,
provider requirements, fixture details, and Yellowstone status.

```text
npm run bot -- run monitor --config config/monitor.example.json --seconds 15
npm run bot -- run paper --config config/paper.example.json
npm run bot -- status
npm run bot -- status --db data/monitor.sqlite
npm run bot -- control pause
npm run bot -- control resume
npm run bot -- control kill
```

Without `--seconds` the feed runs until interrupted. The capture JSONL and SQLite
ledger default to `data/`. A resumed run uses its saved checkpoint. Freeze a copy
of the capture before replaying it. Feed gaps, stale data and unverified venues
can suppress entries and leave positions unresolved. A kill latches the paper
database's entry control and leaves exit monitoring active. Start a new database
after operator review to reset a killed paper session.

For a bounded archive import, replace the slots with an available range of up
to 256 slots. The CLI writes a manifest alongside the tape. The importer uses
block ordering and historical timing assumptions.

```text
npm run bot -- import --config config/monitor.example.json --from-slot 470514830 --to-slot 470514840 --output data/archive-470514830.jsonl
npm run bot -- replay --input data/archive-470514830.jsonl --config config/paper.example.json
```

## Configuration

Paths in config JSON resolve relative to the config file. Use
[`settings.schema.json`](config/settings.schema.json) for monitor and paper
settings and [`allowlist.schema.json`](config/allowlist.schema.json) for the
allowlist. Use private copies of each config and keep evidence references and
operator data out of version control. Paper default values are hypotheses
for testing. See the [operator runbook](RUNBOOK.md) for creator review,
research setup, recovery, and the isolated live command. [SOURCES.md](SOURCES.md)
records package pins and protocol and research provenance.

The optional paper `report` block accepts an evaluation start and end in UTC
milliseconds for the matched comparison, a fixed cost in lamports, and a
timestamped EUR reference rate. A run is exploratory unless its point-in-time
allowlist history has been reviewed and recorded in the report configuration.
Set optional creator history, initial-buy and concentration filters under
`strategy` to see their individual variants. Missing data for an enabled filter
causes it to reject the entry.

Full WebSocket capture with ordered block hydration can exceed the public RPC
quota. Start a full capture with a provider that supports confirmed and
finalized blocks and program log subscriptions at the needed volume. For
latency modeling, the observer's clock and the historical block clock are
separate. A reserve event with missing fee evidence, uncertain intra-block
ordering, or an unsupported transfer configuration can make a trade
unmodelable even if the mint and creator are known.

Replay overlays each simulated fill's reserve changes on the immutable tape.
It does not reconstruct how other traders or the migration would have changed
in response. Replay uses the venue fee basis points observed on the tape, so
its fee rounding and tier can differ from the official live SDK for a
hypothetical size. Tied timestamps are processed in tape order before timed
decisions. The illiquid exit scenario tightens the allowable price impact;
the report exposes unresolved exposure separately. The research comparison
remains descriptive and can be inconclusive even with a large sample.
