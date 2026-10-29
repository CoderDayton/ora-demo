import assert from 'node:assert';
import { test } from 'node:test';
import { Vad } from '../src/web/vad.ts';

const FRAME = 43;
function feed(v: Vad, level: number, ms: number, t: { now: number }, playing = false): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.round(ms / FRAME); i++) {
    t.now += FRAME;
    const e = v.push(level, t.now, playing);
    if (e) out.push(e);
  }
  return out;
}

test('quiet room never triggers', () => {
  const t = { now: 0 };
  assert.deepStrictEqual(feed(new Vad(), 0.004, 3000, t), []);
});

test('speech starts an utterance and a pause ends it', () => {
  const t = { now: 0 },
    v = new Vad();
  feed(v, 0.004, 500, t);
  assert.deepStrictEqual(feed(v, 0.1, 600, t), ['start']);
  assert.deepStrictEqual(feed(v, 0.004, 1200, t), ['end']);
});

test('a short pause inside a sentence does not end it', () => {
  const t = { now: 0 },
    v = new Vad();
  feed(v, 0.1, 400, t);
  assert.deepStrictEqual(feed(v, 0.004, 500, t), []);
  assert.deepStrictEqual(feed(v, 0.1, 400, t), []);
  assert.deepStrictEqual(feed(v, 0.004, 1200, t), ['end']);
});

test('the pause length is configurable', () => {
  const t = { now: 0 },
    v = new Vad({ silenceMs: 400 });
  feed(v, 0.1, 400, t);
  assert.deepStrictEqual(feed(v, 0.004, 600, t), ['end']);
});

test('a click while the model is speaking is ignored, sustained speech interrupts it', () => {
  const t = { now: 0 },
    v = new Vad();
  feed(v, 0.004, 500, t);
  assert.deepStrictEqual(feed(v, 0.06, 90, t, true), []);
  feed(v, 0.004, 200, t, true);
  assert.deepStrictEqual(feed(v, 0.1, 600, t, true), ['barge']);
});

test('the speaker bleeding into the mic at a moderate level does not interrupt', () => {
  const t = { now: 0 },
    v = new Vad();
  feed(v, 0.004, 500, t);
  assert.deepStrictEqual(feed(v, 0.03, 2000, t, true), []);
});

test('an utterance is cut off at the maximum length', () => {
  const t = { now: 0 },
    v = new Vad({ maxMs: 2000 });
  const e = feed(v, 0.1, 3000, t);
  assert.deepStrictEqual(e, ['start', 'end', 'start']);
});

// A short pause lets transcription start early; speech coming back means that transcription is thrown away.
test('with a pause length set, a short pause is reported and speech after it resumes the utterance', () => {
  const t = { now: 0 },
    v = new Vad({ pauseMs: 300 });
  feed(v, 0.1, 400, t);
  assert.deepStrictEqual(feed(v, 0.004, 500, t), ['pause']);
  assert.deepStrictEqual(feed(v, 0.1, 400, t), ['resume']);
  assert.deepStrictEqual(feed(v, 0.004, 1200, t), ['pause', 'end']);
});

test('an utterance cut at the maximum length ends without a pause', () => {
  const t = { now: 0 },
    v = new Vad({ pauseMs: 300, maxMs: 2000 });
  assert.deepStrictEqual(feed(v, 0.1, 2500, t), ['start', 'end', 'start']);
});

test('reset forgets an utterance in progress', () => {
  const t = { now: 0 },
    v = new Vad();
  feed(v, 0.1, 400, t);
  v.reset();
  assert.deepStrictEqual(feed(v, 0.004, 1500, t), []);
});
