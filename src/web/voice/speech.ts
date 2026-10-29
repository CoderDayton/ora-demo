// Spoken replies: sentences go to /llama/tts as they stream in and play in order. While speech is on, the reply
// text is revealed in step with the audio.
import { mdInto, nearBottom, scrollEnd } from '../chat/render.ts';
import { Orb } from '../orb/orb.ts';
import { L, S } from '../state.ts';

let _ac: AudioContext | null = null;
let _outAn: AnalyserNode | null = null;
export function ac(): AudioContext {
  if (!_ac) _ac = new AudioContext();
  if (_ac.state === 'suspended') void _ac.resume();
  return _ac;
}
export function outAnalyser(): AnalyserNode {
  if (!_outAn) {
    _outAn = ac().createAnalyser();
    _outAn.fftSize = 1024;
    _outAn.connect(ac().destination);
  }
  return _outAn;
}

// The output analyser once something has played (null before, so reading it never creates an AudioContext).
export const activeAnalyser = (): AnalyserNode | null => _outAn;

// The page sets these: `idle` runs when the voice has finished and no turn is running, `synth` gets each
// synthesis time in ms.
export const speechEvents = {
  idle: (): void => undefined,
  synth: (_ms: number): void => undefined,
};

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

export const speaking = (): boolean => T.playing;
export const speechIdle = (): boolean => !T.playing && !T.q.length;
export const visibleCap = (): number => R.cap;

// Starts showing a reply in `el`; with speech on nothing is visible until the voice reaches it.
export function showReply(el: HTMLElement, text: () => string): void {
  R.el = el;
  R.text = text;
  R.cap = S.set.speak ? 0 : Infinity;
}
export function paint(): void {
  if (!R.el) return;
  const follow = nearBottom();
  mdInto(R.el, R.text().slice(0, R.cap));
  if (follow) scrollEnd();
}
export function reveal(to: number): void {
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

// Feeds streamed reply text to the voice; `final` flushes the last partial sentence.
export function speechFeed(d: string, final = false): void {
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
    if (/[\p{L}\p{N}]/u.test(chunk)) enqueue(chunk, T.off);
    if (!T.buf) break;
  }
}
// Auto mode sets the speed of the reply being spoken; 0 means the setting applies.
export const live = { rate: 0 };
const rate = (): number => live.rate || S.set.rate;
// Says a short line that is not part of the reply text (a tool status, an approval question). Needs speech on.
export function say(text: string): void {
  if (!S.set.speak) return;
  const chunk = speechClean(text);
  if (/[\p{L}\p{N}]/u.test(chunk)) enqueue(chunk, T.off);
}
function enqueue(text: string, end: number): void {
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
      speechEvents.synth(performance.now() - t0);
      return buf;
    })
    .catch((e: unknown) => {
      console.warn(e);
      return null;
    });
  T.q.push({ p, id, end });
  Orb.ripple(0.4, 38);
  if (!T.playing) void play();
}
async function play(): Promise<void> {
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
      // Faster playback also raises the pitch a little; up to 1.5x stays natural.
      s.playbackRate.value = rate();
      s.connect(outAnalyser());
      T.src = s;
      s.onended = () => res();
      s.start();
      glide(R.cap, it.end, buf.duration / rate());
    });
    T.src = null;
    if (it.id === T.id) reveal(it.end);
  }
  T.playing = false;
  if (!S.busy) {
    reveal(Infinity);
    speechEvents.idle();
  }
}
export function speechStop(): void {
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
