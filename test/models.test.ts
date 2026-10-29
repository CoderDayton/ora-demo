import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareModelsDir, scanModels } from '../src/server/engine.ts';

function same(actual: unknown, expected: unknown): void {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ora-models-'));
}

test('prepareModelsDir creates a missing folder, parents included, with a README', () => {
  const dir = join(tmp(), 'a', 'b', 'models');
  prepareModelsDir(dir);
  assert.ok(existsSync(join(dir, 'README.txt')));
});

test('the README explains both files and the folder layout', () => {
  const dir = join(tmp(), 'models');
  prepareModelsDir(dir);
  const text = readFileSync(join(dir, 'README.txt'), 'utf8');
  assert.ok(text.includes('.gguf'));
  assert.ok(text.includes('mmproj'));
  assert.ok(/subfolder/i.test(text));
});

test('prepareModelsDir never overwrites a README the user edited', () => {
  const dir = join(tmp(), 'models');
  prepareModelsDir(dir);
  writeFileSync(join(dir, 'README.txt'), 'mine');
  prepareModelsDir(dir);
  same(readFileSync(join(dir, 'README.txt'), 'utf8'), 'mine');
});

test('prepareModelsDir leaves an existing folder and its models alone', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'solo-Q8_0.gguf'), 'x');
  prepareModelsDir(dir);
  same(
    scanModels(dir).map(m => m.name),
    ['solo-Q8_0.gguf'],
  );
});

test('scanModels finds models flat or in subfolders and pairs a projector with its own folder', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'omni'));
  mkdirSync(join(dir, 'text'));
  writeFileSync(join(dir, 'flat-Q4.gguf'), 'x');
  writeFileSync(join(dir, 'omni', 'omni-Q8_0.gguf'), 'x');
  writeFileSync(join(dir, 'omni', 'mmproj-omni-BF16.gguf'), 'x');
  writeFileSync(join(dir, 'text', 'text-Q4.gguf'), 'x');
  const found = scanModels(dir).map(m => [m.name, m.mmproj.map(p => p.slice(dir.length + 1))]);
  same(found, [
    ['flat-Q4.gguf', []],
    ['omni/omni-Q8_0.gguf', ['omni/mmproj-omni-BF16.gguf']],
    ['text/text-Q4.gguf', []],
  ]);
});
