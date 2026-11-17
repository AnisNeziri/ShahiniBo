# Local operations dashboard

With Node 24 and the existing dependencies installed, start a local dashboard
against the ledger used by `run paper`. The service accepts HTTP on loopback
only. It opens SQLite in read-only mode and serves recorded activity and
persisted fills independently of the trading process.

```text
npm run bot -- dashboard --db data/paper.sqlite
```

The default URL is [http://127.0.0.1:4317](http://127.0.0.1:4317). Use
`--run-id ID` to pin a run, and `--port NUMBER` to change the port. To watch
the ledger from this profitability test:

```text
npm run bot -- dashboard --db data/profitability-20261117/ordered.sqlite --run-id ordered-paper
```

To inspect the historical market baseline and its unresolved position:

```text
npm run bot -- dashboard --db data/profitability-20261117/market-comparison.sqlite --run-id market_ladder --port 4318
```

Run the dashboard by itself to replay the local synthetic TP fixture. Open the
printed URL to start playback. The source is a temporary replay ledger. It
shows a creator-signed launch, a spoof rejection, a paper buy, TP1 and TP2,
and a stop on the remainder.

```text
npm run bot -- dashboard --demo
```

The activity feed distinguishes market observations, paper fills and confirmed
live fills. Pending and failed submissions are separate. Filter the feed by
mint, creator, or event type. Select a coin to see the decision reason, the
risk evidence recorded at the cutoff and any shadow score. Quote freshness
reflects the run clock. Unavailable quotes remain unknown in the positions
table even when the report assigns zero conservative liquidation value.
The performance view is calculated from the same ledger logic as the CLI
report.

The page starts with `GET /api/snapshot` and subscribes to the event stream.
Reconnect uses the last event cursor. If the cursor is too old, the browser
refreshes its snapshot. The dashboard has no order or control endpoints.
