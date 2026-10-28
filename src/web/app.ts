import { IMG_TOKENS, docPayload, newChat, persist, renderDocs, restoreLastChat, uploadDocs } from './chats.ts';
import { Orb } from './orb.ts';
import { $, L, S, api, fmt, hooks, store } from './state.ts';
import type { Msg, Part, Props, Usage } from './state.ts';

interface ModelRow { path: string; name: string; sizeMB: number; mmproj: string[] }
interface EngineStatus { state: string; model: string | null; exit: string | null; logs: string[] }
interface Timings { predicted_per_second?: number; prompt_per_second?: number }
interface StreamChunk {
  choices?: { delta?: { content?: string; reasoning_content?: string; tool_calls?: unknown[] } }[];
  usage?: Usage; timings?: Timings;
}

const CHARS_PER_TOKEN = 3.6;

/* ---------- metrics panel ---------- */
const MROWS: [string, string][] = [
  ['gen', 'generation t/s'], ['pp', 'prompt t/s'], ['ttft', 'first token ms'], ['ctx', 'context'],
  ['kv', 'peak kv fill'], ['act', 'active requests'], ['tin', 'tokens in'], ['tout', 'tokens out'], ['tts', 'tts ms'], ['gfx', 'renderer'],
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
      const pp = get('prompt_tokens_seconds'), gen = get('predicted_tokens_seconds');
      if (pp) setM('pp', fmt(pp));
      if (gen) setM('gen', fmt(gen));
    }
  } catch { /* engine busy or restarting */ }
}
setInterval(() => { void pollMetrics(); }, 800);

function showCtx(): void {
  const used = S.usage?.total_tokens ?? 0;
  Orb.state.ctx = S.nctx ? Math.min(1, used / S.nctx) : 0;
  setM('ctx', S.nctx ? `${used} / ${S.nctx}` : '-');
  setM('tin', S.totals.in);
  setM('tout', S.totals.out);
}

/* ---------- engine control ---------- */
const E = { models: [] as ModelRow[], last: '' };

// File names come from disk, so options are built as DOM nodes and never parsed as HTML.
function setOptions(sel: HTMLSelectElement, rows: { value: string; label: string }[]): void {
  sel.replaceChildren(...rows.map(r => {
    const o = document.createElement('option');
    o.value = r.value;
    o.textContent = r.label;
    return o;
  }));
}

function fillMmproj(): void {
  const m = E.models.find(x => x.path === $<HTMLSelectElement>('#model').value);
  const sel = $<HTMLSelectElement>('#mmproj');
  setOptions(sel, [{ value: '', label: 'no projector (text only)' }]
    .concat((m?.mmproj ?? []).map(p => ({ value: p, label: p.split('/').pop() ?? p }))));
  // prefer the projector whose name shares the model family
  const fam = (m?.name ?? '').split('/').pop()?.split('-').slice(0, 3).join('-').toLowerCase() ?? '';
  const hit = (m?.mmproj ?? []).find(p => p.toLowerCase().includes(fam));
  if (hit) sel.value = hit;
  else if (m?.mmproj?.length) sel.value = m.mmproj[0] as string;
}

async function loadModels(): Promise<void> {
  E.models = await api<ModelRow[]>('/api/models');
  const sel = $<HTMLSelectElement>('#model');
  setOptions(sel, E.models.map(m => ({ value: m.path, label: `${m.name} (${(m.sizeMB / 1000).toFixed(1)} GB)` })));
  const saved = store.get('ora.model', '');
  sel.value = E.models.some(m => m.path === saved) ? saved : (E.models[0]?.path ?? '');
  fillMmproj();
}
$<HTMLSelectElement>('#model').onchange = () => { store.set('ora.model', $<HTMLSelectElement>('#model').value); fillMmproj(); };

function applyEngine(st: EngineStatus): void {
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
  if (!S.busy && !S.handsfree) Orb.setMode(st.state === 'ready' ? 'idle' : st.state === 'starting' ? 'boot' : st.state === 'error' ? 'error' : 'off');
  if (st.state !== E.last && (st.state === 'stopped' || st.state === 'error')) $<HTMLDetailsElement>('#engine').open = true;
  if (st.state === 'ready' && E.last !== 'ready') void loadProps();
  if (st.state !== 'ready') { S.props = null; Orb.state.kv = 0; }
  E.last = st.state;
}

async function loadProps(): Promise<void> {
  try {
    const p = (await (await fetch(`${L}/props`)).json()) as Props;
    S.props = p;
    S.nctx = p.default_generation_settings?.n_ctx ?? 0;
    for (const b of document.querySelectorAll<HTMLElement>('.badge')) b.classList.toggle('on', !!p.modalities?.[b.dataset.m as 'vision' | 'audio' | 'video']);
    const vis = !!p.modalities?.vision;
    $<HTMLButtonElement>('#attach').disabled = !vis;
    $('#attach').title = vis ? 'attach image' : 'this model has no vision encoder';
    showCtx();
    renderDocs();
  } catch { /* retried on next state change */ }
}

async function pollEngine(): Promise<void> {
  try { applyEngine(await api<EngineStatus>('/api/status')); } catch { $('#stext').textContent = 'controller offline'; }
}
setInterval(() => { void pollEngine(); }, 1200);

$('#start').onclick = async () => {
  try {
    await api('/api/start', {
      model: $<HTMLSelectElement>('#model').value, mmproj: $<HTMLSelectElement>('#mmproj').value, ctx: $<HTMLSelectElement>('#ctx').value,
      reasoning: $<HTMLInputElement>('#think').checked ? 'auto' : 'off', parallel: 2,
    });
    store.set('ora.model', $<HTMLSelectElement>('#model').value);
    void pollEngine();
  } catch (e) { note(`start failed: ${e instanceof Error ? e.message : String(e)}`, true); }
};
$('#stop').onclick = async () => { ttsStop(); S.abort?.abort(); await api('/api/stop', {}); void pollEngine(); };
$('#logbtn').onclick = () => $('#logs').classList.toggle('show');

/* ---------- transcript ---------- */
const logEl = $('#log');
const scrollEnd = (): void => { logEl.scrollTop = logEl.scrollHeight; };
function addMsg(role: string, text: string, cls = ''): HTMLElement {
  const d = document.createElement('div');
  d.className = `msg ${role} ${cls}`.trim();
  d.textContent = text;
  logEl.appendChild(d);
  scrollEnd();
  return d;
}
function note(text: string, isErr = false): void { addMsg('note', text, isErr ? 'err' : ''); if (isErr) Orb.error(); }
function renderLog(): void {
  document.body.classList.toggle('chatting', S.hist.length > 0);
  logEl.innerHTML = '';
  for (const m of S.hist) {
    const d = addMsg(m.role, typeof m.content === 'string' ? m.content : '');
    if (typeof m.content === 'string') continue;
    for (const p of m.content) {
      if (p.type === 'image_url') { const im = new Image(); im.src = p.image_url.url; d.prepend(im); }
      else if (p.type === 'input_audio') d.appendChild(document.createTextNode('(voice message) '));
      else d.appendChild(document.createTextNode(p.text));
    }
  }
}
const statusline = (t: string): void => { $('#statusline').textContent = t; };

/* ---------- context budget ---------- */
function estTokens(m: Msg): number {
  if (typeof m.content === 'string') return Math.ceil(m.content.length / CHARS_PER_TOKEN) + 6;
  let n = 6;
  for (const p of m.content) {
    n += p.type === 'text' ? Math.ceil(p.text.length / CHARS_PER_TOKEN)
      : p.type === 'input_audio' ? Math.ceil(p.input_audio.data.length / 3300) : IMG_TOKENS;
  }
  return n;
}

// The saved history is never cut; only the copy sent to the model is trimmed from the oldest end.
function fitHistory(hist: Msg[], budget: number): { msgs: Msg[]; dropped: number } {
  const msgs = hist.slice();
  let tot = msgs.reduce((a, m) => a + estTokens(m), 0);
  let dropped = 0;
  while (msgs.length > 1 && tot > budget) { tot -= estTokens(msgs.shift() as Msg); dropped++; }
  while (msgs.length > 1 && (msgs[0] as Msg).role !== 'user') { msgs.shift(); dropped++; }
  return { msgs, dropped };
}

/* ---------- audio out (tts) ---------- */
let _ac: AudioContext | null = null;
let _outAn: AnalyserNode | null = null;
function ac(): AudioContext {
  if (!_ac) _ac = new AudioContext();
  if (_ac.state === 'suspended') void _ac.resume();
  return _ac;
}
function outAnalyser(): AnalyserNode {
  if (!_outAn) { _outAn = ac().createAnalyser(); _outAn.fftSize = 1024; _outAn.connect(ac().destination); }
  return _outAn;
}
const T = { q: [] as { p: Promise<AudioBuffer | null>; id: number }[], playing: false, buf: '', id: 0, src: null as AudioBufferSourceNode | null };
const SENT = /[.!?]+["')\]]*\s|\n/;
const speechClean = (s: string): string => s.replace(/```[\s\S]*?```/g, ' ').replace(/[*_#`>~|]/g, '').replace(/\s+/g, ' ').trim();

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
    if (/[\p{L}\p{N}]/u.test(chunk)) ttsEnqueue(chunk);
    if (!T.buf) break;
  }
}
function ttsEnqueue(text: string): void {
  const id = T.id, t0 = performance.now();
  const p = fetch(`${L}/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: text, voice: S.set.voice }) })
    .then(async r => {
      if (!r.ok) throw new Error(`tts ${r.status}`);
      const buf = await ac().decodeAudioData(await r.arrayBuffer());
      setM('tts', fmt(performance.now() - t0));
      return buf;
    })
    .catch((e: unknown) => { console.warn(e); return null; });
  T.q.push({ p, id });
  Orb.ripple(0.4, 38);
  if (!T.playing) void ttsPlay();
}
async function ttsPlay(): Promise<void> {
  T.playing = true;
  while (T.q.length) {
    const it = T.q.shift() as { p: Promise<AudioBuffer | null>; id: number };
    const buf = await it.p;
    if (it.id !== T.id || !buf) continue;
    Orb.setMode('speaking');
    await new Promise<void>(res => {
      const s = ac().createBufferSource();
      s.buffer = buf;
      s.connect(outAnalyser());
      T.src = s;
      s.onended = () => res();
      s.start();
    });
    T.src = null;
  }
  T.playing = false;
  if (!S.busy) afterTurn();
}
function ttsStop(): void {
  T.id++; T.q = []; T.buf = '';
  try { T.src?.stop(); } catch { /* already stopped */ }
  T.src = null;
}

/* ---------- chat ---------- */
function userContent(text: string, imgs: string[], audio?: string): string | Part[] {
  if (!imgs.length && !audio) return text;
  const parts: Part[] = imgs.map(u => ({ type: 'image_url', image_url: { url: u } }));
  if (audio) parts.push({ type: 'input_audio', input_audio: { data: audio, format: 'wav' } });
  if (text) parts.push({ type: 'text', text });
  return parts;
}

// The persona's memory lives on the server so it survives browser data clears.
let personaTimer = 0;
function savePersona(): void {
  clearTimeout(personaTimer);
  personaTimer = window.setTimeout(() => {
    void fetch('/api/persona', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Orb.memory()) }).catch(() => undefined);
  }, 800);
}
async function loadPersona(): Promise<void> {
  try {
    const r = await fetch('/api/persona');
    if (r.ok) Orb.restore((await r.json()) as Partial<ReturnType<typeof Orb.memory>>);
  } catch { /* starts blank */ }
}
void loadPersona();

// Saves are chained so messages reach storage in the order they were said.
let saveChain: Promise<void> = Promise.resolve();
function save(m: Msg, titleHint = ''): void {
  saveChain = saveChain.then(() => persist(m, titleHint)).catch((e: unknown) => note(`not saved: ${e instanceof Error ? e.message : String(e)}`, true));
}

function lastUserText(): string {
  for (let i = S.hist.length - 1; i >= 0; i--) {
    const m = S.hist[i] as Msg;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const t = m.content.find((p): p is { type: 'text'; text: string } => p.type === 'text');
    if (t && t.text !== '[voice message]') return t.text;
  }
  return '';
}

async function send(text: string, opts: { audio?: string } = {}): Promise<void> {
  text = text.trim();
  if ((!text && !S.pending.length && !opts.audio) || S.busy || S.engine !== 'ready') return;
  ttsStop();
  const imgs = S.pending;
  S.pending = [];
  renderPending();
  const um: Msg = { role: 'user', content: userContent(text || (opts.audio ? '' : 'Describe this image.'), imgs, opts.audio) };
  S.hist.push(um);
  save(um, text);
  renderLog();
  Orb.state.typing = false;
  if (imgs.length) Orb.event({ type: 'user_image' });
  if (opts.audio) Orb.event({ type: 'user_voice' });

  const bubble = addMsg('assistant', '');
  const ctl = new AbortController();
  S.abort = ctl;
  S.busy = true;
  $('#send').classList.add('stop');
  Orb.setMode('prefill');
  statusline('reading...');
  const t0 = performance.now();
  let tFirst = 0, n = 0, acc = '';
  let timings: Timings | null = null;
  try {
    const dp = await docPayload(text || lastUserText());
    if (dp.note) note(dp.note);
    const sysText = S.set.sys + dp.system;
    const budget = S.nctx - S.set.maxtok - Math.ceil(sysText.length / CHARS_PER_TOKEN) - dp.tokens - 64;
    const { msgs, dropped } = fitHistory(S.hist, S.nctx ? budget : Infinity);
    if (dropped) note(`context full: ${dropped} oldest messages not sent`);
    const res = await fetch(`${L}/v1/chat/completions`, {
      method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'system', content: sysText }, ...dp.lead, ...msgs],
        stream: true, stream_options: { include_usage: true }, temperature: S.set.temp, max_tokens: S.set.maxtok,
      }),
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? res.statusText);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = '';
    const onChunk = (j: StreamChunk): void => {
      const dl = j.choices?.[0]?.delta ?? {};
      const now = performance.now();
      if ((dl.content || dl.reasoning_content) && !tFirst) { tFirst = now; setM('ttft', fmt(now - t0)); Orb.setMode('gen'); }
      if (dl.tool_calls?.length) { Orb.state.tool = true; statusline('calling a tool...'); }
      if (dl.reasoning_content) { n++; Orb.state.thinking = true; Orb.pulse(0.12); statusline('thinking...'); }
      if (dl.content) {
        Orb.state.thinking = false;
        acc += dl.content; n++;
        bubble.textContent = acc; scrollEnd();
        Orb.pulse(0.3);
        ttsFeed(dl.content);
      }
      if (tFirst) {
        const rate = n / ((now - tFirst) / 1000 + 0.05);
        Orb.state.rate = rate;
        setM('gen', fmt(rate));
        if (dl.content) statusline(`${n} tok - ${fmt(rate)} t/s`);
      }
      if (j.usage) S.usage = j.usage;
      if (j.timings) timings = j.timings;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (;;) {
        const i = buf.indexOf('\n\n');
        if (i < 0) break;
        const ev = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of ev.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (d && d !== '[DONE]') onChunk(JSON.parse(d) as StreamChunk);
        }
      }
    }
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      bubble.classList.add('err');
      bubble.textContent = `error: ${e instanceof Error ? e.message : String(e)}`;
      Orb.error();
    }
  } finally {
    if (acc) {
      const am: Msg = { role: 'assistant', content: acc };
      S.hist.push(am);
      save(am);
    } else if (!bubble.classList.contains('err')) bubble.remove();
    if (S.usage) { S.totals.in += S.usage.prompt_tokens ?? 0; S.totals.out += S.usage.completion_tokens ?? 0; }
    const tm = timings as Timings | null;
    if (tm) { setM('gen', fmt(tm.predicted_per_second)); setM('pp', fmt(tm.prompt_per_second)); }
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
    if (!T.playing && !T.q.length) afterTurn();
  }
}

/* ---------- voice in: mic, VAD, wav ---------- */
function down(f: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return f;
  const r = from / to, n = Math.floor(f.length / r), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * r), b = Math.min(f.length, Math.floor((i + 1) * r));
    let s = 0;
    for (let j = a; j < b; j++) s += f[j] as number;
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}
function wavB64(f: Float32Array, rate: number): string {
  const n = f.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, f[i] as number)); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  const u8 = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
  return btoa(bin);
}

const M = {
  stream: null as MediaStream | null, src: null as MediaStreamAudioSourceNode | null, proc: null as ScriptProcessorNode | null,
  rec: false, buf: [] as Float32Array[], pre: [] as Float32Array[], floor: 0.005, startN: 0, lastVoice: 0, t0: 0,
};
function afterTurn(): void {
  Orb.setMode(S.handsfree ? 'listening' : S.engine === 'ready' ? 'idle' : 'off');
  statusline(S.handsfree ? 'listening...' : '');
}
function vad(x: Float32Array): void {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] as number) * (x[i] as number);
  const rms = Math.sqrt(s / x.length);
  Orb.state.mic = rms;
  if (S.busy || T.playing || S.engine !== 'ready') { M.rec = false; M.buf = []; M.pre = []; M.startN = 0; return; }
  if (!M.rec) M.floor = M.floor * 0.97 + Math.min(rms, M.floor * 3 + 0.002) * 0.03;
  const th = Math.max(0.015, M.floor * 4), now = performance.now();
  if (!M.rec) {
    M.pre.push(x);
    if (M.pre.length > 8) M.pre.shift();
    if (rms > th) {
      if (++M.startN >= 2) { M.rec = true; M.buf = [...M.pre]; M.lastVoice = now; M.t0 = now; Orb.setMode('listening'); statusline('hearing you...'); }
    } else M.startN = 0;
  } else {
    M.buf.push(x);
    if (rms > th * 0.6) M.lastVoice = now;
    if (now - M.lastVoice > 900 || now - M.t0 > 30000) finishUtterance();
  }
}
// The audio goes to the model as-is, together with any attached image, so it hears and sees in one turn.
function finishUtterance(): void {
  const chunks = M.buf;
  M.rec = false; M.buf = []; M.pre = []; M.startN = 0;
  const len = chunks.reduce((a, c) => a + c.length, 0), rate = ac().sampleRate;
  if (len / rate < 0.5) return;
  const all = new Float32Array(len);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  void send('', { audio: wavB64(down(all, rate, 16000), 16000) });
}
async function micOn(): Promise<void> {
  try {
    const c = ac();
    M.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    M.src = c.createMediaStreamSource(M.stream);
    M.proc = c.createScriptProcessor(2048, 1, 1);
    M.src.connect(M.proc);
    M.proc.connect(c.destination);
    M.proc.onaudioprocess = e => vad(new Float32Array(e.inputBuffer.getChannelData(0)));
    S.handsfree = true;
    $('#mic').classList.add('live');
    if (!S.busy && !T.playing) afterTurn();
  } catch (e) { note(`mic unavailable: ${e instanceof Error ? e.message : String(e)}`, true); }
}
function micOff(): void {
  M.proc?.disconnect(); M.src?.disconnect();
  M.stream?.getTracks().forEach(t => t.stop());
  M.proc = null; M.src = null; M.stream = null; M.rec = false; M.buf = []; M.pre = [];
  S.handsfree = false;
  $('#mic').classList.remove('live');
  Orb.state.mic = 0;
  if (!S.busy && !T.playing) afterTurn();
}
$('#mic').onclick = () => { if (S.handsfree) micOff(); else void micOn(); };

const lvBuf = new Uint8Array(1024);
(function outLevel(): void {
  const an = _outAn as AnalyserNode | null;
  if (an && T.playing) {
    an.getByteTimeDomainData(lvBuf);
    let s = 0;
    for (const v of lvBuf) { const d = (v - 128) / 128; s += d * d; }
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
    b.onclick = () => { S.pending.splice(i, 1); renderPending(); };
    d.append(im, b);
    el.appendChild(d);
  });
}
async function addImage(file: File): Promise<void> {
  if (!S.props?.modalities?.vision) { note('this model has no vision encoder', true); return; }
  try {
    const bmp = await createImageBitmap(file);
    const sc = Math.min(1, 896 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * sc);
    c.height = Math.round(bmp.height * sc);
    (c.getContext('2d') as CanvasRenderingContext2D).drawImage(bmp, 0, 0, c.width, c.height);
    S.pending.push(c.toDataURL('image/jpeg', 0.85));
    renderPending();
  } catch (e) { note(`image failed: ${e instanceof Error ? e.message : String(e)}`, true); }
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
  if (S.busy) { S.abort?.abort(); ttsStop(); return; }
  const t = inp.value;
  inp.value = '';
  inp.style.height = 'auto';
  void send(t);
}
$('#send').onclick = submit;
inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
let typingTimer = 0;
inp.addEventListener('input', () => {
  Orb.state.typing = inp.value.length > 0;
  clearTimeout(typingTimer);
  typingTimer = window.setTimeout(() => { Orb.state.typing = false; }, 1500);
});
inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = `${Math.min(120, inp.scrollHeight)}px`; });
$('#cog').onclick = () => $('#opts').classList.toggle('show');

function bindText(id: string, key: 'sys' | 'voice'): void {
  const el = $<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id);
  el.value = S.set[key];
  el.onchange = () => { S.set[key] = el.value; store.set('ora.set', S.set); };
}
function bindNum(id: string, key: 'temp' | 'maxtok' | 'pagepx'): void {
  const el = $<HTMLInputElement>(id);
  el.value = String(S.set[key]);
  el.onchange = () => { S.set[key] = Number(el.value); store.set('ora.set', S.set); };
}
bindText('#sys', 'sys');
bindText('#voice', 'voice');
bindNum('#temp', 'temp');
bindNum('#maxtok', 'maxtok');
bindNum('#pagepx', 'pagepx');

for (const c of document.querySelectorAll<HTMLButtonElement>('#cards button')) {
  c.onclick = () => { inp.value = c.dataset.prompt ?? ''; inp.focus(); inp.dispatchEvent(new Event('input')); };
}
const left = $('#left');
left.classList.toggle('collapsed', store.get('ora.collapsed', false));
$('#collapse').onclick = () => { left.classList.add('collapsed'); store.set('ora.collapsed', true); };
$('#reopen').onclick = () => { left.classList.remove('collapsed'); store.set('ora.collapsed', false); };
const metrics = $('#metrics');
metrics.classList.toggle('min', store.get('ora.metricsMin', false));
$('#mtoggle').onclick = () => { metrics.classList.toggle('min'); store.set('ora.metricsMin', metrics.classList.contains('min')); };
const speak = $<HTMLInputElement>('#speak');
speak.checked = S.set.speak;
speak.onchange = () => { S.set.speak = speak.checked; store.set('ora.set', S.set); if (!S.set.speak) ttsStop(); };
$('#newchat').onclick = () => { void newChat(); };
$('#clear').onclick = () => { void newChat(); };

/* ---------- boot ---------- */
hooks.renderLog = renderLog;
hooks.showCtx = showCtx;
hooks.note = note;
hooks.statusline = statusline;
hooks.stopSpeech = ttsStop;
hooks.abortChat = () => { S.abort?.abort(); };

showCtx();
void Orb.ready.then(n => setM('gfx', n));
loadModels().then(pollEngine).then(restoreLastChat).catch((e: unknown) => note(`controller error: ${e instanceof Error ? e.message : String(e)}`, true));
