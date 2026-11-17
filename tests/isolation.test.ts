import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("paper and replay work when live signing and venue SDK imports are unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "shahinibot-isolation-"));
  try {
    const policy = JSON.parse(readFileSync("fixtures/paper.demo.json", "utf8"));
    const paper = join(directory, "paper.json");
    writeFileSync(paper, JSON.stringify({
      ...policy,
      database: join(directory, "paper.sqlite"),
      capture: join(directory, "capture.jsonl"),
      allowlist: resolve("fixtures/demo-allowlist.json"),
    }));
    const hook = `import {registerHooks} from "node:module";
      registerHooks({resolve(specifier, context, next) {
        if (specifier.includes("pump-sdk") || specifier.includes("pump-swap-sdk") ||
            /\\/live(?:-solana)?\\.ts$/.test(specifier)) {
          throw new Error("Live SDK or signer import in a non-live command");
        }
        return next(specifier, context);
      }});`;
    const run = (...args: string[]) => spawnSync(process.execPath, [
      "--import", "data:text/javascript," + encodeURIComponent(hook), "src/cli.ts", ...args, "--config", paper,
    ], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, SOLANA_RPC_URL: "http://127.0.0.1:1", SOLANA_WS_URL: "ws://127.0.0.1:1" },
    });
    const replay = run("replay", "--input", "fixtures/pumpfun-events.jsonl");
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).summary.orders.entry.filled, 2);
    const liveFeedPaper = run("run", "paper", "--seconds", "1");
    assert.equal(liveFeedPaper.status, 0, liveFeedPaper.stderr);
    assert.match(liveFeedPaper.stdout, /"mode": "paper"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
