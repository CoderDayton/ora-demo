import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { filterModels, prepareModelsDir, scanModels } from '../../src/server/engine/engine.ts';

function same(actual: unknown, expected: unknown): void {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ora-models-'));
}

test('a model filter keeps the models whose path contains it, ignoring case; empty keeps all', () => {
  const m = (path: string) => ({ path, name: path, sizeMB: 1, mmproj: [] });
  const all = [m('/m/lfm3-omni/LFM3-Omni-2B-Q8_0.gguf'), m('/m/Qwen3.5-2B/q.gguf'), m('/m/lfm3-audio/a.gguf')];
  same(
    filterModels(all, 'lfm3').map(x => x.path),
    ['/m/lfm3-omni/LFM3-Omni-2B-Q8_0.gguf', '/m/lfm3-audio/a.gguf'],
  );
  same(filterModels(all, '').length, 3);
  same(filterModels(all, 'nothing'), []);
});

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
