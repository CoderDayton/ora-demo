import assert from 'node:assert';
import { test } from 'node:test';
import { buildContext } from '../src/server/context.ts';
import { chunkText, joinChunks } from '../src/server/docs.ts';
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

test('a chunk too big for what is left does not stop smaller matches from filling the budget', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  const big = `${'zebra '.repeat(40)}${'filler words here '.repeat(100)}`.slice(0, 2000);
  const chunks = ['zebra '.repeat(250).trim(), big, `zebra cmarker ${'plain text '.repeat(40)}`.trim()];
  for (let i = 0; i < 10; i++) chunks.push(`unrelated chunk ${i} `.repeat(20));
  db.addDoc(c.id, 'z.txt', 'text', null, chunks);
  const ctx = buildContext(db, c.id, 'zebra', 3000);
  same(ctx?.mode, 'excerpts');
  assert.ok(ctx?.text.includes('cmarker'), (ctx?.text ?? '').slice(0, 200));
  assert.ok((ctx?.text.length ?? 0) <= 3000 + 200);
});

test('a matching chunk brings its neighbours when there is room, as one excerpt', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  const chunks: string[] = [];
  for (let i = 0; i < 40; i++) chunks.push(`filler paragraph number ${i} about nothing in particular `.repeat(5));
  chunks[16] = 'sixteenmarker leads into the next part '.repeat(5);
  chunks[17] = 'the launch window opens at dawn over the northern pad '.repeat(5);
  chunks[18] = 'eighteenmarker follows from the part before '.repeat(5);
  db.addDoc(c.id, 'big.txt', 'text', null, chunks);
  const ctx = buildContext(db, c.id, 'launch window', 1500);
  const text = ctx?.text ?? '';
  assert.ok(text.includes('sixteenmarker') && text.includes('launch window') && text.includes('eighteenmarker'));
  assert.ok(text.includes('parts 17-19'), text.slice(0, 120));
  assert.ok(text.indexOf('sixteenmarker') < text.indexOf('launch window'));
});

test('overlapping chunks of a long paragraph are joined without repeating text', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  const words: string[] = [];
  for (let i = 0; i < 1000; i++) words.push(`w${i}`);
  db.addDoc(c.id, 'long.txt', 'text', null, chunkText(words.join(' '), 500, 50));
  const ctx = buildContext(db, c.id, '', 100000);
  same(ctx?.mode, 'full');
  const seen = (ctx?.text ?? '').split(/\s+/).filter(w => /^w\d+$/.test(w));
  same(seen, words);
});

test('joinChunks removes the overlap between neighbours and keeps paragraph breaks otherwise', () => {
  same(joinChunks('alpha beta gamma delta epsilon zeta', 'delta epsilon zeta eta theta'), 'alpha beta gamma delta epsilon zeta eta theta');
  same(joinChunks('first paragraph', 'second paragraph'), 'first paragraph\n\nsecond paragraph');
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
