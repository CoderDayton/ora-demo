import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Persona } from '../src/web/persona.ts';
import type { Look, Senses } from '../src/web/persona.ts';

const calm: Senses = { mode: 'idle', mic: 0, out: 0, rate: 0, ctx: 0, kv: 0, thinking: false, tool: false, typing: false, pointer: null };

// Deterministic randomness: a small LCG.
function lcg(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

interface Run { p: Persona; t: number; look: Look }
function start(rand = lcg(7)): Run {
  const p = new Persona(undefined, rand);
  return { p, t: 0, look: p.update(1 / 60, calm, 0) };
}
function settle(r: Run, s: Senses, seconds: number): Look {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) { r.t += 1 / 60; r.look = r.p.update(1 / 60, s, r.t); }
  return r.look;
}

test('a finished reply updates memory counters and the running averages', () => {
  const r = start();
  r.p.event({ type: 'reply_done', tps: 100, ttft: 200, tokens: 50 }, r.t);
  r.p.event({ type: 'reply_done', tps: 50, ttft: 400, tokens: 30 }, r.t);
  assert.equal(r.p.memory.turns, 2);
  assert.equal(r.p.memory.tokensOut, 80);
  assert.ok(r.p.memory.avgTps > 50 && r.p.memory.avgTps < 100);
  assert.ok(r.p.memory.avgTtft > 200 && r.p.memory.avgTtft < 400);
});

test('input events are counted by kind', () => {
  const r = start();
  r.p.event({ type: 'user_image' }, 0);
  r.p.event({ type: 'user_voice' }, 0);
  r.p.event({ type: 'user_voice' }, 0);
  r.p.event({ type: 'doc' }, 0);
  assert.deepEqual([r.p.memory.images, r.p.memory.voiceTurns, r.p.memory.docs], [1, 2, 1]);
});

test('an error shows at once, lowers valence, then fades back to idle', () => {
  const r = start();
  settle(r, calm, 1);
  const before = r.p.mood.valence;
  r.p.event({ type: 'error' }, r.t);
  assert.equal(r.p.expression, 'error');
  assert.ok(r.p.mood.valence < before);
  assert.equal(r.p.memory.errors, 1);
  settle(r, calm, 8);
  assert.equal(r.p.expression, 'idle');
});

test('thinking squints the eyes and looks up and away', () => {
  const r = start();
  const idle = settle(r, calm, 2);
  const look = settle(r, { ...calm, mode: 'prefill', thinking: true }, 2);
  assert.equal(r.p.expression, 'thinking');
  assert.ok(look.eyeOpen < idle.eyeOpen || look.eyeOpen < 0.8);
  assert.ok(look.gazeY > 0.25);
});

test('tool calls make the eyes scan sideways', () => {
  const r = start();
  const xs: number[] = [];
  for (let i = 0; i < 120; i++) {
    r.t += 1 / 60;
    r.look = r.p.update(1 / 60, { ...calm, mode: 'gen', tool: true }, r.t);
    xs.push(r.look.gazeX);
  }
  assert.equal(r.p.expression, 'tool');
  assert.ok(r.look.scan > 0.5);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 0.8);
});

test('a nearly full context strains the persona and pulls its colour toward red', () => {
  const r = start();
  const relaxed = settle(r, { ...calm, mode: 'gen', rate: 50 }, 3).hue;
  const look = settle(r, { ...calm, mode: 'gen', rate: 50, ctx: 0.96 }, 6);
  assert.equal(r.p.expression, 'strained');
  assert.ok(look.strain > 0.6);
  const toRed = (h: number): number => Math.min(Math.abs(h - 8), 360 - Math.abs(h - 8));
  assert.ok(toRed(look.hue) < toRed(relaxed));
});

test('a good reply makes it happy for a moment', () => {
  const r = start();
  settle(r, calm, 1);
  r.p.event({ type: 'reply_done', tps: 250, ttft: 100, tokens: 40 }, r.t);
  assert.equal(r.p.expression, 'happy');
  const look = settle(r, calm, 0.5);
  assert.ok(look.eyeSmile > 0.6);
  settle(r, calm, 5);
  assert.equal(r.p.expression, 'idle');
});

test('receiving an image or document startles it with wide eyes', () => {
  const r = start();
  const idle = settle(r, calm, 2);
  r.p.event({ type: 'user_image' }, r.t);
  const look = settle(r, calm, 0.25);
  assert.equal(r.p.expression, 'surprised');
  assert.ok(look.eyeScale > idle.eyeScale + 0.15);
});

test('long silence makes it sleepy and an offline engine closes its eyes', () => {
  const r = start();
  const awake = settle(r, calm, 5);
  settle(r, calm, 150);
  assert.ok(r.look.eyeOpen < awake.eyeOpen - 0.2);
  assert.equal(r.p.expression, 'sleepy');
  const off = settle(r, { ...calm, mode: 'off' }, 3);
  assert.ok(off.eyeOpen < 0.15);
});

test('it blinks on its own and the eyes reopen afterwards', () => {
  const r = start();
  let min = 1;
  let reopened = false;
  for (let i = 0; i < 60 * 20; i++) {
    r.t += 1 / 60;
    const o = r.p.update(1 / 60, calm, r.t).eyeOpen;
    if (o < min) min = o;
    if (min < 0.3 && o > 0.8) reopened = true;
  }
  assert.ok(min < 0.3);
  assert.ok(reopened);
});

test('hearing the user widens the eyes with the microphone level', () => {
  const r = start();
  const idle = settle(r, calm, 2);
  const look = settle(r, { ...calm, mode: 'listening', mic: 0.5 }, 1);
  assert.equal(r.p.expression, 'listening');
  assert.ok(look.eyeScale > idle.eyeScale);
});

test('it looks toward the pointer when idle', () => {
  const r = start();
  const look = settle(r, { ...calm, pointer: { x: 1, y: 0 } }, 2);
  assert.ok(look.gazeX > 0.3);
});

test('typing makes it look down toward the composer', () => {
  const r = start();
  const look = settle(r, { ...calm, typing: true }, 2);
  assert.ok(look.gazeY < -0.3);
});

test('memory survives a snapshot round trip and bad values fall back to defaults', () => {
  const r = start();
  r.p.event({ type: 'reply_done', tps: 90, ttft: 150, tokens: 20 }, 1);
  const copy = new Persona(JSON.parse(JSON.stringify(r.p.snapshot())) as never, lcg(1));
  assert.equal(copy.memory.turns, 1);
  assert.equal(copy.memory.avgTps, r.p.memory.avgTps);
  const bad = new Persona({ turns: Number.NaN, avgTps: -5, baseline: { valence: 99, arousal: -3, curiosity: 0.5, strain: 0 } } as never, lcg(1));
  assert.equal(bad.memory.turns, 0);
  assert.ok(bad.memory.avgTps >= 0);
  assert.ok(bad.memory.baseline.valence <= 1 && bad.memory.baseline.arousal >= 0);
});

test('familiarity warms the resting mood as turns accumulate', () => {
  const a = new Persona(undefined, lcg(1));
  const b = new Persona({ turns: 400 } as never, lcg(1));
  assert.ok(b.mood.valence > a.mood.valence);
});
