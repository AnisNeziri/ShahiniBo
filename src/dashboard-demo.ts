import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { PaperEngine } from './engine.ts';
import { verifyCreator } from './identity.ts';
import { Ledger } from './ledger.ts';
import { loadSettings } from './settings.ts';
import { readTape } from './tape.ts';

export async function dashboardDemo() {
  const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  const tape = await readTape(fixture('ladder-events.jsonl'));
  const config = loadSettings(fixture('ladder.demo.json'), 'paper');
  const directory = mkdtempSync(join(tmpdir(), 'shahinibot-dashboard-'));
  const database = join(directory, 'demo.sqlite');
  const runId = 'dashboard-demo';
  const stop = new AbortController();
  const writer = new Ledger(database);
  const engine = new PaperEngine({
    id: runId, ledger: writer, mode: 'replay', settings: config.paper!,
    verifyCreator: (event, now, chain) => verifyCreator(event, config.allowlist!.creators, now, chain),
    policyProvenance: { fixtures: true, tape: 'ladder-events.jsonl' },
  });
  let replaying: Promise<void> | undefined;
  async function play() {
    const first = tape[0]!.receivedAtMs;
    const last = tape.at(-1)!.receivedAtMs;
    await wait(600, undefined, { signal: stop.signal });
    const start = performance.now();
    let index = 0;
    for (;;) {
      const now = Math.min(last, first + Math.floor((performance.now() - start) / 3));
      while (index < tape.length && tape[index]!.receivedAtMs <= now) {
        const event = tape[index++]!;
        engine.accept(event);
      }
      engine.advance(now);
      if (now >= last) break;
      await wait(120, undefined, { signal: stop.signal });
    }
    engine.finish();
  }
  return {
    database, runId,
    onConnect() {
      replaying ??= play().catch(error => {
        if (!stop.signal.aborted) process.stderr.write(`Dashboard replay failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      });
    },
    async close() {
      stop.abort();
      await replaying;
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
