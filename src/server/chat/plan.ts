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
}

// Runs on the recognizer's slot so the chat's cached prompt stays on its own.
const PLAN_SLOT = 1;
const PLAN_MS = 4000;

const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;

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
  const t = num(raw.temperature, 0, 1.2);
  if (t !== undefined) plan.temperature = t;
  const m = num(raw.maxTokens, 64, 2048);
  if (m !== undefined) plan.maxTokens = Math.round(m);
  if (Array.isArray(raw.tools)) plan.tools = arr(raw.tools).filter((g): g is string => typeof g === 'string' && groups.includes(g));
  const p = num(raw.pageShare, 0.1, 0.6);
  if (p !== undefined) plan.pageShare = p;
  const s = num(raw.speed, 0.9, 1.4);
  if (s !== undefined) plan.speed = s;
  const w = num(raw.pauseMs, 600, 1600);
  if (w !== undefined) plan.pauseMs = Math.round(w);
  return plan;
}

const instructions = (groups: string[]): string =>
  `You tune an assistant for one user question. Reply with only a JSON object using these keys: ` +
  `"temperature" (0 to 1.2: low for facts, maths and code, high for creative writing), ` +
  `"maxTokens" (64 to 2048: small for a short answer, large only for long writing), ` +
  `"tools" (a list from ${groups.join(', ')}: only what the question needs; docs reads the uploaded documents, ` +
  `utility is the clock and a calculator, web looks things up online for current events and facts, ` +
  `system runs commands and edits files and is only for when the user asks for that), ` +
  `"pageShare" (0.1 to 0.6: the share of memory for PDF page images, large only when the whole document is needed), ` +
  `"speed" (0.9 to 1.4: speaking speed, faster for casual short replies), ` +
  `"pauseMs" (600 to 1600: how long to wait for the user's next words, longer when the reply will invite a long answer).`;

export async function makePlan(
  port: number,
  slots: number,
  question: string,
  groups: string[],
  hasDocs: boolean,
  cancel: Cancel,
  timeoutMs = PLAN_MS,
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
          { role: 'user', content: `Documents attached: ${hasDocs ? 'yes' : 'no'}\nQuestion: ${question.slice(0, 600)}` },
        ],
        temperature: 0,
        max_tokens: 120,
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
