import assert from 'node:assert';
import { test } from 'node:test';
import type { Msg } from '../../src/server/chat/prompt.ts';
import { calibrate, fitHistory, toApi } from '../../src/server/chat/prompt.ts';

const cost = { charsPerToken: 4, imageTokens: 100, scale: 1 };
const img = { type: 'image_url' as const, image_url: { url: 'data:image/jpeg;base64,xx' } };
const user = (t: string): Msg => ({ role: 'user', content: t });
const bot = (t: string): Msg => ({ role: 'assistant', content: t });
const withImage = (t: string): Msg => ({ role: 'user', content: [img, { type: 'text', text: t }] });
const pad = (n: number): string => 'x'.repeat(n * 4);

test('a history that fits is sent whole', () => {
  const h = [user('hi'), bot('hello')];
  const r = fitHistory(h, 1000, cost);
  assert.deepStrictEqual(r.msgs, h);
  assert.deepStrictEqual([r.dropped, r.stripped], [0, 0]);
});

test('old images are replaced by a note before any message is dropped', () => {
  const h = [withImage('first'), bot('a cat'), user('and now?'), bot('ok'), user('thanks')];
  const r = fitHistory(h, 70, cost);
  assert.strictEqual(r.msgs.length, 5);
  assert.strictEqual(r.stripped, 1);
  assert.strictEqual(r.dropped, 0);
  const first = r.msgs[0] as Msg;
  assert.ok(Array.isArray(first.content) && first.content.every(p => p.type !== 'image_url'));
  assert.match(JSON.stringify(first.content), /image omitted/);
});

test('the saved history is not changed by trimming', () => {
  const h = [withImage('first'), bot(pad(200)), user('next')];
  fitHistory(h, 50, cost);
  assert.ok(JSON.stringify(h[0]).includes('image_url'));
});

test('images go oldest first and only as many as needed', () => {
  const h = [withImage('a'), bot('1'), withImage('b'), bot('2'), user('c')];
  const r = fitHistory(h, 230, cost);
  assert.strictEqual(r.stripped, 1);
  assert.ok(JSON.stringify(r.msgs[2]).includes('image_url'));
});

test('after images, the oldest messages are dropped and the history starts on a user turn', () => {
  const h = [user(pad(100)), bot(pad(100)), user(pad(100)), bot(pad(100)), user('last')];
  const r = fitHistory(h, 120, cost);
  assert.strictEqual((r.msgs[0] as Msg).role, 'user');
  assert.strictEqual((r.msgs[r.msgs.length - 1] as Msg).content, 'last');
  assert.ok(r.dropped >= 2);
});

test('the latest message is kept even when it alone is over budget', () => {
  const r = fitHistory([user('old'), user(pad(500))], 10, cost);
  assert.strictEqual(r.msgs.length, 1);
});

test('calibrate moves the scale toward the measured ratio and stays in range', () => {
  assert.strictEqual(calibrate(1, 1000, 1000), 1);
  const up = calibrate(1, 1000, 1500);
  assert.ok(up > 1 && up < 1.5);
  assert.strictEqual(calibrate(1, 1000, 1e9), 2.5);
  assert.strictEqual(calibrate(1, 1000, 1), 0.5);
  assert.strictEqual(calibrate(1.2, 0, 500), 1.2);
});

test('toApi drops fields the server does not know', () => {
  const m: Msg = { role: 'user', content: [{ type: 'text', text: 'hello there', voice: true }] };
  assert.deepStrictEqual(toApi([m]), [{ role: 'user', content: [{ type: 'text', text: 'hello there' }] }]);
  assert.deepStrictEqual(toApi([user('plain')]), [{ role: 'user', content: 'plain' }]);
});
