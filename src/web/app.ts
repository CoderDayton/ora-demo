import { adoptChat, newChat, pageRanges, refreshChats, renderDocs, restoreLastChat, uploadDocs } from './chats.ts';
import type { Block, Inline, ListItem } from './markdown.ts';
import { MarkdownStream } from './markdown.ts';
import { Orb } from './orb.ts';
import type { ChatInfo, Part, Props, Usage } from './state.ts';
import { $, api, fmt, hooks, L, S, store } from './state.ts';
import { Vad } from './vad.ts';

interface ModelRow {
  path: string;
  name: string;
  sizeMB: number;
  mmproj: string[];
}
interface EngineStatus {
  state: string;
  model: string | null;
  exit: string | null;
  logs: string[];
  args?: string[];
}
interface Timings {
  predicted_per_second?: number;
  prompt_per_second?: number;
  cache_n?: number;
  prompt_n?: number;
}
// What /api/turn streams: the chat, the stored question, notes, reply deltas and a final summary.
interface TurnEvent {
  type: string;
  chat?: ChatInfo;
  text?: string;
  content?: string;
  reasoning?: string;
  tool?: boolean;
  usage?: Usage | null;
  timings?: Timings | null;
  cache?: number | null;
  error?: string;
}

/* ---------- metrics panel ---------- */
const MROWS: [string, string][] = [
  ['gen', 'generation t/s'],
  ['pp', 'prompt t/s'],
  ['ttft', 'first token ms'],
  ['ctx', 'context'],
  ['kv', 'peak kv fill'],
  ['act', 'active requests'],
  ['cache', 'prompt cache'],
  ['tin', 'tokens in'],
  ['tout', 'tokens out'],
  ['tts', 'tts ms'],
  ['gfx', 'renderer'],
];
$('#mgrid').innerHTML = MROWS.map(([k, n]) => `<span class="k">${n}</span><span class="v" id="m-${k}">-</span>`).join('');
function setM(k: string, v: string | number): void {
  S.m[k] = String(v);
  const el = document.getElementById(`m-${k}`);
  if (el) el.textContent = String(v);
}

async function pollMetrics(): Promise<void> {
  if (S.engine !== 'ready') return;
  try {
    const t = await (await fetch(`${L}/metrics`)).text();
    const get = (n: string): number | null => {
      const m = t.match(new RegExp(`^llamacpp:${n} ([0-9.eE+-]+)`, 'm'));
      return m ? Number(m[1]) : null;
    };
    const peak = get('n_tokens_max');
    const act = get('requests_processing');
    if (peak != null && S.nctx) {
      const kv = Math.min(1, peak / S.nctx);
      Orb.state.kv = kv;
      setM('kv', `${fmt(kv * 100, 1)}%`);
    }
    if (act != null) setM('act', fmt(act));
    if (!S.busy) {
      const pp = get('prompt_tokens_seconds'),
        gen = get('predicted_tokens_seconds');
      if (pp) setM('pp', fmt(pp));
      if (gen) setM('gen', fmt(gen));
    }
  } catch {
    /* engine busy or restarting */
  }
}
setInterval(() => {
  void pollMetrics();
}, 800);

function showCtx(): void {
  const used = S.usage?.total_tokens ?? 0;
  Orb.state.ctx = S.nctx ? Math.min(1, used / S.nctx) : 0;
  setM('ctx', S.nctx ? `${used} / ${S.nctx}` : '-');
  setM('tin', S.totals.in);
  setM('tout', S.totals.out);
}

/* ---------- engine control ---------- */
const E = { models: [] as ModelRow[], last: '', synced: '' };

// File names come from disk, so options are built as DOM nodes and never parsed as HTML.
function setOptions(sel: HTMLSelectElement, rows: { value: string; label: string }[]): void {
  sel.replaceChildren(
    ...rows.map(r => {
      const o = document.createElement('option');
      o.value = r.value;
      o.textContent = r.label;
      return o;
    }),
  );
}

function fillMmproj(): void {
  const m = E.models.find(x => x.path === $<HTMLSelectElement>('#model').value);
  const sel = $<HTMLSelectElement>('#mmproj');
  setOptions(
    sel,
    [{ value: '', label: 'no projector (text only)' }].concat((m?.mmproj ?? []).map(p => ({ value: p, label: p.split('/').pop() ?? p }))),
  );
  // prefer the projector whose name shares the model family
  const fam = (m?.name ?? '').split('/').pop()?.split('-').slice(0, 3).join('-').toLowerCase() ?? '';
  const hit = (m?.mmproj ?? []).find(p => p.toLowerCase().includes(fam));
  if (hit) sel.value = hit;
  else if (m?.mmproj?.length) sel.value = m.mmproj[0] as string;
}

async function loadModels(): Promise<void> {
  E.models = await api<ModelRow[]>('/api/models');
  const sel = $<HTMLSelectElement>('#model');
  setOptions(
    sel,
    E.models.map(m => ({ value: m.path, label: `${m.name} (${(m.sizeMB / 1000).toFixed(1)} GB)` })),
  );
  const saved = store.get('ora.model', '');
  sel.value = E.models.some(m => m.path === saved) ? saved : (E.models[0]?.path ?? '');
  fillMmproj();
}
$<HTMLSelectElement>('#model').onchange = () => {
  store.set('ora.model', $<HTMLSelectElement>('#model').value);
  fillMmproj();
};

// After a page reload the dropdowns show what is actually running, not the last saved choice.
function syncSelection(st: EngineStatus): void {
  if (!st.model || (st.state !== 'ready' && st.state !== 'starting') || E.synced === st.model) return;
  const m = E.models.find(x => x.name === st.model);
  if (!m) return;
  E.synced = st.model;
  $<HTMLSelectElement>('#model').value = m.path;
  store.set('ora.model', m.path);
  fillMmproj();
  const i = st.args?.indexOf('--mmproj') ?? -1;
  const proj = i >= 0 ? (st.args?.[i + 1] ?? '') : '';
  const sel = $<HTMLSelectElement>('#mmproj');
  if ([...sel.options].some(o => o.value === proj)) sel.value = proj;
}

function applyEngine(st: EngineStatus): void {
  syncSelection(st);
  S.engine = st.state;
  $('#dot').className = st.state;
  $('#stext').textContent = st.state === 'ready' ? `ready - ${st.model}` : st.state === 'error' ? `error (${st.exit ?? '?'})` : st.state;
  const run = st.state === 'ready' || st.state === 'starting' || st.state === 'stopping';
  $<HTMLButtonElement>('#start').disabled = st.state === 'starting' || st.state === 'stopping';
  $('#start').textContent = run ? 'Restart' : 'Start';
  $<HTMLButtonElement>('#stop').disabled = !run;
  for (const id of ['#input', '#send', '#mic', '#attach', '#docbtn']) {
    $<HTMLButtonElement>(id).disabled = st.state !== 'ready' || (id === '#attach' && !S.props?.modalities?.vision);
  }
  $('#logs').textContent = st.logs.join('\n');
  if (!S.busy && !S.handsfree)
    Orb.setMode(st.state === 'ready' ? 'idle' : st.state === 'starting' ? 'boot' : st.state === 'error' ? 'error' : 'off');
  if (st.state !== E.last && (st.state === 'stopped' || st.state === 'error')) $<HTMLDetailsElement>('#engine').open = true;
  if (st.state === 'ready' && E.last !== 'ready') void loadProps();
  if (st.state !== 'ready') {
    S.props = null;
    Orb.state.kv = 0;
  }
  E.last = st.state;
}

async function loadProps(): Promise<void> {
  try {
    const p = (await (await fetch(`${L}/props`)).json()) as Props;
    S.props = p;
    S.nctx = p.default_generation_settings?.n_ctx ?? 0;
    for (const b of document.querySelectorAll<HTMLElement>('.badge'))
      b.classList.toggle('on', !!p.modalities?.[b.dataset.m as 'vision' | 'audio' | 'video']);
    const vis = !!p.modalities?.vision;
    $<HTMLButtonElement>('#attach').disabled = !vis;
    $('#attach').title = vis ? 'attach image' : 'this model has no vision encoder';
    showCtx();
    renderDocs();
  } catch {
    /* retried on next state change */
  }
}

async function pollEngine(): Promise<void> {
  try {
    applyEngine(await api<EngineStatus>('/api/status'));
  } catch {
    $('#stext').textContent = 'controller offline';
  }
}
setInterval(() => {
  void pollEngine();
}, 1200);

$('#start').onclick = async () => {
  try {
    await api('/api/start', {
      model: $<HTMLSelectElement>('#model').value,
      mmproj: $<HTMLSelectElement>('#mmproj').value,
      ctx: $<HTMLSelectElement>('#ctx').value,
      reasoning: $<HTMLInputElement>('#think').checked ? 'auto' : 'off',
      parallel: 2,
    });
    store.set('ora.model', $<HTMLSelectElement>('#model').value);
    void pollEngine();
  } catch (e) {
    note(`start failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
};
$('#stop').onclick = async () => {
  ttsStop();
  S.abort?.abort();
  await api('/api/stop', {});
  void pollEngine();
};
$('#logbtn').onclick = () => $('#logs').classList.toggle('show');

/* ---------- transcript ---------- */
const logEl = $('#log');
const scrollEnd = (): void => {
  logEl.scrollTop = logEl.scrollHeight;
};
// Replies are shown as Markdown. The parser returns data and elements are built with textContent, so model
// output can never inject markup.
const inlineNodes = (parts: Inline[]): Node[] =>
  parts.map(p => {
    if (p.t === 'text') return document.createTextNode(p.v);
    const e = document.createElement(p.t === 'code' ? 'code' : p.t === 'strong' ? 'strong' : 'em');
    e.textContent = p.v;
    return e;
  });
function itemEl(it: ListItem): HTMLElement {
  const li = document.createElement('li');
  li.append(...inlineNodes(it.c));
  if (it.sub) li.append(...it.sub.map(blockEl));
  return li;
}
function blockEl(b: Block): HTMLElement {
  if (b.t === 'code') {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = b.v;
    pre.appendChild(code);
    return pre;
  }
  if (b.t === 'ul' || b.t === 'ol') {
    const list = document.createElement(b.t);
    for (const it of b.items) list.appendChild(itemEl(it));
    if (b.t === 'ol' && b.start !== 1) (list as HTMLOListElement).start = b.start;
    return list;
  }
  const e = document.createElement(b.t === 'h' ? `h${b.n}` : b.t === 'quote' ? 'blockquote' : 'p');
  e.append(...inlineNodes(b.c));
  return e;
}
// Each message keeps its own stream parser, so a growing reply rebuilds only the blocks that can still change and
// the finished ones keep their nodes (and any text selection in them).
const streams = new WeakMap<HTMLElement, MarkdownStream>();
const rendered = new WeakMap<HTMLElement, number>();
function mdInto(el: HTMLElement, text: string): void {
  el.classList.add('md');
  let stream = streams.get(el);
  if (!stream) {
    stream = new MarkdownStream();
    streams.set(el, stream);
  }
  const { blocks, changedFrom } = stream.update(text);
  const keep = el.childNodes.length === (rendered.get(el) ?? 0) ? Math.min(changedFrom, el.childNodes.length) : 0;
  if (!keep) el.replaceChildren();
  rendered.set(el, blocks.length);
  while (el.childNodes.length > keep) (el.lastChild as ChildNode).remove();
  el.append(...blocks.slice(keep).map(blockEl));
}
// While a reply streams it is re-rendered at most every 120 ms, and the view follows it only if the reader is at the bottom.
let mdTimer = 0;
const nearBottom = (): boolean => logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
function mdSoon(el: HTMLElement, getText: () => string): void {
  if (mdTimer) return;
  mdTimer = window.setTimeout(() => {
    mdTimer = 0;
    const follow = nearBottom();
    mdInto(el, getText());
    if (follow) scrollEnd();
  }, 120);
}

function addMsg(role: string, text: string, cls = ''): HTMLElement {
  const d = document.createElement('div');
  d.className = `msg ${role} ${cls}`.trim();
  if (role === 'assistant' && text) mdInto(d, text);
  else d.textContent = text;
  logEl.appendChild(d);
  scrollEnd();
  return d;
}
function note(text: string, isErr = false): void {
  addMsg('note', text, isErr ? 'err' : '');
  if (isErr) Orb.error();
}
function renderLog(): void {
  document.body.classList.toggle('chatting', S.hist.length > 0);
  logEl.innerHTML = '';
  for (const m of S.hist) {
    const d = addMsg(m.role, typeof m.content === 'string' ? m.content : '');
    if (typeof m.content === 'string') continue;
    for (const p of m.content) {
      if (p.type === 'image_url') {
        const im = new Image();
        im.src = p.image_url.url;
        d.prepend(im);
      } else if (p.type === 'input_audio') d.appendChild(document.createTextNode('(voice message) '));
      else {
        d.appendChild(document.createTextNode(p.text));
        if (p.voice) d.classList.add('voice');
      }
    }
  }
}
const statusline = (t: string): void => {
  $('#statusline').textContent = t;
};

let transcribing = false;

/* ---------- audio out (tts) ---------- */
let _ac: AudioContext | null = null;
let _outAn: AnalyserNode | null = null;
function ac(): AudioContext {
  if (!_ac) _ac = new AudioContext();
  if (_ac.state === 'suspended') void _ac.resume();
  return _ac;
}
function outAnalyser(): AnalyserNode {
  if (!_outAn) {
    _outAn = ac().createAnalyser();
    _outAn.fftSize = 1024;
    _outAn.connect(ac().destination);
  }
  return _outAn;
}
// `end` is where a sentence ends in the raw reply text; `off` counts the raw text handed to the voice so far.
const T = {
  q: [] as { p: Promise<AudioBuffer | null>; id: number; end: number }[],
  playing: false,
  buf: '',
  off: 0,
  id: 0,
  src: null as AudioBufferSourceNode | null,
};
// With speech on, the reply shows only what the voice has reached: `cap` is that point in the reply text.
const R = { el: null as HTMLElement | null, text: (): string => '', cap: Infinity, raf: 0 };
function paint(): void {
  if (!R.el) return;
  const follow = nearBottom();
  mdInto(R.el, R.text().slice(0, R.cap));
  if (follow) scrollEnd();
}
function reveal(to: number): void {
  cancelAnimationFrame(R.raf);
  R.cap = to;
  paint();
}
// Uncovers the text from..to evenly over the sentence's audio, a whole word at a time.
function glide(from: number, to: number, secs: number): void {
  const t0 = performance.now();
  cancelAnimationFrame(R.raf);
  const step = (): void => {
    const f = Math.min(1, (performance.now() - t0) / 1000 / Math.max(secs, 0.05));
    let at = Math.floor(from + (to - from) * f);
    if (f < 1) {
      const sp = R.text().indexOf(' ', at);
      at = sp < 0 || sp > to ? to : sp;
    }
    if (at !== R.cap) {
      R.cap = at;
      paint();
    }
    if (f < 1) R.raf = requestAnimationFrame(step);
  };
  step();
}
const SENT = /[.!?]+["')\]]*\s|\n/;
const speechClean = (s: string): string =>
  s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#`>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function ttsFeed(d: string, final = false): void {
  if (!S.set.speak) return;
  T.buf += d;
  for (;;) {
    const m = T.buf.match(SENT);
    if (!m && !(final && T.buf.trim())) break;
    let end = m ? (m.index as number) + m[0].length : T.buf.length;
    if (m && end < 24 && !final) {
      const m2 = T.buf.slice(end).match(SENT);
      if (!m2) break;
      end += (m2.index as number) + m2[0].length;
    }
    const chunk = speechClean(T.buf.slice(0, end));
    T.buf = T.buf.slice(end);
    T.off += end;
    if (/[\p{L}\p{N}]/u.test(chunk)) ttsEnqueue(chunk, T.off);
    if (!T.buf) break;
  }
}
function ttsEnqueue(text: string, end: number): void {
  const id = T.id,
    t0 = performance.now();
  const p = fetch(`${L}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: text, voice: S.set.voice }),
  })
    .then(async r => {
      if (!r.ok) throw new Error(`tts ${r.status}`);
      const buf = await ac().decodeAudioData(await r.arrayBuffer());
      setM('tts', fmt(performance.now() - t0));
      return buf;
    })
    .catch((e: unknown) => {
      console.warn(e);
      return null;
    });
  T.q.push({ p, id, end });
  Orb.ripple(0.4, 38);
  if (!T.playing) void ttsPlay();
}
async function ttsPlay(): Promise<void> {
  T.playing = true;
  while (T.q.length) {
    const it = T.q.shift() as (typeof T.q)[number];
    const buf = await it.p;
    if (it.id !== T.id) continue;
    if (!buf) {
      reveal(it.end);
      continue;
    }
    Orb.setMode('speaking');
    await new Promise<void>(res => {
      const s = ac().createBufferSource();
      s.buffer = buf;
      s.connect(outAnalyser());
      T.src = s;
      s.onended = () => res();
      s.start();
      glide(R.cap, it.end, buf.duration);
    });
    T.src = null;
    if (it.id === T.id) reveal(it.end);
  }
  T.playing = false;
  if (!S.busy) {
    reveal(Infinity);
    afterTurn();
  }
}
function ttsStop(): void {
  T.id++;
  T.q = [];
  T.buf = '';
  T.off = 0;
  reveal(Infinity);
  try {
    T.src?.stop();
  } catch {
    /* already stopped */
  }
  T.src = null;
}

/* ---------- chat ---------- */
// A voice turn is stored as its transcript (flagged so the UI can show it was spoken), never as audio:
// the words are what later turns, reloads and document search need, and audio would swamp the context.
function userContent(text: string, imgs: string[], voice = false): string | Part[] {
  if (!imgs.length && !voice) return text;
  const parts: Part[] = imgs.map(u => ({ type: 'image_url', image_url: { url: u } }));
  parts.push(voice ? { type: 'text', text, voice: true } : { type: 'text', text });
  return parts;
}

// A transcription in flight. The server runs it on its own slot, so it does not evict the chat's cached prompt.
interface Asr {
  p: Promise<string>;
  ctl: AbortController;
}
function asr(wav: string): Asr {
  const ctl = new AbortController();
  const p = fetch('/api/asr', {
    method: 'POST',
    signal: ctl.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio: wav }),
  }).then(async r => {
    const j = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!r.ok) throw new Error(`transcription failed: ${j.error ?? r.status}`);
    return (j.text ?? '').trim();
  });
  // A speculative transcription may be dropped unread; its failure is reported only if it is awaited.
  p.catch(() => undefined);
  return { p, ctl };
}
const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Hands each server-sent event in the response to `on`.
async function readEvents(res: Response, on: (e: TurnEvent) => void): Promise<void> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (line.startsWith('data:')) on(JSON.parse(line.slice(5)) as TurnEvent);
    }
  }
}

// The persona's memory lives on the server so it survives browser data clears.
let personaTimer = 0;
function savePersona(): void {
  clearTimeout(personaTimer);
  personaTimer = window.setTimeout(() => {
    void fetch('/api/persona', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Orb.memory()),
    }).catch(() => undefined);
  }, 800);
}
async function loadPersona(): Promise<void> {
  try {
    const r = await fetch('/api/persona');
    if (r.ok) Orb.restore((await r.json()) as Partial<ReturnType<typeof Orb.memory>>);
  } catch {
    /* starts blank */
  }
}
void loadPersona();

// Resolves when the running turn has finished; switching chats waits for it. The server stores both sides of a
// turn, including a reply cut off by switching away, in the chat it belongs to.
let inflight: Promise<void> = Promise.resolve();
async function send(text: string, opts: { audio?: Asr } = {}): Promise<void> {
  text = text.trim();
  if ((!text && !S.pending.length && !opts.audio) || S.busy || S.engine !== 'ready') {
    opts.audio?.ctl.abort();
    return;
  }
  let finish = (): void => undefined;
  inflight = new Promise<void>(r => {
    finish = r;
  });
  try {
    await turn(text, opts);
  } finally {
    finish();
  }
}

async function heard(a: Asr): Promise<string> {
  S.busy = true;
  transcribing = true;
  Orb.event({ type: 'user_voice' });
  Orb.setMode('prefill');
  statusline('transcribing...');
  const pending = addMsg('user', 'transcribing...', 'voice pending');
  S.abort = a.ctl;
  let text = '';
  try {
    text = await a.p;
  } catch (e) {
    if (!isAbort(e)) note(errText(e), true);
  }
  S.abort = null;
  pending.remove();
  transcribing = false;
  S.busy = false;
  return text;
}

async function turn(text: string, opts: { audio?: Asr }): Promise<void> {
  ttsStop();
  const voice = !!opts.audio;
  if (opts.audio) {
    text = await heard(opts.audio);
    if (!text) {
      afterTurn();
      return;
    }
  }
  const imgs = S.pending;
  S.pending = [];
  renderPending();
  S.hist.push({ role: 'user', content: userContent(text || 'Describe this image.', imgs, voice) });
  renderLog();
  Orb.state.typing = false;
  if (imgs.length) Orb.event({ type: 'user_image' });

  S.usage = null;
  const bubble = addMsg('assistant', '');
  const ctl = new AbortController();
  S.abort = ctl;
  S.busy = true;
  $('#send').classList.add('stop');
  Orb.setMode('prefill');
  statusline('reading...');
  const t0 = performance.now();
  let tFirst = 0,
    n = 0,
    acc = '',
    failed = '';
  let timings: Timings | null = null;
  R.el = bubble;
  R.text = () => acc;
  R.cap = S.set.speak ? 0 : Infinity;
  const onDelta = (e: TurnEvent): void => {
    const now = performance.now();
    if ((e.content || e.reasoning) && !tFirst) {
      tFirst = now;
      setM('ttft', fmt(now - t0));
      Orb.setMode('gen');
    }
    if (e.tool) {
      Orb.state.tool = true;
      statusline('calling a tool...');
    }
    if (e.reasoning) {
      n++;
      Orb.state.thinking = true;
      Orb.pulse(0.12);
      statusline('thinking...');
    }
    if (e.content) {
      Orb.state.thinking = false;
      acc += e.content;
      n++;
      mdSoon(bubble, () => acc.slice(0, R.cap));
      Orb.pulse(0.3);
      ttsFeed(e.content);
    }
    if (tFirst) {
      const rate = n / ((now - tFirst) / 1000 + 0.05);
      Orb.state.rate = rate;
      setM('gen', fmt(rate));
      if (e.content) statusline(`${n} tok - ${fmt(rate)} t/s`);
    }
  };
  const onEvent = (e: TurnEvent): void => {
    if (e.type === 'delta') onDelta(e);
    else if (e.type === 'chat' && e.chat) {
      adoptChat(e.chat.id);
      void refreshChats();
    } else if (e.type === 'note') note(e.text ?? '');
    else if (e.type === 'done') {
      S.usage = e.usage ?? null;
      timings = e.timings ?? null;
      // Share of the prompt llama-server reused from its cache instead of reading it again.
      if (e.cache != null) setM('cache', `${fmt(e.cache * 100)}%`);
      failed = e.error ?? '';
    }
  };
  try {
    const res = await fetch('/api/turn', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId: S.chatId,
        text,
        voice,
        images: imgs,
        system: S.set.sys,
        temperature: S.set.temp,
        maxTokens: S.set.maxtok,
        ranges: pageRanges(),
      }),
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
    await readEvents(res, onEvent);
    if (failed) throw new Error(failed);
  } catch (e) {
    if (!isAbort(e)) {
      const msg = `error: ${errText(e)}`;
      if (acc) note(msg, true);
      else {
        bubble.classList.add('err');
        bubble.textContent = msg;
        Orb.error();
      }
    }
  } finally {
    if (acc) {
      clearTimeout(mdTimer);
      mdTimer = 0;
      paint();
      S.hist.push({ role: 'assistant', content: acc });
    } else if (!bubble.classList.contains('err')) bubble.remove();
    const usage = S.usage as Usage | null;
    if (usage) {
      S.totals.in += usage.prompt_tokens ?? 0;
      S.totals.out += usage.completion_tokens ?? 0;
    }
    const tm = timings as Timings | null;
    if (tm) {
      setM('gen', fmt(tm.predicted_per_second));
      setM('pp', fmt(tm.prompt_per_second));
    }
    Orb.state.thinking = false;
    Orb.state.tool = false;
    if (acc && tFirst) {
      const tps = tm?.predicted_per_second ?? n / ((performance.now() - tFirst) / 1000 + 0.05);
      Orb.event({ type: 'reply_done', tps, ttft: tFirst - t0, tokens: n });
    }
    savePersona();
    showCtx();
    ttsFeed('', true);
    S.busy = false;
    S.abort = null;
    Orb.state.rate = 0;
    $('#send').classList.remove('stop');
    statusline('');
    void refreshChats().catch(() => undefined);
    if (!T.playing && !T.q.length) {
      reveal(Infinity);
      afterTurn();
    }
  }
}
/* ---------- voice in: mic, VAD, wav ---------- */
function down(f: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return f;
  const r = from / to,
    n = Math.floor(f.length / r),
    out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * r),
      b = Math.min(f.length, Math.floor((i + 1) * r));
    let s = 0;
    for (let j = a; j < b; j++) s += f[j] as number;
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}
function wavB64(f: Float32Array, rate: number): string {
  const n = f.length,
    buf = new ArrayBuffer(44 + n * 2),
    v = new DataView(buf);
  const w = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, f[i] as number));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const u8 = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
  return btoa(bin);
}

// Transcription starts at a short pause (SPEC_MS) and is dropped if speech resumes, so by the time the full pause
// has passed the words are usually ready.
const SPEC_MS = 300;
const vad = new Vad({ silenceMs: S.set.pause, pauseMs: SPEC_MS });
const M = {
  stream: null as MediaStream | null,
  src: null as MediaStreamAudioSourceNode | null,
  tap: null as AudioNode | null,
  buf: [] as Float32Array[],
  pre: [] as Float32Array[],
  spec: null as Asr | null,
};
function afterTurn(): void {
  Orb.setMode(S.handsfree ? 'listening' : S.engine === 'ready' ? 'idle' : 'off');
  statusline(S.handsfree ? 'listening...' : '');
}
// Speaking while the orb is thinking or talking stops it and takes the new utterance.
function interrupt(): void {
  S.abort?.abort();
  ttsStop();
}
function dropSpec(): void {
  M.spec?.ctl.abort();
  M.spec = null;
}
function onFrame(x: Float32Array): void {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] as number) * (x[i] as number);
  const rms = Math.sqrt(s / x.length);
  Orb.state.mic = rms;
  if (S.engine !== 'ready' || transcribing) {
    vad.reset();
    dropSpec();
    M.buf = [];
    M.pre = [];
    return;
  }
  if (!vad.recording) {
    M.pre.push(x);
    if (M.pre.length > 8) M.pre.shift();
  }
  const ev = vad.push(rms, performance.now(), T.playing || S.busy);
  if (ev === 'start' || ev === 'barge') {
    if (S.busy || T.playing) interrupt();
    dropSpec();
    M.buf = [...M.pre];
    Orb.setMode('listening');
    statusline('hearing you...');
  } else if (vad.recording) M.buf.push(x);
  if (ev === 'pause') {
    const wav = utterance();
    M.spec = wav ? asr(wav) : null;
  } else if (ev === 'resume') dropSpec();
  else if (ev === 'end') finishUtterance();
}
// The recording so far as 16 kHz wav, or '' when it is too short to be speech.
function utterance(): string {
  const len = M.buf.reduce((a, c) => a + c.length, 0),
    rate = ac().sampleRate;
  if (len / rate < 0.5) return '';
  const all = new Float32Array(len);
  let o = 0;
  for (const c of M.buf) {
    all.set(c, o);
    o += c.length;
  }
  return wavB64(down(all, rate, 16000), 16000);
}
// The audio is transcribed first, so the words are shown and kept; see send().
function finishUtterance(): void {
  const wav = M.spec ? '' : utterance();
  const a = M.spec ?? (wav ? asr(wav) : null);
  M.spec = null;
  M.buf = [];
  M.pre = [];
  if (a) void send('', { audio: a });
  else afterTurn();
}

// Microphone samples are collected off the main thread and posted in frames of this size, which the VAD was tuned for.
const FRAME = 2048;
const TAP = `const N = ${FRAME};
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.b = new Float32Array(N); this.n = 0; }
  process(inputs) {
    const c = inputs[0] && inputs[0][0];
    if (c) for (let i = 0; i < c.length; i++) {
      this.b[this.n++] = c[i];
      if (this.n === N) { this.port.postMessage(this.b, [this.b.buffer]); this.b = new Float32Array(N); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('ora-tap', Tap);`;
let tapLoaded = false;
async function micTap(c: AudioContext): Promise<AudioNode> {
  if (!c.audioWorklet) {
    const proc = c.createScriptProcessor(FRAME, 1, 1);
    proc.onaudioprocess = e => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
    return proc;
  }
  if (!tapLoaded) {
    const url = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }));
    try {
      await c.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    tapLoaded = true;
  }
  const node = new AudioWorkletNode(c, 'ora-tap');
  node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);
  return node;
}
async function micOn(): Promise<void> {
  if (!S.props?.modalities?.audio) {
    note('this model has no audio input', true);
    return;
  }
  try {
    const c = ac();
    M.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    M.src = c.createMediaStreamSource(M.stream);
    M.tap = await micTap(c);
    M.src.connect(M.tap);
    // Connected so the browser keeps pulling audio through it; it outputs silence.
    M.tap.connect(c.destination);
    S.handsfree = true;
    $('#mic').classList.add('live');
    if (!S.busy && !T.playing) afterTurn();
  } catch (e) {
    note(`mic unavailable: ${errText(e)}`, true);
  }
}
function micOff(): void {
  M.tap?.disconnect();
  M.src?.disconnect();
  if (M.tap instanceof AudioWorkletNode) M.tap.port.onmessage = null;
  M.stream?.getTracks().forEach(t => {
    t.stop();
  });
  dropSpec();
  M.tap = null;
  M.src = null;
  M.stream = null;
  M.buf = [];
  M.pre = [];
  vad.reset();
  S.handsfree = false;
  $('#mic').classList.remove('live');
  Orb.state.mic = 0;
  if (!S.busy && !T.playing) afterTurn();
}
$('#mic').onclick = () => {
  if (S.handsfree) micOff();
  else void micOn();
};

const lvBuf = new Uint8Array(1024);
(function outLevel(): void {
  const an = _outAn as AnalyserNode | null;
  if (an && T.playing) {
    an.getByteTimeDomainData(lvBuf);
    let s = 0;
    for (const v of lvBuf) {
      const d = (v - 128) / 128;
      s += d * d;
    }
    Orb.state.out = Math.sqrt(s / lvBuf.length);
  } else Orb.state.out = 0;
  requestAnimationFrame(outLevel);
})();

/* ---------- images ---------- */
function renderPending(): void {
  const el = $('#attached');
  el.classList.toggle('show', S.pending.length > 0);
  el.innerHTML = '';
  S.pending.forEach((u, i) => {
    const d = document.createElement('div');
    d.className = 'th';
    const im = new Image();
    im.src = u;
    const b = document.createElement('button');
    b.textContent = 'x';
    b.onclick = () => {
      S.pending.splice(i, 1);
      renderPending();
    };
    d.append(im, b);
    el.appendChild(d);
  });
}
async function addImage(file: File): Promise<void> {
  if (!S.props?.modalities?.vision) {
    note('this model has no vision encoder', true);
    return;
  }
  try {
    const bmp = await createImageBitmap(file);
    const sc = Math.min(1, 896 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * sc);
    c.height = Math.round(bmp.height * sc);
    (c.getContext('2d') as CanvasRenderingContext2D).drawImage(bmp, 0, 0, c.width, c.height);
    S.pending.push(c.toDataURL('image/jpeg', 0.85));
    renderPending();
  } catch (e) {
    note(`image failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}
$('#attach').onclick = () => $('#file').click();
$<HTMLInputElement>('#file').onchange = async e => {
  const input = e.target as HTMLInputElement;
  for (const f of Array.from(input.files ?? [])) await addImage(f);
  input.value = '';
};
$('#docbtn').onclick = () => $('#docfile').click();
$<HTMLInputElement>('#docfile').onchange = async e => {
  const input = e.target as HTMLInputElement;
  await uploadDocs(Array.from(input.files ?? []));
  input.value = '';
};
addEventListener('paste', e => {
  for (const it of Array.from(e.clipboardData?.items ?? [])) {
    const f = it.type.startsWith('image/') ? it.getAsFile() : null;
    if (f) void addImage(f);
  }
});
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files ?? []);
  for (const f of files.filter(x => x.type.startsWith('image/'))) void addImage(f);
  const docs = files.filter(x => !x.type.startsWith('image/'));
  if (docs.length) void uploadDocs(docs);
});

/* ---------- composer + settings ---------- */
const inp = $<HTMLTextAreaElement>('#input');
function submit(): void {
  if (S.busy) {
    S.abort?.abort();
    ttsStop();
    return;
  }
  const t = inp.value;
  inp.value = '';
  inp.style.height = 'auto';
  void send(t);
}
$('#send').onclick = submit;
inp.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});
let typingTimer = 0;
inp.addEventListener('input', () => {
  Orb.state.typing = inp.value.length > 0;
  clearTimeout(typingTimer);
  typingTimer = window.setTimeout(() => {
    Orb.state.typing = false;
  }, 1500);
});
inp.addEventListener('input', () => {
  inp.style.height = 'auto';
  inp.style.height = `${Math.min(120, inp.scrollHeight)}px`;
});
const opts = $('#opts');
$('#cog').onclick = () => opts.classList.toggle('show');
$('#optsclose').onclick = () => opts.classList.remove('show');
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') opts.classList.remove('show');
});
document.addEventListener('pointerdown', e => {
  if (opts.classList.contains('show') && !opts.contains(e.target as Node) && !(e.target as Element).closest('#cog'))
    opts.classList.remove('show');
});

function bindText(id: string, key: 'sys' | 'voice'): void {
  const el = $<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id);
  el.value = S.set[key];
  el.onchange = () => {
    S.set[key] = el.value;
    store.set('ora.set', S.set);
  };
}
function bindNum(id: string, key: 'temp' | 'maxtok' | 'pagepx' | 'pause'): void {
  const el = $<HTMLInputElement>(id);
  const out = document.getElementById(`${id.slice(1)}-v`);
  const show = (): void => {
    if (out) out.textContent = key === 'pause' ? `${(Number(el.value) / 1000).toFixed(1)} s` : Number(el.value).toFixed(1);
  };
  el.value = String(S.set[key]);
  show();
  el.oninput = show;
  el.onchange = () => {
    const n = Number(el.value);
    const lo = el.min === '' ? -Infinity : Number(el.min),
      hi = el.max === '' ? Infinity : Number(el.max);
    S.set[key] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : S.set[key];
    el.value = String(S.set[key]);
    if (key === 'pause') vad.silenceMs = S.set.pause;
    store.set('ora.set', S.set);
  };
}
bindText('#sys', 'sys');
bindText('#voice', 'voice');
bindNum('#temp', 'temp');
bindNum('#maxtok', 'maxtok');
bindNum('#pagepx', 'pagepx');
bindNum('#pause', 'pause');

for (const c of document.querySelectorAll<HTMLButtonElement>('#cards button')) {
  c.onclick = () => {
    inp.value = c.dataset.prompt ?? '';
    inp.focus();
    inp.dispatchEvent(new Event('input'));
  };
}
// Phones get a drawer and a metrics sheet that start closed; wide landscape screens keep the floating panel.
const desk = matchMedia('(min-width: 768px) and (min-aspect-ratio: 1/1)');
const left = $('#left');
const setPanel = (hidden: boolean): void => {
  left.classList.toggle('collapsed', hidden);
  if (desk.matches) store.set('ora.collapsed', hidden);
};
left.classList.toggle('collapsed', desk.matches ? store.get('ora.collapsed', false) : true);
$('#collapse').onclick = () => setPanel(true);
$('#reopen').onclick = () => setPanel(false);
$('#scrim').onclick = () => setPanel(true);
const closeDrawer = (): void => {
  if (!desk.matches) left.classList.add('collapsed');
};
$('#newchat').addEventListener('click', closeDrawer);
$('#chatlist').addEventListener('click', e => {
  if ((e.target as Element).closest('.chatrow') && !(e.target as Element).closest('button')) closeDrawer();
});
const metrics = $('#metrics');
metrics.classList.toggle('min', store.get('ora.metricsMin', false));
$('#mshow').onclick = () => document.body.classList.toggle('metrics-open');
$('#mtoggle').onclick = () => {
  if (!desk.matches) {
    document.body.classList.remove('metrics-open');
    return;
  }
  metrics.classList.toggle('min');
  store.set('ora.metricsMin', metrics.classList.contains('min'));
};
const speak = $<HTMLInputElement>('#speak');
speak.checked = S.set.speak;
speak.onchange = () => {
  S.set.speak = speak.checked;
  store.set('ora.set', S.set);
  if (!S.set.speak) ttsStop();
};
$('#newchat').onclick = () => {
  void newChat();
};
$('#clear').onclick = () => {
  void newChat();
};

/* ---------- boot ---------- */
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('no-anim')));
hooks.renderLog = renderLog;
hooks.showCtx = showCtx;
hooks.note = note;
hooks.statusline = statusline;
hooks.stopSpeech = ttsStop;
hooks.abortChat = async () => {
  S.abort?.abort();
  ttsStop();
  await inflight;
};

showCtx();
void Orb.ready.then(n => setM('gfx', n));
loadModels()
  .then(pollEngine)
  .then(restoreLastChat)
  .catch((e: unknown) => note(`controller error: ${e instanceof Error ? e.message : String(e)}`, true));
