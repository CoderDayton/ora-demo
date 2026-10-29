// A small model copies what it sees: once a generic reply sits in the history it tends to give the same one again,
// so repeated replies are left out of the prompt.
import type { Msg, Part } from './prompt.ts';

// Replies shorter than MIN_REPLY ("Hello!") may repeat; an echo is a reply opening like an earlier one for ECHO_PREFIX.
const MIN_REPLY = 20;
const MIN_ECHO = 25;
const ECHO_PREFIX = 60;

const plain = (m: Msg): string =>
  typeof m.content === 'string' ? m.content : m.content.map((p: Part) => (p.type === 'text' ? p.text : '')).join(' ');

export const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// A turn is a user message and everything up to the next one; messages before the first user message are a turn too.
function starts(hist: Msg[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < hist.length; i++) if (i === 0 || (hist[i] as Msg).role === 'user') out.push(i);
  return out;
}

function reply(hist: Msg[], from: number, to: number): string {
  for (let i = to - 1; i >= from; i--) {
    const m = hist[i] as Msg;
    if (m.role === 'assistant' && !m.tool_calls) return plain(m);
  }
  return '';
}

function without(hist: Msg[], drop: (r: string) => boolean): Msg[] {
  const st = starts(hist);
  const out: Msg[] = [];
  for (let k = 0; k < st.length; k++) {
    const from = st[k] as number;
    const to = k + 1 < st.length ? (st[k + 1] as number) : hist.length;
    if (drop(norm(reply(hist, from, to)))) continue;
    for (let i = from; i < to; i++) out.push(hist[i] as Msg);
  }
  return out;
}

// Leaves out every turn whose reply appears in two or more turns, so the first copy does not seed the next.
export function dropRepeats(hist: Msg[]): Msg[] {
  const st = starts(hist);
  const seen = new Map<string, number>();
  for (let k = 0; k < st.length; k++) {
    const r = norm(reply(hist, st[k] as number, k + 1 < st.length ? (st[k + 1] as number) : hist.length));
    if (r.length >= MIN_REPLY) seen.set(r, (seen.get(r) ?? 0) + 1);
  }
  return without(hist, (r: string) => r.length >= MIN_REPLY && (seen.get(r) ?? 0) >= 2);
}

export function echoes(text: string, hist: Msg[]): boolean {
  const n = norm(text);
  if (n.length < MIN_ECHO) return false;
  const head = n.slice(0, ECHO_PREFIX);
  const st = starts(hist);
  for (let k = 0; k < st.length; k++) {
    const r = norm(reply(hist, st[k] as number, k + 1 < st.length ? (st[k + 1] as number) : hist.length));
    if (r.startsWith(head)) return true;
  }
  return false;
}

export function dropEchoes(hist: Msg[], text: string): Msg[] {
  const head = norm(text).slice(0, ECHO_PREFIX);
  return without(hist, (r: string) => r.startsWith(head));
}

export function lastTurns(hist: Msg[], n: number): Msg[] {
  const st = starts(hist);
  const from = st[Math.max(0, st.length - 1 - Math.max(0, n))] ?? 0;
  return hist.slice(from);
}

// The latest earlier turns as short lines, newest first, for the model to judge what a new message depends on.
export function recap(hist: Msg[], n: number): string[] {
  const st = starts(hist);
  const out: string[] = [];
  for (let k = st.length - 2; k >= 0 && out.length < n; k--) {
    const from = st[k] as number;
    const q = plain(hist[from] as Msg)
      .replace(/\s+/g, ' ')
      .slice(0, 50);
    const r = reply(hist, from, st[k + 1] as number)
      .replace(/\s+/g, ' ')
      .slice(0, 40);
    out.push(`${out.length + 1}. user: ${q} | you: ${r}`);
  }
  return out;
}
