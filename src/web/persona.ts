// Persona: the orb's mood, expression and persistent memory. Pure logic, no DOM.

export type Expression =
  | 'off'
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'tool'
  | 'talking'
  | 'strained'
  | 'happy'
  | 'surprised'
  | 'sleepy'
  | 'error';

export interface Senses {
  mode: string;
  mic: number;
  out: number;
  rate: number;
  ctx: number;
  kv: number;
  thinking: boolean;
  tool: boolean;
  typing: boolean;
  pointer: { x: number; y: number } | null;
}

export interface Look {
  hue: number;
  sat: number;
  glow: number;
  eyeOpen: number;
  eyeScale: number;
  eyeSmile: number;
  gazeX: number;
  gazeY: number;
  scan: number;
  strain: number;
}

export interface Mood {
  valence: number;
  arousal: number;
  curiosity: number;
  strain: number;
}

export interface Memory {
  turns: number;
  tokensOut: number;
  avgTps: number;
  avgTtft: number;
  images: number;
  voiceTurns: number;
  docs: number;
  errors: number;
  baseline: Mood;
}

export type PersonaEvent =
  | { type: 'reply_done'; tps: number; ttft: number; tokens: number }
  | { type: 'user_image' }
  | { type: 'user_voice' }
  | { type: 'doc' }
  | { type: 'error' };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, def: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : def;
const approach = (cur: number, target: number, rate: number, dt: number): number => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const wrap = (h: number): number => ((h % 360) + 360) % 360;
const hueDelta = (from: number, to: number): number => ((to - from + 540) % 360) - 180;
const familiarity = (turns: number): number => 0.5 + 0.25 * (1 - Math.exp(-turns / 150));

const SLEEP_AFTER = 120;
const BLINK_LEN = 0.16;

interface Pose {
  open: number;
  scale: number;
  smile: number;
}

export class Persona {
  memory: Memory;
  mood: Mood;
  expression: Expression = 'idle';
  private rand: () => number;
  private flash: Expression = 'idle';
  private flashUntil = 0;
  private lastActive = 0;
  private nextBlink: number;
  private blinkStart = -1;
  private wanderAt = 0;
  private wanderX = 0;
  private wanderY = 0;
  private pose: Pose = { open: 1, scale: 1, smile: 0.1 };
  private gx = 0;
  private gy = 0;
  private scan = 0;
  private redTint = 0;

  constructor(saved?: Partial<Memory>, rand: () => number = Math.random) {
    this.rand = rand;
    const turns = num(saved?.turns, 0, 0, 1e9);
    const sb: Partial<Mood> = saved?.baseline ?? {};
    const baseline: Mood = {
      valence: num(sb.valence, familiarity(turns), 0, 1),
      arousal: num(sb.arousal, 0.35, 0, 1),
      curiosity: num(sb.curiosity, 0.5, 0, 1),
      strain: num(sb.strain, 0, 0, 1),
    };
    this.memory = {
      turns,
      tokensOut: num(saved?.tokensOut, 0, 0, 1e12),
      avgTps: num(saved?.avgTps, 0, 0, 1e5),
      avgTtft: num(saved?.avgTtft, 0, 0, 1e7),
      images: num(saved?.images, 0, 0, 1e9),
      voiceTurns: num(saved?.voiceTurns, 0, 0, 1e9),
      docs: num(saved?.docs, 0, 0, 1e9),
      errors: num(saved?.errors, 0, 0, 1e9),
      baseline,
    };
    this.mood = { ...baseline };
    this.nextBlink = 3 + rand() * 3;
  }

  snapshot(): Memory {
    return { ...this.memory, baseline: { ...this.memory.baseline } };
  }

  event(e: PersonaEvent, t: number): void {
    const m = this.memory;
    const mood = this.mood;
    this.lastActive = t;
    switch (e.type) {
      case 'reply_done': {
        const first = m.turns === 0;
        m.turns += 1;
        m.tokensOut += Math.max(0, e.tokens);
        m.avgTps = first || m.avgTps === 0 ? e.tps : m.avgTps * 0.7 + e.tps * 0.3;
        m.avgTtft = first || m.avgTtft === 0 ? e.ttft : m.avgTtft * 0.7 + e.ttft * 0.3;
        m.baseline.valence = familiarity(m.turns);
        if (e.tps >= 30 && e.ttft < 2500) {
          mood.valence = clamp(mood.valence + 0.15, 0, 1);
          this.pulse('happy', t, 2.5);
        } else {
          mood.valence = clamp(mood.valence - 0.05, 0, 1);
        }
        break;
      }
      case 'user_image':
        m.images += 1;
        mood.curiosity = clamp(mood.curiosity + 0.3, 0, 1);
        this.pulse('surprised', t, 1.2);
        break;
      case 'doc':
        m.docs += 1;
        mood.curiosity = clamp(mood.curiosity + 0.3, 0, 1);
        this.pulse('surprised', t, 1.2);
        break;
      case 'user_voice':
        m.voiceTurns += 1;
        mood.arousal = clamp(mood.arousal + 0.1, 0, 1);
        break;
      case 'error':
        m.errors += 1;
        mood.valence = clamp(mood.valence - 0.3, 0, 1);
        this.pulse('error', t, 2.5);
        break;
    }
  }

  update(dt: number, s: Senses, t: number): Look {
    dt = clamp(dt, 0, 0.1);
    const idleish = s.mode === 'idle' || s.mode === 'off';
    if (!idleish || s.typing || s.mic > 0.05) this.lastActive = t;

    const expr = this.pick(s, t);
    this.expression = expr;

    const b = this.memory.baseline;
    const m = this.mood;
    const arTarget = b.arousal + (idleish ? 0 : 0.25) + clamp(s.rate / 200, 0, 0.25) + clamp(s.mic, 0, 1) * 0.3;
    m.arousal = approach(m.arousal, clamp(arTarget, 0, 1), 1.2, dt);
    m.valence = approach(m.valence, b.valence, 0.15, dt);
    m.curiosity = approach(m.curiosity, b.curiosity, 0.2, dt);
    m.strain = approach(m.strain, Math.max(b.strain, clamp((s.ctx - 0.75) / 0.2, 0, 1)), 1.5, dt);

    const target = this.poseFor(expr, s);
    this.pose.open = approach(this.pose.open, target.open, expr === 'off' ? 8 : 10, dt);
    this.pose.scale = approach(this.pose.scale, target.scale, 10, dt);
    this.pose.smile = approach(this.pose.smile, target.smile, 8, dt);

    this.scan = approach(this.scan, expr === 'tool' ? 1 : 0, 6, dt);
    const [tx, ty] = this.gazeFor(expr, s, t);
    const gr = expr === 'tool' ? 14 : 7;
    this.gx = approach(this.gx, tx, gr, dt);
    this.gy = approach(this.gy, ty, gr, dt);

    this.redTint = approach(this.redTint, Math.max(m.strain, expr === 'error' ? 0.8 : 0), 4, dt);
    let hue = 250 + (m.valence - 0.5) * 90 - m.arousal * 25 + m.curiosity * 30;
    hue = wrap(hue + hueDelta(wrap(hue), 8) * this.redTint * 0.9);
    const dim = expr === 'off' ? 0.2 : expr === 'sleepy' ? 0.55 : 1;
    const sat = clamp((72 + m.arousal * 20) * dim, 0, 100);
    const glow = expr === 'off' ? 0.1 : expr === 'sleepy' ? 0.35 : clamp(0.45 + m.arousal * 0.4 + s.out * 0.3, 0, 1);

    return {
      hue,
      sat,
      glow,
      eyeOpen: this.pose.open * (expr === 'off' ? 1 : 1 - this.blink(t)),
      eyeScale: this.pose.scale,
      eyeSmile: this.pose.smile,
      gazeX: this.gx,
      gazeY: this.gy,
      scan: this.scan,
      strain: m.strain,
    };
  }

  private pulse(e: Expression, t: number, seconds: number): void {
    this.flash = e;
    this.flashUntil = t + seconds;
    this.expression = e;
  }

  private pick(s: Senses, t: number): Expression {
    if (s.mode === 'off') return 'off';
    if (s.mode === 'error') return 'error';
    if (t < this.flashUntil) return this.flash;
    if (s.ctx > 0.9) return 'strained';
    if (s.tool) return 'tool';
    if (s.thinking || s.mode === 'prefill') return 'thinking';
    if (s.mode === 'listening') return 'listening';
    if (s.mode === 'gen' || s.mode === 'speaking') return 'talking';
    if (t - this.lastActive > SLEEP_AFTER) return 'sleepy';
    return 'idle';
  }

  private poseFor(expr: Expression, s: Senses): Pose {
    switch (expr) {
      case 'off':
        return { open: 0.04, scale: 1, smile: 0 };
      case 'sleepy':
        return { open: 0.4, scale: 1, smile: 0.05 };
      case 'thinking':
        return { open: 0.6, scale: 0.95, smile: 0 };
      case 'tool':
        return { open: 0.85, scale: 1.05, smile: 0 };
      case 'strained':
        return { open: 0.55, scale: 1, smile: 0 };
      case 'happy':
        return { open: 0.55, scale: 1, smile: 1 };
      case 'surprised':
        return { open: 1, scale: 1.4, smile: 0 };
      case 'error':
        return { open: 0.9, scale: 1.1, smile: 0 };
      case 'listening':
        return { open: 1, scale: 1.1 + clamp(s.mic, 0, 1) * 0.6, smile: 0.1 };
      case 'talking':
        return { open: 0.95, scale: 1 + clamp(s.out, 0, 1) * 0.1, smile: 0.3 };
      default:
        return { open: 1, scale: 1, smile: clamp(0.12 + (this.mood.valence - 0.5) * 0.5, 0, 1) };
    }
  }

  private gazeFor(expr: Expression, s: Senses, t: number): [number, number] {
    switch (expr) {
      case 'thinking':
        return [-0.45, 0.55];
      case 'tool':
        return [Math.sin(t * 3.2) * 0.9 * this.scan, 0.05];
      case 'strained':
        return [Math.sin(t * 23) * 0.05, 0];
      case 'sleepy':
        return [0, -0.3];
      case 'off':
        return [0, -0.2];
      case 'idle':
        if (s.typing) return [0, -0.6];
        if (s.pointer) return [clamp(s.pointer.x * 0.8, -0.8, 0.8), clamp(s.pointer.y * 0.6, -0.6, 0.6)];
        if (t >= this.wanderAt) {
          this.wanderX = (this.rand() - 0.5) * 0.8;
          this.wanderY = (this.rand() - 0.5) * 0.5;
          this.wanderAt = t + 1.5 + this.rand() * 2.5;
        }
        return [this.wanderX, this.wanderY];
      default:
        return [0, 0.05];
    }
  }

  private blink(t: number): number {
    if (this.blinkStart < 0 && t >= this.nextBlink) this.blinkStart = t;
    if (this.blinkStart < 0) return 0;
    const p = (t - this.blinkStart) / BLINK_LEN;
    if (p >= 1) {
      this.blinkStart = -1;
      this.nextBlink = t + 2.5 + this.rand() * 3.5;
      return 0;
    }
    return Math.sin(Math.PI * p);
  }
}
