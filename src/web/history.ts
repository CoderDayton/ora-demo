import type { Msg, Part } from './state.ts';

export interface Cost { charsPerToken: number; imageTokens: number; scale: number }
export interface Fit { msgs: Msg[]; dropped: number; stripped: number }

const IMAGE_OMITTED: Part = { type: 'text', text: '[image omitted to save context]' };
const textTokens = (s: string, c: Cost): number => Math.ceil((s.length / c.charsPerToken) * c.scale);

export function estTokens(m: Msg, c: Cost): number {
  if (typeof m.content === 'string') return textTokens(m.content, c) + 6;
  let n = 6;
  for (const p of m.content) {
    n += p.type === 'text' ? textTokens(p.text, c) : p.type === 'input_audio' ? Math.ceil(p.input_audio.data.length / 3300) : c.imageTokens;
  }
  return n;
}

// Trims a copy of the history to fit the budget: images go first, oldest first (the assistant's description of
// each stays in the text), then whole messages from the oldest end. The newest message is always kept.
export function fitHistory(hist: Msg[], budget: number, c: Cost): Fit {
  const msgs = hist.slice();
  let tot = msgs.reduce((a, m) => a + estTokens(m, c), 0);
  let stripped = 0;
  for (let i = 0; i < msgs.length - 1 && tot > budget; i++) {
    const m = msgs[i] as Msg;
    if (typeof m.content === 'string' || !m.content.some(p => p.type === 'image_url')) continue;
    const next: Msg = { role: m.role, content: m.content.map(p => (p.type === 'image_url' ? IMAGE_OMITTED : p)) };
    tot += estTokens(next, c) - estTokens(m, c);
    msgs[i] = next;
    stripped++;
  }
  let dropped = 0;
  while (msgs.length > 1 && tot > budget) { tot -= estTokens(msgs.shift() as Msg, c); dropped++; }
  while (msgs.length > 1 && (msgs[0] as Msg).role !== 'user') { msgs.shift(); dropped++; }
  return { msgs, dropped, stripped };
}

// `scale` multiplies the character-based estimate. After a reply the server reports the real prompt size, so the
// scale moves toward the measured ratio (within 0.5 to 2.5) and the next estimate is closer.
export function calibrate(scale: number, estimated: number, actual: number): number {
  if (!(estimated > 0) || !(actual > 0)) return scale;
  const next = scale + (scale * (actual / estimated) - scale) * 0.6;
  return Math.min(2.5, Math.max(0.5, next));
}

// The wire format: only the fields llama-server defines.
export function toApi(msgs: Msg[]): { role: string; content: string | Part[] }[] {
  return msgs.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map(p => (p.type === 'text' ? { type: 'text' as const, text: p.text } : p)),
  }));
}
