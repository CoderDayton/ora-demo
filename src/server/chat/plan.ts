// Auto mode: before a turn the loaded model is asked, in one short call, how to run it. The answer tunes the reply
// (temperature, length, tools, how much of a PDF to send) and the voice (speed, how long to wait for the next
// utterance). A bad or missing answer is an empty plan, and the turn runs with the user's own settings.
import type { Json } from '../llm/llama.ts';
import { arr, Cancel, callLlama, obj } from '../llm/llama.ts';

export interface Plan {
  temperature?: number;
  maxTokens?: number;
  tools?: string[];
  pageShare?: number;
  speed?: number;
  pauseMs?: number;
  memory?: number;
}

// Runs on the recognizer's slot so the chat's cached prompt stays on its own.
const PLAN_SLOT = 1;
export const PLAN_MS = 4000;
// A memory of this many turns or more means the whole conversation.
export const MEMORY_ALL = 8;

const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;

// A word from `names` as the value at the same place in `values`; 0 stands for "no change" and is not applied.
const word = (v: unknown, names: string[], values: number[]): number | undefined => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  let at = -1;
  for (let i = 0; i < names.length && at < 0; i++) if (s.startsWith(names[i] as string)) at = i;
  const x = at >= 0 ? values[at] : 0;
  return x ? x : undefined;
};

export function parsePlan(text: string, groups: string[]): Plan {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return {};
  let raw: Json;
  try {
    raw = obj(JSON.parse(text.slice(a, b + 1)));
  } catch {
    return {};
  }
  const plan: Plan = {};
  const t = num(raw.temperature, 0, 1.2) ?? word(raw.tone, ['precise', 'balanced', 'creative'], [0.2, 0.7, 1]);
  if (t !== undefined) plan.temperature = t;
  const m = num(raw.maxTokens, 64, 2048) ?? word(raw.length, ['short', 'normal', 'long'], [160, 400, 1200]);
  if (m !== undefined) plan.maxTokens = Math.round(m);
  const listed = typeof raw.tools === 'string' ? raw.tools.split(',').map(g => g.trim()) : raw.tools;
  if (Array.isArray(listed)) plan.tools = arr(listed).filter((g): g is string => typeof g === 'string' && groups.includes(g));
  const p = num(raw.pageShare, 0.1, 0.6) ?? word(raw.pages, ['few', 'some', 'many'], [0.15, 0.3, 0.5]);
  if (p !== undefined) plan.pageShare = p;
  const s = num(raw.speed, 0.9, 1.4) ?? word(raw.speed, ['slow', 'normal', 'fast'], [0.95, 0, 1.3]);
  if (s !== undefined) plan.speed = s;
  const w = num(raw.pauseMs, 600, 1600) ?? word(raw.wait, ['short', 'normal', 'long'], [700, 0, 1400]);
  if (w !== undefined) plan.pauseMs = Math.round(w);
  const mem = num(raw.memory, 1, MEMORY_ALL) ?? word(raw.memory, ['new', 'recent', 'all'], [1, 3, 0]);
  if (mem !== undefined) plan.memory = Math.round(mem);
  return plan;
}

const instructions = (groups: string[]): string =>
  `You tune an assistant for one user question. Reply with only a JSON object using these keys, each set to one of the ` +
  `words shown (the first is the usual choice): ` +
  `"tone" (balanced, precise for facts, maths and code, creative for stories and ideas), ` +
  `"length" (normal, short for a quick answer, long only for long writing), ` +
  `"tools" (a list from ${groups.join(', ')}, empty when none is needed; docs reads the uploaded documents, ` +
  `utility is the clock and a calculator, web looks things up online for current events and facts, ` +
  `system runs commands and edits files and is only for when the user asks for that), ` +
  `"pages" (some, few, many: how much of a PDF to look at, many only when the whole document is needed), ` +
  `"speed" (normal, slow, fast: speaking speed), ` +
  `"wait" (normal, short, long: how long to wait for the user's next words, long when the reply invites a long answer), ` +
  `"memory" (all, recent for the last few earlier turns listed, new when the question starts a new topic).`;

export async function makePlan(
  port: number,
  slots: number,
  question: string,
  groups: string[],
  hasDocs: boolean,
  cancel: Cancel,
  timeoutMs = PLAN_MS,
  recent: string[] = [],
): Promise<Plan> {
  if (slots < 2) return {};
  // The call can queue behind a transcription on the same slot; waiting longer than this costs more than the plan saves.
  const own = new Cancel();
  cancel.on(() => own.cancel());
  const timer = setTimeout(() => own.cancel(), timeoutMs);
  try {
    const r = await callLlama(
      port,
      'POST',
      '/v1/chat/completions',
      {
        messages: [
          { role: 'system', content: instructions(groups) },
          {
            role: 'user',
            content:
              `Documents attached: ${hasDocs ? 'yes' : 'no'}\n` +
              `Earlier turns, newest first:\n${recent.length ? recent.join('\n') : '(none)'}\n` +
              `Question: ${question.slice(0, 600)}`,
          },
        ],
        temperature: 0,
        max_tokens: 140,
        id_slot: PLAN_SLOT,
      },
      null,
      own,
    );
    const text = obj(obj(arr(r.choices)[0]).message).content;
    return typeof text === 'string' && !own.cancelled ? parsePlan(text, groups) : {};
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}
