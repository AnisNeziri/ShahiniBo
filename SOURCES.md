# Sources and provenance

## Protocol and implementation

- [Pump.fun public docs and IDLs at 639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22](https://github.com/pump-fun/pump-public-docs/tree/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22). Source for deployment addresses, discriminators, account ordering, PDA seeds, CPI event layouts, creation flags, migration and fee behavior. Code here uses the wire-format facts. No upstream files are vendored.
- [Pump.fun fees](https://pump.fun/docs/fees). The public page documents platform fee schedules. Replay uses recorded fee information or treats the quote as unknown. Paper network, priority and failed transaction fees are scenario inputs.
- [Chainstack example at 93a09d058a72dae507db29b9670adaa054379bfe](https://github.com/chainstacklabs/pumpfun-bonkfun-bot/tree/93a09d058a72dae507db29b9670adaa054379bfe) (Apache-2.0). Design reference for transaction listeners, parsing and migration. No source files copied.
- [Solana logsSubscribe](https://solana.com/docs/rpc/websocket/logssubscribe), [getBlock](https://solana.com/docs/rpc/http/getblock), [getTransaction](https://solana.com/docs/rpc/http/gettransaction) and [sendTransaction](https://solana.com/docs/rpc/http/sendtransaction). Standard JSON-RPC ingestion and submission contracts. The Pump builders use web3.js 1.x public keys, so the code uses that type for PDAs and builder calls. The feed uses Node WebSocket and Fetch directly.

## Package pins

| Direct package | Version | License | Reason |
|---|---:|---|---|
| `@pump-fun/pump-sdk` | 4.3.1 | MIT | Official curve account codecs and builders |
| `@pump-fun/pump-swap-sdk` | 2.2.0 | MIT | Official PumpSwap account codecs and builders |
| `@solana/web3.js` | 1.98.4 | MIT | Public key/PDA operations and compatibility with both Pump SDKs |
| `@solana/spl-token` | 0.4.14 | Apache-2.0 | Token accounts, mints, and extensions |
| `bn.js` | 5.2.3 | MIT | Integer adapter for SDK amounts |
| `bs58` | 6.0.0 | MIT | Solana addresses and raw instruction decoding |
| `typescript` | 5.9.3 | Apache-2.0 | Strict type checking |
| `@types/node` | 24.19.2 | MIT | Node 24, including built-in SQLite |
| `@types/bn.js` | 5.2.0 | MIT | SDK amount types |

The package lock records transitives and registry integrity hashes. Pump package
licenses, metadata, lifecycle hooks and SDK builder source were checked before
installation. The project suppresses package install hooks and uses Node 24's
built-in SQLite. `npm audit` reported advisories inherited through the Pump SDK
stack in `bigint-buffer`, `toml`, and the web3.js JSON-RPC dependency tree.
The reported automatic replacements change SDK compatibility. Treat live use
as unverified until you have reviewed the current audit and validated the
intended route against a validator.

## Research references

- [Solana launch study at db1f032e728d162a6cd6cf399f48d51130de3e07](https://github.com/Chrisymcsoup/solana-launch-study/tree/db1f032e728d162a6cd6cf399f48d51130de3e07). Its earliest observations start 30 seconds after launch. Its repository flags a known bug in the two-snapshot simulation. These results do not measure same-slot entry or this creator verification rule.
- [Sniper study at 56ba2517d6cfb5b8f73ad919bbaf350bd8f7abd7](https://github.com/Sorghobrayan-dotcom/solana-sniper-reverse-engineering/tree/56ba2517d6cfb5b8f73ad919bbaf350bd8f7abd7). Its transaction order and deployer history inform data requirements. Its methodology distinguishes point-in-time deploy features from activity not safely truncated at the decision boundary. Candle-derived outcomes do not establish fills.
- [Gafarov prospective study, arXiv:2610.39458v1](https://arxiv.org/abs/2610.39458v1). Wallet groups lack ground truth, and following the group signal lost money in the reported out-of-sample configurations.
- [Gafarov retrospective study, arXiv:2611.11436v1](https://arxiv.org/abs/2611.11436v1). Full-window funding links and hindsight-selected thresholds limit applicability. Open-position marks contributed materially to some reported equity.

No external research dataset, result or model was imported into the strategy.
The synthetic demo exercises accounting and failure paths. Its reported
lamports are counterfactual. Live-feed capture or archive data requires its own
coverage manifest and point-in-time identity evidence.

The public RPC fixtures under `fixtures/public-*.redacted.json` carry slot,
original signature, retrieval date and commitment. They keep the compiled
instructions, lookup table resolution and CPI data used in decoder tests.
The mainnet monitor smoke test used program subscriptions and confirmed
transaction hydration in launch sampler mode. The archive smoke test imported
one finalized block with ordered transactions and wrote a coverage manifest.

[GMGN Skills](https://github.com/GMGNAI/gmgn-skills) and
[Jito transaction send](https://docs.jito.wtf/lowlatencytxnsend/) are outside
the runtime dependencies. Neither provided data or execution for the demo.

## Opportunity and exit milestone

- [MELT feature generation at 0732bcfab54f508c27becd6d9b2b10b1b6ac2517](https://github.com/git-disl/MELT/blob/0732bcfab54f508c27becd6d9b2b10b1b6ac2517/src/feat_gen.py) informed early-buyer, holdings and coordination feature categories. ShahiniBot uses transaction-level evidence from its recorder and limits each feature to evidence available at the decision cutoff.
- [Creator as-of history](https://github.com/Sorghobrayan-dotcom/solana-sniper-reverse-engineering/blob/56ba2517d6cfb5b8f73ad919bbaf350bd8f7abd7/src/asof_from_deploys.py), [execution sensitivity](https://github.com/Sorghobrayan-dotcom/solana-sniper-reverse-engineering/blob/56ba2517d6cfb5b8f73ad919bbaf350bd8f7abd7/src/part3_backtest.py), and [shallow interpretable rules](https://github.com/Sorghobrayan-dotcom/solana-sniper-reverse-engineering/blob/56ba2517d6cfb5b8f73ad919bbaf350bd8f7abd7/src/part2_rules.py) informed the point-in-time aggregation, matched replay and local model. No upstream code, trained model, data or result was copied.
- [Solana Tracker token endpoint](https://docs.solanatracker.io/data-api/tokens/get-token-information) documents the optional `GET /tokens/{mint}` endpoint. The worker uses Node fetch and the `x-api-key` header. No additional provider SDK was installed.
- [Freqtrade partial position adjustment](https://www.freqtrade.io/en/stable/strategy-callbacks/#adjust-trade-position) informed the position-state design. ShahiniBot sizes from original token base units and settles each leg through its existing venue quote and execution code.

The production dependency audit in this milestone reported 15 affected packages
(8 high, 7 moderate), including transitive effects. Install scripts remain
disabled and the tested bigint path used the JS fallback. The Anchor workspace
TOML parser is tooling and the service does not parse an `Anchor.toml` file.
The web3.js RPC stack still brings in Jayson and its parser dependencies in
the live process. The read-only feed and Tracker worker use Node fetch directly.
Dependency pins are unchanged. Mainnet submission was never enabled during
verification.
