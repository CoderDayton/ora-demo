import assert from 'node:assert';
import { test } from 'node:test';
import { buildContext } from '../src/server/context.ts';
import { openStore } from '../src/server/store.ts';

function same(actual: unknown, expected: unknown): void {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test('no documents gives no context', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  same(buildContext(db, c.id, 'anything', 5000), null);
});

test('small documents are inlined whole', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  db.addDoc(c.id, 'a.txt', 'text', null, ['alpha one', 'alpha two']);
  db.addDoc(c.id, 'b.txt', 'text', null, ['bravo']);
  const ctx = buildContext(db, c.id, 'unrelated', 5000);
  same(ctx?.mode, 'full');
  assert.ok(ctx?.text.includes('a.txt') && ctx?.text.includes('alpha two') && ctx?.text.includes('bravo'));
  same(ctx?.sources, ['a.txt', 'b.txt']);
});

test('large documents give the best-matching excerpts within the budget', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  const chunks: string[] = [];
  for (let i = 0; i < 40; i++) chunks.push(`filler paragraph number ${i} about nothing in particular `.repeat(10));
  chunks[17] = 'the launch window opens at dawn over the northern pad '.repeat(8);
  db.addDoc(c.id, 'big.txt', 'text', null, chunks);
  const ctx = buildContext(db, c.id, 'when does the launch window open', 3000);
  same(ctx?.mode, 'excerpts');
  assert.ok(ctx?.text.includes('launch window opens at dawn'));
  assert.ok((ctx?.text.length ?? 0) <= 3000 + 200);
  same(ctx?.sources, ['big.txt']);
});

test('large documents with an empty query fall back to the opening chunks', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  const chunks: string[] = [];
  for (let i = 0; i < 40; i++) chunks.push(`chunk-${i} `.repeat(100));
  db.addDoc(c.id, 'big.txt', 'text', null, chunks);
  const ctx = buildContext(db, c.id, '', 2500);
  same(ctx?.mode, 'excerpts');
  assert.ok(ctx?.text.includes('chunk-0'));
});

test('large documents with a query that matches nothing fall back to the opening chunks', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  const chunks: string[] = [];
  for (let i = 0; i < 40; i++) chunks.push(`chunk-${i} `.repeat(100));
  db.addDoc(c.id, 'big.txt', 'text', null, chunks);
  const ctx = buildContext(db, c.id, 'zzzzqqqq', 2500);
  assert.ok(ctx?.text.includes('chunk-0'));
});
