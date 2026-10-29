import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Engine } from '../src/server/engine.ts';

// A spawn that fails leaves a child with no pid and never emits 'exit'. Signalling pid 0 would hit Ora's own
// process group, so the test records signals instead of sending them.
test('stopping an engine whose binary failed to start resolves and never signals pid 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ora-engine-'));
  writeFileSync(join(dir, 'm.gguf'), 'x');
  const sent: number[] = [];
  const e = new Engine(join(dir, 'no-such-llama-server'), 18990, dir, [], (pid: number, _sig: string) => {
    sent.push(pid);
  });
  await e.start({ model: join(dir, 'm.gguf'), mmproj: '', ctx: 4096, reasoning: 'off', parallel: 2 });
  const stopped = await Promise.race([e.stop().then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 7000))]);
  assert.strictEqual(stopped, true);
  assert.strictEqual(sent.filter(p => p <= 0).length, 0);
});

// Speech recognition runs on its own slot only when the engine was started with more than one.
test('the engine reports the slot count it was started with, and one before any start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ora-engine-'));
  writeFileSync(join(dir, 'm.gguf'), 'x');
  const e = new Engine(join(dir, 'no-such-llama-server'), 18991, dir, [], (_pid: number, _sig: string) => {});
  assert.strictEqual(e.slots(), 1);
  await e.start({ model: join(dir, 'm.gguf'), mmproj: '', ctx: 4096, reasoning: 'off', parallel: 3 });
  assert.strictEqual(e.slots(), 3);
  await e.stop();
});
