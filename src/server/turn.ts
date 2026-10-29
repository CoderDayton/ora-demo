// One chat turn, run by the server: stores the question, builds the prompt (documents, PDF pages, history), streams
// the reply from llama-server back as events and stores it. Voice is transcribed beforehand with transcribe().
import { buildContext } from './context.ts';
import type { Json } from './llama.ts';
import { arr, Cancel, callLlama, obj } from './llama.ts';
import type { PageRenderer } from './pages.ts';
import type { Cost, Msg, PageGroup, PageRef, Part, Window } from './prompt.ts';
import { assemble, calibrate, estTokens, fitHistory, selectPages } from './prompt.ts';
import type { DocMeta, Message, Store } from './store.ts';

export { Cancel };

export interface TurnDeps {
  store: Store;
  pages: PageRenderer;
  llamaPort: number;
  slots: () => number;
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
}

const CHARS_PER_TOKEN = 3.6;
// Measured on LFM3-Omni: a 792x1024 page added about 780 prompt tokens. Cost grows with the page's area.
const IMG_TOKENS = 800;
const SHARE_TEXT = 0.4;
const SHARE_PAGES = 0.5;
// Replies always run on slot 0 and speech recognition on slot 1, so neither evicts the other's cached prompt.
const CHAT_SLOT = 0;
const ASR_SLOT = 1;

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

      const body: Json = {
        messages: assemble({ system: t.system, docs: docsText, pages: groups, history: fit.msgs, excerpts }),
        stream: true,
        stream_options: { include_usage: true },
        cache_prompt: true,
        id_slot: CHAT_SLOT,
        temperature: t.temperature,
        max_tokens: t.maxTokens,
      };
      await callLlama(
        this.deps.llamaPort,
        'POST',
        '/v1/chat/completions',
        body,
        (e: Json) => {
          const delta = obj(obj(arr(e.choices)[0]).delta);
          const content = typeof delta.content === 'string' ? delta.content : '';
          const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
          const tool = arr(delta.tool_calls).length > 0;
          if (content || reasoning || tool) {
            text += content;
            send({ type: 'delta', content, reasoning, tool });
          }
          if (e.usage !== undefined) usage = obj(e.usage);
          if (e.timings !== undefined) timings = obj(e.timings);
        },
        cancel,
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const am = text ? store.addMessage(chatId, 'assistant', text) : null;
    const prompt = Number(usage?.prompt_tokens ?? 0);
    if (prompt > 0) this.scale = calibrate(this.scale, estSent, Math.max(0, prompt - fixedPages));
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
      max_tokens: 400,
      id_slot: slots > 1 ? ASR_SLOT : CHAT_SLOT,
    },
    null,
    cancel,
  );
  const text = obj(obj(arr(r.choices)[0]).message).content;
  return typeof text === 'string' ? text.trim() : '';
}
