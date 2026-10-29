// One chat turn, run by the server: stores the question, builds the prompt (documents, PDF pages, history), streams
// the reply from llama-server back as events and stores it. Voice is transcribed beforehand with transcribe().

import type { PageRenderer } from '../docs/pages.ts';
import type { Json } from '../llm/llama.ts';
import { arr, Cancel, callLlama, obj } from '../llm/llama.ts';
import type { DocMeta, Message, Store } from '../store/store.ts';
import { Approvals } from '../tools/approvals.ts';
import { definitions, find, GROUPS, summarize } from '../tools/catalog.ts';
import type { ToolEnv } from '../tools/run.ts';
import { runTool } from '../tools/run.ts';
import { buildContext } from './context.ts';
import type { ApiMsg, Cost, Msg, PageGroup, PageRef, Part, Window } from './prompt.ts';
import { assemble, calibrate, estTokens, fitHistory, selectPages } from './prompt.ts';

export { Cancel };

export interface TurnDeps {
  store: Store;
  pages: PageRenderer;
  llamaPort: number;
  slots: () => number;
  tools: ToolEnv;
}
export interface TurnRequest {
  chatId: number | null;
  text: string;
  voice: boolean;
  images: string[];
  system: string;
  temperature: number;
  maxTokens: number;
  ranges: Record<string, string>;
  // Tool groups the user switched on for this turn; the config's `allowed` list is the ceiling.
  tools: string[];
}

const CHARS_PER_TOKEN = 3.6;
// Measured on LFM3-Omni: a 792x1024 page added about 780 prompt tokens. Cost grows with the page's area.
const IMG_TOKENS = 800;
const SHARE_TEXT = 0.4;
const SHARE_PAGES = 0.5;
// Replies always run on slot 0 and speech recognition on slot 1, so neither evicts the other's cached prompt.
const CHAT_SLOT = 0;
const ASR_SLOT = 1;
const MAX_ROUNDS = 8;
// How much of a tool's output goes to the page; the model gets all of it (the tools cap their own output).
const UI_OUTPUT = 1500;

interface PendingCall {
  id: string;
  name: string;
  args: string;
}
interface Round {
  text: string;
  calls: PendingCall[];
  usage: Json;
  timings: Json;
}

const clampNum = (v: unknown, d: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

export function parseTurn(b: Json): TurnRequest {
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  const images: string[] = [];
  for (const v of arr(b.images)) if (typeof v === 'string' && v.startsWith('data:image/') && images.length < 8) images.push(v);
  if (!text && !images.length) throw new Error('nothing to send');
  const ranges: Record<string, string> = {};
  const r = obj(b.ranges);
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (typeof v === 'string') ranges[k] = v.slice(0, 200);
  }
  const id = b.chatId;
  return {
    chatId: typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null,
    text,
    voice: b.voice === true,
    images,
    system: typeof b.system === 'string' ? b.system.slice(0, 20000) : '',
    temperature: clampNum(b.temperature, 0.7, 0, 2),
    maxTokens: Math.round(clampNum(b.maxTokens, 1024, 16, 8192)),
    ranges,
    tools: arr(b.tools).filter((g): g is string => typeof g === 'string' && GROUPS.some(x => x === g)),
  };
}

// "1-6,9" to page numbers within 1..max, in the order given, without repeats.
export function parseRange(spec: string, max: number): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = Math.max(1, a); n <= Math.min(max, b); n++) if (!out.includes(n)) out.push(n);
  }
  return out;
}

function userContent(t: TurnRequest): string | Part[] {
  const text = t.text || 'Describe this image.';
  if (!t.images.length && !t.voice) return text;
  const parts: Part[] = t.images.map((url: string): Part => ({ type: 'image_url', image_url: { url } }));
  parts.push(t.voice ? { type: 'text', text, voice: true } : { type: 'text', text });
  return parts;
}

// A stored message as the prompt needs it. Content is checked, since it was read back from JSON.
function toMsg(m: Message): Msg | null {
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  const parts: Part[] = [];
  for (const v of arr(m.content)) {
    const p = obj(v);
    if (p.type === 'text' && typeof p.text === 'string') {
      parts.push(p.voice === true ? { type: 'text', text: p.text, voice: true } : { type: 'text', text: p.text });
    } else if (p.type === 'image_url') {
      const url = obj(p.image_url).url;
      if (typeof url === 'string') parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  return { role: m.role, content: parts };
}

function textOf(m: Msg): string {
  if (typeof m.content === 'string') return m.content;
  let s = '';
  for (const p of m.content) if (p.type === 'text') s += p.text;
  return s;
}

const BASE_PX = 1024;
const pageTokens = (d: DocMeta): number => Math.round(IMG_TOKENS * ((d.px ?? BASE_PX) / BASE_PX) ** 2);

export class Turns {
  private deps: TurnDeps;
  // Per chat: where its history was last cut, which PDF pages it was last sent, and the last trim it was told about.
  private windows = new Map<number, Window>();
  private chosen = new Map<number, PageRef[]>();
  private trims = new Map<number, string>();
  // Character estimates times this match the model's real token count; see calibrate().
  private scale = 1;
  private seq = 0;
  // Calls that act on the machine wait here for the user's Allow or Deny.
  readonly approvals = new Approvals();

  constructor(deps: TurnDeps) {
    this.deps = deps;
  }

  async run(t: TurnRequest, emit: (e: Json) => void, cancel: Cancel): Promise<void> {
    const store = this.deps.store;
    const send = (e: Json): void => {
      if (!cancel.cancelled) emit(e);
    };
    const note = (text: string): void => send({ type: 'note', text });

    const existing = t.chatId === null ? null : store.getChat(t.chatId);
    if (t.chatId !== null && !existing) throw new Error('no such chat');
    const chatId = existing ? existing.id : store.createChat('').id;
    const first = store.messages(chatId).length === 0;
    const um = store.addMessage(chatId, 'user', userContent(t));
    if (first) store.renameChat(chatId, t.text.replace(/\s+/g, ' ').slice(0, 48) || (t.voice ? 'Voice chat' : 'Image chat'));
    send({ type: 'chat', chat: store.getChat(chatId) });
    send({ type: 'user', message: um });

    let text = '';
    let usage = null as Json | null;
    let timings = null as Json | null;
    let error = '';
    let fixedPages = 0;
    let estSent = 0;
    let usedTools = false;
    const steps: Json[] = [];
    try {
      const props = await callLlama(this.deps.llamaPort, 'GET', '/props', null, null, cancel);
      const nctx = Number(obj(props.default_generation_settings).n_ctx) || 0;
      const vision = obj(props.modalities).vision === true;
      if (!(nctx > 0)) throw new Error('the model is not ready');

      const hist: Msg[] = [];
      for (const m of store.messages(chatId)) {
        const msg = toMsg(m);
        if (msg) hist.push(msg);
      }
      // The question plus the one before it, so a follow-up such as "and the second one?" still finds its text.
      const query = hist
        .filter(m => m.role === 'user')
        .slice(-2)
        .map(textOf)
        .join('\n');

      const docs = store.docs(chatId);
      const pdfs = docs.filter(d => d.kind === 'pdf' && (d.pages ?? 0) > 0);
      const hasText = docs.some(d => d.kind !== 'pdf');
      let docsText = '';
      let excerpts = '';
      if (hasText) {
        const ctx = buildContext(store, chatId, query, Math.floor(nctx * (pdfs.length ? 0.2 : SHARE_TEXT) * CHARS_PER_TOKEN));
        if (ctx?.mode === 'full') docsText = ctx.text;
        else if (ctx) excerpts = ctx.text;
      }
      let groups: PageGroup[] = [];
      if (pdfs.length && !vision) note('this model has no vision encoder: PDF pages were not sent');
      else if (pdfs.length) {
        groups = await this.pages(chatId, pdfs, query, t.ranges, Math.floor(nctx * (hasText ? 0.4 : SHARE_PAGES)), note);
        for (const g of groups) {
          const d = pdfs.find(x => x.name === g.name);
          fixedPages += g.pages.length * (d ? pageTokens(d) : IMG_TOKENS);
        }
      }

      const cost: Cost = { charsPerToken: CHARS_PER_TOKEN, imageTokens: IMG_TOKENS, scale: this.scale };
      const sysTokens = Math.ceil(((t.system.length + docsText.length + excerpts.length) / CHARS_PER_TOKEN) * this.scale);
      const budget = nctx - t.maxTokens - sysTokens - fixedPages - 64;
      const fit = fitHistory(hist, budget, cost, this.windows.get(chatId));
      this.windows.set(chatId, fit.window);
      const trim = fit.dropped || fit.stripped ? `${fit.dropped}/${fit.stripped}` : '';
      if (trim && trim !== (this.trims.get(chatId) ?? '')) {
        note(
          `context full: ${fit.stripped ? `${fit.stripped} older image(s) and ` : ''}${fit.dropped} oldest message(s) left out of this reply`,
        );
      }
      this.trims.set(chatId, trim);
      estSent = sysTokens + fit.msgs.reduce((a: number, m: Msg) => a + estTokens(m, cost), 0);

      const enabled = t.tools.filter(g => this.deps.tools.allowed.includes(g));
      const defs = definitions(enabled);
      const convo: Json[] = assemble({ system: t.system, docs: docsText, pages: groups, history: fit.msgs, excerpts }).map(
        (m: ApiMsg) => m as unknown as Json,
      );
      // Each round is one completion. If the model asks for tools they run and their results go back in the next
      // round; after MAX_ROUNDS the model has to answer without them.
      for (let round = 0; ; round++) {
        const last = round >= MAX_ROUNDS || defs.length === 0;
        const body: Json = {
          messages: convo,
          stream: true,
          stream_options: { include_usage: true },
          cache_prompt: true,
          id_slot: CHAT_SLOT,
          temperature: t.temperature,
          max_tokens: t.maxTokens,
        };
        if (!last) body.tools = defs;
        const r = await this.complete(body, send, cancel);
        text += r.text;
        if (Object.keys(r.usage).length) usage = r.usage;
        if (Object.keys(r.timings).length) timings = r.timings;
        if (last || !r.calls.length || cancel.cancelled) break;
        usedTools = true;
        if (r.text) {
          text += '\n\n';
          send({ type: 'delta', content: '\n\n', reasoning: '', tool: false });
        }
        convo.push({
          role: 'assistant',
          content: r.text || null,
          tool_calls: r.calls.map((c: PendingCall, i: number) => ({
            id: c.id || `call_${i}`,
            type: 'function',
            function: { name: c.name, arguments: c.args },
          })),
        });
        for (let i = 0; i < r.calls.length; i++) {
          const c = r.calls[i] as PendingCall;
          const output = await this.exec(c, chatId, enabled, send, cancel, steps);
          convo.push({ role: 'tool', tool_call_id: c.id || `call_${i}`, content: output });
          if (cancel.cancelled) break;
        }
        if (cancel.cancelled) break;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    // Steps are kept for the page only: toMsg() leaves 'tool' rows out of the prompt.
    if (steps.length) store.addMessage(chatId, 'tool', steps);
    const am = text ? store.addMessage(chatId, 'assistant', text) : null;
    const prompt = Number(usage?.prompt_tokens ?? 0);
    // With tool rounds the prompt includes tool results the estimate never covered, so it would skew the scale.
    if (prompt > 0 && !usedTools) this.scale = calibrate(this.scale, estSent, Math.max(0, prompt - fixedPages));
    const cached = Number(timings?.cache_n ?? NaN),
      fresh = Number(timings?.prompt_n ?? NaN);
    const done: Json = {
      type: 'done',
      message: am,
      usage,
      timings,
      cache: cached + fresh > 0 ? cached / (cached + fresh) : null,
    };
    if (error) done.error = error;
    send(done);
  }

  private async complete(body: Json, send: (e: Json) => void, cancel: Cancel): Promise<Round> {
    const r: Round = { text: '', calls: [], usage: {}, timings: {} };
    await callLlama(
      this.deps.llamaPort,
      'POST',
      '/v1/chat/completions',
      body,
      (e: Json) => {
        const delta = obj(obj(arr(e.choices)[0]).delta);
        const content = typeof delta.content === 'string' ? delta.content : '';
        const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
        const pieces = arr(delta.tool_calls);
        for (const p of pieces) {
          const c = obj(p);
          const f = obj(c.function);
          const at = Number(c.index ?? 0);
          while (r.calls.length <= at) r.calls.push({ id: '', name: '', args: '' });
          const slot = r.calls[at] as PendingCall;
          if (typeof c.id === 'string') slot.id = c.id;
          if (typeof f.name === 'string') slot.name += f.name;
          if (typeof f.arguments === 'string') slot.args += f.arguments;
        }
        if (content || reasoning || pieces.length) {
          r.text += content;
          send({ type: 'delta', content, reasoning, tool: pieces.length > 0 });
        }
        if (e.usage !== undefined) r.usage = obj(e.usage);
        if (e.timings !== undefined) r.timings = obj(e.timings);
      },
      cancel,
    );
    return r;
  }

  // One tool call: announces it, waits for approval when the tool asks for it, runs it and reports the result. The
  // returned text is what the model reads; failures and refusals come back as text, never as exceptions.
  private async exec(
    c: PendingCall,
    chatId: number,
    enabled: string[],
    send: (e: Json) => void,
    cancel: Cancel,
    steps: Json[],
  ): Promise<string> {
    const id = `t${++this.seq}`;
    const info = find(c.name);
    let args: Json = {};
    let bad = '';
    try {
      args = obj(JSON.parse(c.args || '{}'));
    } catch {
      bad = 'the arguments are not valid JSON';
    }
    const summary = info ? summarize(c.name, args) : c.name;
    send({ type: 'tool', id, name: c.name, summary, say: info ? info.say : '', ask: info ? info.ask : false });
    const finish = (ok: boolean, output: string, denied = false): string => {
      send({ type: 'tool_done', id, ok, denied, output: output.slice(0, UI_OUTPUT) });
      steps.push({ name: c.name, summary, ok, denied, output: output.slice(0, UI_OUTPUT) });
      return output;
    };
    if (!info || !enabled.includes(info.group)) return finish(false, `unknown tool ${c.name}`);
    if (bad) return finish(false, bad);
    if (info.ask) {
      send({ type: 'approval', id, name: c.name, summary });
      if ((await this.approvals.wait(id, cancel)) !== 'allow') return finish(false, 'The user denied this action.', true);
    }
    try {
      return finish(true, await runTool(c.name, args, this.deps.tools, this.deps.store, chatId, cancel));
    } catch (e) {
      return finish(false, `Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // The page images for this turn: pages the user typed for a document are sent as given; for the others, pages
  // matching the question join the pages already chosen for this chat (see selectPages).
  private async pages(
    chatId: number,
    pdfs: DocMeta[],
    query: string,
    ranges: Record<string, string>,
    tokens: number,
    note: (text: string) => void,
  ): Promise<PageGroup[]> {
    let room = Math.max(1, Math.floor(tokens / Math.max(...pdfs.map(pageTokens))));
    const fixed: PageRef[] = [];
    const auto: DocMeta[] = [];
    for (const d of pdfs) {
      const spec = (ranges[String(d.id)] ?? '').trim();
      if (spec) for (const n of parseRange(spec, d.pages ?? 0)) fixed.push({ docId: d.id, page: n });
      else auto.push(d);
    }
    const kept = fixed.slice(0, room);
    if (fixed.length > kept.length) note(`context limit: ${fixed.length - kept.length} selected PDF page(s) left out`);
    room -= kept.length;

    const isAuto = (r: PageRef): boolean => auto.some(d => d.id === r.docId && r.page <= (d.pages ?? 0));
    const ranked = this.deps.store.searchPages(chatId, query, 32).filter(isAuto);
    const fallback: PageRef[] = [];
    for (const d of auto) for (let n = 1; n <= (d.pages ?? 0) && fallback.length < room; n++) fallback.push({ docId: d.id, page: n });
    const chosen = selectPages(ranked, (this.chosen.get(chatId) ?? []).filter(isAuto), fallback, room);
    this.chosen.set(chatId, chosen);

    const all = [...kept, ...chosen];
    const groups: PageGroup[] = [];
    for (const d of pdfs) {
      const nums = all
        .filter(r => r.docId === d.id)
        .map(r => r.page)
        .sort((a: number, b: number) => a - b);
      const pages: { page: number; url: string }[] = [];
      for (const n of nums) {
        const jpg = await this.deps.pages.page(d.id, n);
        if (jpg) pages.push({ page: n, url: `data:image/jpeg;base64,${Buffer.from(jpg).toString('base64')}` });
      }
      if (pages.length) groups.push({ name: d.name, pages });
    }
    return groups;
  }
}

// Speech runs at about 3 words a second, so 6 tokens per second of 16 kHz mono audio is a generous ceiling. Without it a
// clip of noise can be "transcribed" into a long made-up passage, which is slow and derails the chat.
const asrTokens = (wavBase64: string): number => {
  const seconds = Math.max(0, (wavBase64.length * 0.75 - 44) / 32000);
  return Math.min(400, Math.max(32, Math.ceil(seconds * 6) + 24));
};

// Speech to text with the loaded model, on its own slot when the engine has more than one.
export async function transcribe(port: number, slots: number, wavBase64: string, cancel: Cancel): Promise<string> {
  const r = await callLlama(
    port,
    'POST',
    '/v1/chat/completions',
    {
      messages: [
        { role: 'system', content: 'Perform ASR.' },
        { role: 'user', content: [{ type: 'input_audio', input_audio: { data: wavBase64, format: 'wav' } }] },
      ],
      temperature: 0,
      max_tokens: asrTokens(wavBase64),
      id_slot: slots > 1 ? ASR_SLOT : CHAT_SLOT,
    },
    null,
    cancel,
  );
  const text = obj(obj(arr(r.choices)[0]).message).content;
  return typeof text === 'string' ? text.trim() : '';
}
