import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Ledger } from "./ledger.ts";
import { loadSettings, loadFeed, readJson } from "./settings.ts";
import { recorder, readTape } from "./tape.ts";
import { verifyCreator } from "./identity.ts";
import { PaperEngine } from "./engine.ts";
import type { PaperState } from "./engine.ts";
import { buildReport, buildComparison, exportExamples } from "./report.ts";
import { runReadOnlyFeed, importBlocks } from "./feed.ts";
import type { FeedHandlers, ImportManifest } from "./feed.ts";
import type { NormalizedEvent, ProtocolEvent } from "./protocol-types.ts";
import { liveStatus, setLiveControl } from "./live-execution.ts";
import type { ReportOptions } from "./report.ts";
import { measureCapture } from "./measure.ts";
import { TrackerWorker, type TrackerSnapshot } from "./tracker.ts";
import { evaluateModel, trainModel, validateModel, type Example } from "./model.ts";

const help = `ShahiniBot

  replay --input TAPE --config PAPER [--run-id ID] [--db PATH] [--enrichment-db PATH --enrichment-run ID]
  run monitor [--config MONITOR] [--seconds N] [--run-id ID]
  run paper [--config PAPER] [--seconds N] [--run-id ID]
  run live --config LIVE
  import --config MONITOR --from-slot N --to-slot N --output TAPE
  measure --input CAPTURE --reference FINALIZED_TAPE [--alternate EXECUTED_TAPE] [--deadline-ms MS]
  decision --run-id ID [--db PATH] [--mint MINT]
  features --run-id ID [--db PATH] [--output JSON]
  train --input FEATURES --split-ms MS --output MODEL
  evaluate --input FEATURES --model MODEL
  tracker --mint MINT
  report --run-id ID [--db PATH]
  status [--db PATH]
  control pause|resume|kill [--db PATH]
  dashboard [--db PATH] [--run-id ID] [--port NUMBER] [--demo]
`;
const paperDefault = "config/paper.example.json";
const monitorDefault = "config/monitor.example.json";
const paperDb = "data/paper.sqlite";

function print(value: unknown) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unsigned(raw: string | undefined, label: string, min: number, max: number): number {
  const value = Number(raw);
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined || (typeof value === "string" && !value.trim())) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function openModeLedger(path: string, capture?: string) {
  if (path.toLowerCase().endsWith(".live.sqlite") || (capture !== undefined && resolve(path) === capture)) {
    throw new Error("Use distinct capture and paper or monitor ledger paths");
  }
  return new Ledger(path);
}

function shutdown(seconds?: string) {
  const duration = seconds === undefined ? undefined : unsigned(seconds, "seconds", 1, 3600) * 1000;
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const timer = duration === undefined ? undefined : setTimeout(stop, duration);
  return {
    signal: lifetime.signal,
    close() {
      clearTimeout(timer);
      stop();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    },
  };
}

function eventKey(event: NormalizedEvent): string {
  if (event.kind === "feed") return digest(event);
  return JSON.stringify([event.signature, event.instructionPath, event.kind, event.commitment, event.slot, event.blockhash]);
}

function createObserver(db: Ledger, id: string, provider: string) {
  let snapshot = db.initialize(id, "monitor", { version: 1, provider }, {
    events: 0,
    launches: 0,
    unsupported: 0,
    health: null as NormalizedEvent | null,
    lastAtMs: null as number | null,
  });
  return (event: NormalizedEvent) => {
    const key = eventKey(event);
    if (db.hasEvent(id, key)) return;
    const state = {
      events: snapshot.state.events + 1,
      launches: snapshot.state.launches + Number(event.kind === "launch" && event.commitment === "confirmed"),
      unsupported: snapshot.state.unsupported + Number(event.kind === "launch" && !event.supported),
      health: event.kind === "feed" ? event : snapshot.state.health,
      lastAtMs: event.receivedAtMs,
    };
    db.save({
      id, revision: snapshot.revision, state,
      event: { key, receivedAtMs: event.receivedAtMs, normalized: event }, journal: [],
    });
    snapshot = { ...snapshot, state, revision: snapshot.revision + 1 };
  };
}

function paperPolicy(config: ReturnType<typeof loadSettings>) {
  const list = required(config.allowlist, "allowlist");
  return {
    settings: required(config.paper, "paper strategy"),
    verifyCreator: (launch: Parameters<typeof verifyCreator>[0], now: number, chainAt: number) =>
      verifyCreator(launch, list.creators, now, chainAt),
    shadowModel: config.shadowModel,
    policyProvenance: { allowlistVersion: list.version, sha256: digest(list), report: config.report,
      ...(config.shadowModel ? { shadowModelHash: digest(config.shadowModel) } : {}) },
  };
}

function replay(db: Ledger, id: string, config: ReturnType<typeof loadSettings>, events: NormalizedEvent[], enrichment: TrackerSnapshot[]) {
  const policy = paperPolicy(config);
  const snapshots = new Map(enrichment.map(row => [row.mint, row]));
  const provenance = { ...policy.policyProvenance, tapeSha256: digest(events),
    ...(enrichment.length ? { trackerSha256: digest(enrichment) } : {}) };
  const engine = new PaperEngine({
    id, ledger: db, mode: "replay", ...policy, policyProvenance: provenance, enrichment: mint => snapshots.get(mint),
  });
  const completed = db.checkpoint(`finished:${id}`) !== undefined;
  if (!completed) {
    for (const snapshot of enrichment) db.saveEnrichment(id, snapshot.mint, snapshot);
    const cursor = `replay-cursor:${id}`;
    for (let index = (db.checkpoint(cursor)?.slot ?? -1) + 1; index < events.length; index++) {
      const event = events[index]!;
      engine.accept(event, undefined, { name: cursor, point: { slot: index, updatedAtMs: event.receivedAtMs } });
    }
    engine.finish();
    db.saveCheckpoint(`finished:${id}`, { slot: 0, updatedAtMs: engine.state.now });
  }
  print({
    runId: id,
    summary: buildReport(db, id, config.report),
    comparison: buildComparison(events, policy.settings, policy.verifyCreator, config.report, policy.shadowModel),
  });
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h" },
    config: { type: "string" },
    input: { type: "string" },
    output: { type: "string" },
    "run-id": { type: "string" },
    db: { type: "string" },
    "from-slot": { type: "string" },
    "to-slot": { type: "string" },
    seconds: { type: "string" },
    reference: { type: "string" },
    alternate: { type: "string" },
    "deadline-ms": { type: "string" },
    "split-ms": { type: "string" },
    model: { type: "string" },
    mint: { type: "string" },
    demo: { type: "boolean" },
    port: { type: "string" },
    "enrichment-db": { type: "string" },
    "enrichment-run": { type: "string" },
  },
});

async function main(): Promise<void> {
  const [command, subcommand, ...remainder] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(help);
    return;
  }
  if (remainder.length || (subcommand !== undefined && command !== "run" && command !== "control")) {
    throw new Error("Unexpected positional arguments");
  }
  if (command === "dashboard") {
    const lifetime = shutdown(values.seconds);
    const port = unsigned(values.port ?? "4317", "port", 0, 65535);
    let demo: Awaited<ReturnType<typeof import("./dashboard-demo.ts").dashboardDemo>> | undefined;
    let dashboard: Awaited<ReturnType<typeof import("./dashboard.ts").startDashboard>> | undefined;
    try {
      if (values.demo) {
        if (values.db || values["run-id"]) throw new Error("The demo creates its own temporary database and run");
        demo = await (await import("./dashboard-demo.ts")).dashboardDemo();
      }
      dashboard = await (await import("./dashboard.ts")).startDashboard({
        database: demo?.database ?? resolve(values.db ?? paperDb),
        runId: demo?.runId ?? values["run-id"], port,
        onConnect: demo?.onConnect,
      });
      print({ url: dashboard.url, database: demo?.database ?? resolve(values.db ?? paperDb),
        ...(demo ? { runId: demo.runId, replay: "starts when a browser connects" } : {}) });
      if (!lifetime.signal.aborted) {
        await new Promise<void>(resolve => lifetime.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
    } finally {
      lifetime.close();
      try { await dashboard?.close(); }
      finally { await demo?.close(); }
    }
    return;
  }
  if (command === "run" && subcommand === "live") {
    const policy = required(values.config, "--config");
    const lifetime = shutdown(values.seconds);
    try {
      const { runLive } = await import("./live.ts");
      await runLive(policy, lifetime.signal);
    } finally {
      lifetime.close();
    }
    return;
  }
  if (command === "replay") {
    const config = loadSettings(values.config ?? paperDefault, "paper");
    const events = await readTape(required(values.input, "--input"));
    const db = openModeLedger(values.db ?? config.database, config.capture);
    try {
      let enrichment: TrackerSnapshot[] = [];
      if (values["enrichment-db"] || values["enrichment-run"]) {
        const source = new Ledger(required(values["enrichment-db"], "--enrichment-db"), { readOnly: true });
        try { enrichment = source.enrichments(required(values["enrichment-run"], "--enrichment-run")); }
        finally { source.close(); }
      }
      const id = values["run-id"] ?? `replay-${digest([2, config.paper, config.allowlist, config.report, config.shadowModel, events, enrichment]).slice(0, 20)}`;
      replay(db, id, config, events, enrichment);
    } finally {
      db.close();
    }
    return;
  }
  if (command === "run" && (subcommand === "monitor" || subcommand === "paper")) {
    const config = loadSettings(values.config ?? (subcommand === "paper" ? paperDefault : monitorDefault), subcommand);
    const feed = loadFeed(config.feedInput);
    if (subcommand === "paper" && feed.launchesOnly) throw new Error("A launch-only feed is for monitoring");
    const lifetime = shutdown(values.seconds);
    const db = openModeLedger(values.db ?? config.database, config.capture);
    let clock: ReturnType<typeof setInterval> | undefined;
    let clockFailure: unknown;
    let tracker: TrackerWorker | undefined;
    try {
      const revision = [feed.provider, config.paper, config.allowlist, config.report];
      const id = values["run-id"] ?? `${subcommand}-${digest(config.shadowModel ? [...revision, config.shadowModel] : revision).slice(0, 20)}`;
      const capture = recorder(config.capture);
      const checkpoint = `feed:${id}`;
      const policy = subcommand === "paper" ? paperPolicy(config) : undefined;
      if (policy) {
        const unsettled = db.runs<PaperState>().find(run => run.mode === "paper" && run.id !== id &&
          (Object.keys(run.state.positions).length || Object.keys(run.state.orders).length));
        if (unsettled) throw new Error(`Resume and drain paper run ${unsettled.id} before switching its configuration`);
      }
      const engine = policy ? new PaperEngine({
        id, ledger: db, mode: "paper", ...policy,
        policyProvenance: { ...policy.policyProvenance, provider: feed.provider },
        enrichment: mint => db.enrichment(id, mint),
        wallClock: Date.now,
      }) : undefined;
      const observe = engine ? undefined : createObserver(db, id, feed.provider);
      const trackerKey = config.tracker ? process.env.SOLANA_TRACKER_API_KEY : undefined;
      if (config.tracker && !trackerKey) process.stderr.write("Solana Tracker enabled but SOLANA_TRACKER_API_KEY is unavailable; continuing with recorded data.\n");
      if (trackerKey) tracker = new TrackerWorker({
        key: trackerKey, save: snapshot => db.saveEnrichment(id, snapshot.mint, snapshot),
        alreadyFetched: mint => db.enrichment(id, mint) !== undefined,
        onError: () => process.stderr.write("Unable to persist Tracker result.\n"),
      });
      if (engine) {
        clock = setInterval(() => {
          try { engine.advance(Date.now()); } catch (error) {
            clockFailure = error;
            lifetime.close();
          }
        }, 1000);
      }
      let lastHealth = "";
      let events = 0;
      let launches = 0;
      const resumeSlot = db.checkpoint(checkpoint)?.slot;
      const handlers: FeedHandlers = {
        resumeSlot,
        resumeConfirmed: db.unfinalizedEvents<ProtocolEvent>(id, resumeSlot),
        checkpoint(slot) { db.saveCheckpoint(checkpoint, { slot, updatedAtMs: Date.now() }); },
        raw(record) { capture("raw", record); },
        event(event) {
          capture("event", event);
          if (engine) engine.accept(event);
          else observe?.(event);
          events++;
          if (event.kind === "launch") {
            launches++;
            tracker?.enqueue(event.mint, event.receivedAtMs);
          }
          if (event.kind === "feed" && event.reason !== lastHealth) {
            lastHealth = event.reason ?? "";
            print({ healthy: event.healthy, reason: event.reason, slot: event.slot });
          }
        },
      };
      print({ runId: id, mode: subcommand, provider: feed.provider });
      await runReadOnlyFeed(feed, handlers, lifetime.signal);
      if (clockFailure) throw clockFailure;
      print({ runId: id, events, launches, checkpoint: db.checkpoint(checkpoint) ?? null, trackerQueueDrops: tracker?.dropped ?? 0 });
    } finally {
      clearInterval(clock);
      lifetime.close();
      await tracker?.close();
      db.close();
    }
    return;
  }
  if (command === "measure") {
    const reference = required(values.reference, "--reference");
    const manifest = readJson(reference + ".manifest.json") as ImportManifest;
    const [capture, finalized, alternate] = await Promise.all([
      readTape(required(values.input, "--input")), readTape(reference),
      values.alternate ? readTape(values.alternate) : undefined,
    ]);
    print(measureCapture(capture, finalized, manifest, unsigned(values["deadline-ms"] ?? "5000", "deadline-ms", 1, 3600000), alternate));
    return;
  }
  if (command === "features" || command === "decision") {
    const db = new Ledger(values.db ?? paperDb, { readOnly: true });
    try {
      const id = required(values["run-id"], "--run-id");
      const result = command === "features" ? exportExamples(db, id) : db.journal(id)
        .filter(row => ["decision", "exit_trigger", "exit_terminal", "position_partial", "position_closed"].includes(row.kind) &&
          (!values.mint || row.mint === values.mint));
      if (values.output) writeFileSync(values.output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
      else print(result);
    } finally { db.close(); }
    return;
  }
  if (command === "train" || command === "evaluate") {
    const data = readJson(required(values.input, "--input")) as { schema: number; settingsHash: string; examples: Example[] };
    if (data?.schema !== 1 || !/^[a-f\d]{64}$/.test(data.settingsHash) || !Array.isArray(data.examples)) {
      throw new Error("Expected a ShahiniBot feature export");
    }
    if (command === "train") {
      const split = unsigned(values["split-ms"], "--split-ms", 1, Number.MAX_SAFE_INTEGER);
      const model = trainModel(data.examples, split, data.settingsHash);
      if (!model) print({ verdict: "inconclusive", reason: "insufficient_mature_balanced_examples_or_usable_split", rows: data.examples.length });
      else {
        writeFileSync(required(values.output, "--output"), JSON.stringify(model, null, 2) + "\n", { flag: "wx" });
        print(model);
      }
    } else print(evaluateModel(data.examples, validateModel(readJson(required(values.model, "--model"))), data.settingsHash));
    return;
  }
  if (command === "tracker") {
    const key = required(process.env.SOLANA_TRACKER_API_KEY, "SOLANA_TRACKER_API_KEY");
    const mint = required(values.mint, "--mint");
    const { isPublicKey } = await import("./identity.ts");
    if (!isPublicKey(mint)) throw new Error("Specify a valid mint");
    const worker = new TrackerWorker({ key, save: print });
    worker.enqueue(mint, Date.now());
    try { await new Promise(resolve => setTimeout(resolve, 2250)); }
    finally { await worker.close(); }
    return;
  }
  if (command === "import") {
    const config = loadSettings(values.config ?? monitorDefault, "monitor");
    const path = required(values.output, "--output");
    const manifestPath = path + ".manifest.json";
    if (existsSync(path) || existsSync(manifestPath)) throw new Error("Choose a new output file for each archival import");
    const from = unsigned(values["from-slot"], "from-slot", 0, Number.MAX_SAFE_INTEGER);
    const to = unsigned(values["to-slot"], "to-slot", from, Math.min(from + 255, Number.MAX_SAFE_INTEGER));
    const capture = recorder(path);
    const lifetime = shutdown(values.seconds);
    try {
      const manifest = await importBlocks(loadFeed(config.feedInput), from, to, {
        event: event => capture("event", event),
        raw: record => capture("raw", record),
      }, lifetime.signal);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      print(manifest);
    } finally {
      lifetime.close();
    }
    return;
  }
  if (command === "report" || command === "status" || command === "control") {
    const path = resolve(values.db ?? paperDb);
    const controlStates = { pause: "paused", resume: "active", kill: "killed" } as const;
    const control = subcommand === "pause" || subcommand === "resume" || subcommand === "kill"
      ? controlStates[subcommand] : undefined;
    if (path.toLowerCase().endsWith(".live.sqlite")) {
      if (command === "status") print(liveStatus(path));
      else if (command === "control") print({ control: setLiveControl(path, required(control, "pause, resume, or kill")) });
      else throw new Error("Use status for a live ledger");
      return;
    }
    if (!existsSync(path) && command === "status") {
      print({ database: path, runs: [], control: "active" });
      return;
    }
    const db = new Ledger(path, { readOnly: command !== "control" });
    try {
      if (command === "report") {
        const id = required(values["run-id"], "--run-id");
        const snapshot = db.run(id);
        if (snapshot.mode === "monitor") throw new Error("Use status for a monitor ledger");
        const settings = snapshot.settings as { policy?: { report?: ReportOptions } };
        print(buildReport(db, id, settings.policy?.report));
      } else if (command === "status") {
        print({
          database: path,
          control: db.control("paper"),
          runs: db.runs().map(({ id, mode, state }) => {
            const checkpoint = db.checkpoint(`feed:${id}`) ?? null;
            if (mode === "monitor") return { id, mode, checkpoint, state };
            const paper = state as PaperState;
            return {
              id, mode, checkpoint,
              balanceLamports: paper.balanceLamports, equityLamports: paper.equityLamports,
              feedHealthy: paper.feedHealthy, lastFeedAtMs: paper.lastFeedAtMs, lastSlot: paper.lastSlot,
              positions: Object.values(paper.positions), pendingOrders: Object.values(paper.orders),
            };
          }),
        });
      } else {
        const next = required(control, "pause, resume, or kill");
        if (db.control("paper") === "killed" && subcommand !== "kill") {
          throw new Error("The paper kill switch is latched");
        }
        db.setControl("paper", next);
        print({ control: next });
      }
    } finally {
      db.close();
    }
    return;
  }
  throw new Error("Unknown command. Use --help.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected failure";
  process.stderr.write(`ShahiniBot: ${message.replace(/(?:https?|wss?):\/\/[^\s]+/gi, "[redacted URL]")}\n`);
  process.exitCode = 1;
});
