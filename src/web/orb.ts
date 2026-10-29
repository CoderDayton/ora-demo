// Orb renderer. Modes: off, boot, idle, listening, prefill, gen, speaking, error.
// Inputs are plain numbers set by app.ts: mic, out (0..1 audio levels), rate (tok/s), ctx, kv (0..1).

import type { GpuOrb } from './orb-gpu.ts';
import { createGpuOrb } from './orb-gpu.ts';
import type { Look, Memory, PersonaEvent } from './persona.ts';
import { Persona } from './persona.ts';

type Mode = 'off' | 'boot' | 'idle' | 'listening' | 'prefill' | 'gen' | 'speaking' | 'error';
interface OrbState {
  mode: Mode;
  mic: number;
  out: number;
  rate: number;
  ctx: number;
  kv: number;
  pulse: number;
  hue: number;
  energy: number;
  spin: number;
  sat: number;
  thinking: boolean;
  tool: boolean;
  typing: boolean;
  pointer: { x: number; y: number } | null;
}
interface Ripple {
  t0: number;
  s: number;
  hue?: number;
}
interface Particle {
  a: number;
  r: number;
  sp: number;
  sz: number;
  cr?: number;
}

const cv = document.getElementById('orb') as HTMLCanvasElement;
let g: CanvasRenderingContext2D | null = null;
let gpu: GpuOrb | null = null;
const O: OrbState = {
  mode: 'off',
  mic: 0,
  out: 0,
  rate: 0,
  ctx: 0,
  kv: 0,
  pulse: 0,
  hue: 200,
  energy: 0.1,
  spin: 0.1,
  sat: 30,
  thinking: false,
  tool: false,
  typing: false,
  pointer: null,
};
let persona = new Persona();
let look: Look = persona.update(0, { ...O }, 0);
const ripples: Ripple[] = [];
const parts: Particle[] = Array.from({ length: 600 }, () => ({
  a: Math.random() * 6.283,
  r: 1.25 + Math.random() * 0.5,
  sp: 0.4 + Math.random() * 1.2,
  sz: 0.3 + Math.random() * 0.6,
}));
let W = 0,
  H = 0,
  dpr = 1,
  last = performance.now(),
  flash = 0;

// Orb centre height and size as fractions of the viewport; leaves room for the welcome text below it.
const wide = matchMedia('(min-width: 768px) and (min-aspect-ratio: 1/1)');
let dock = 0;
// Orb centre as a fraction of the height and radius as a fraction of the short side. Once a conversation starts the
// orb shrinks toward the top edge, which leaves the screen to the messages.
function place(w: number, h: number): { y: number; r: number } {
  if (wide.matches) return { y: 0.33 - 0.12 * dock, r: 0.13 - 0.035 * dock };
  const r0 = Math.min(0.2, (0.11 * h) / Math.min(w, h));
  return { y: 0.26 - 0.145 * dock, r: r0 - (r0 - 0.1) * dock };
}

function resize(): void {
  if (gpu) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = cv.width = Math.floor(innerWidth * dpr);
  H = cv.height = Math.floor(innerHeight * dpr);
}
addEventListener('resize', resize);
resize();

// Pointer relative to the orb centre, normalised so the screen edge is about 1.
addEventListener('pointermove', ev => {
  O.pointer = {
    x: (ev.clientX - innerWidth / 2) / (innerWidth / 2),
    y: -(ev.clientY - innerHeight * place(innerWidth, innerHeight).y) / (innerHeight / 2),
  };
});
document.addEventListener('pointerleave', () => {
  O.pointer = null;
});

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const hsl = (h: number, s: number, l: number, a = 1): string => `hsla(${((h % 360) + 360) % 360},${s}%,${l}%,${a})`;

function targets(): { hue: number; e: number; spin: number; sat: number } {
  switch (O.mode) {
    case 'boot':
      return { hue: 45, e: 0.2 + 0.25 * Math.sin(performance.now() / 350) ** 2, spin: 0.5, sat: 85 };
    case 'idle':
      return { hue: 195, e: 0.12, spin: 0.12, sat: 70 };
    case 'listening':
      return { hue: 160, e: 0.18 + Math.min(1, O.mic * 7) * 0.8, spin: 0.25, sat: 85 };
    case 'prefill':
      return { hue: 268, e: 0.55, spin: 0.7, sat: 90 };
    case 'gen':
      return { hue: 285 + Math.min(60, O.rate * 0.25), e: 0.4 + O.pulse * 0.5, spin: 0.4 + O.rate / 120, sat: 90 };
    case 'speaking':
      return { hue: 38, e: 0.25 + Math.min(1, O.out * 5) * 0.8, spin: 0.3, sat: 92 };
    case 'error':
      return { hue: 0, e: 0.6, spin: 0.2, sat: 90 };
    default:
      return { hue: 215, e: 0.04, spin: 0.03, sat: 12 };
  }
}

// Canvas 2d version of the shader's eyes; smile bends each eye into an arch.
function drawEyes(c: CanvasRenderingContext2D, cx: number, cy: number, R: number): void {
  c.globalCompositeOperation = 'source-over';
  const hw = (0.075 + (0.12 - 0.075) * look.eyeSmile) * look.eyeScale * R;
  const hh = Math.max((0.17 + (0.035 - 0.17) * look.eyeSmile) * look.eyeScale * look.eyeOpen, 0.014) * R;
  c.fillStyle = look.strain > 0.5 ? '#ffd2cc' : hsl(O.hue, 55, 90, 1);
  c.shadowColor = 'rgba(4,5,12,.7)';
  c.shadowBlur = 18 * dpr;
  for (const sx of [-1, 1]) {
    const x = cx + (sx * 0.27 + look.gazeX * 0.2) * R;
    const y = cy - (0.04 + look.gazeY * 0.15) * R;
    c.beginPath();
    if (look.eyeSmile > 0.5) {
      c.lineWidth = hh * 2;
      c.lineCap = 'round';
      c.strokeStyle = c.fillStyle;
      c.arc(x, y + hw * 0.9, hw, Math.PI * 1.15, Math.PI * 1.85);
      c.stroke();
    } else {
      c.roundRect(x - hw, y - hh, hw * 2, hh * 2, Math.min(hw, hh));
      c.fill();
    }
  }
  c.shadowBlur = 0;
}

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  dock += ((document.body.classList.contains('chatting') ? 1 : 0) - dock) * (1 - Math.exp(-dt * 6));
  const k = 1 - Math.exp(-dt * 5);
  const T = targets();
  look = persona.update(dt, O, t);
  O.hue = look.hue;
  O.sat = look.sat;
  O.energy = lerp(O.energy, T.e, 1 - Math.exp(-dt * 9));
  O.spin = lerp(O.spin, T.spin, k);
  O.pulse *= Math.exp(-dt * 4);
  flash *= Math.exp(-dt * 3);

  if (gpu) {
    const [gw, gh] = gpu.size();
    while (ripples.length && now - (ripples[0] as Ripple).t0 > 1400) ripples.shift();
    const ages = [0, 0, 0, 0],
      strs = [0, 0, 0, 0];
    ripples.slice(-4).forEach((rp, i) => {
      ages[i] = (now - rp.t0) / 1000;
      strs[i] = rp.s;
    });
    gpu.draw({
      res: [gw, gh],
      center: [gw / 2, gh * place(gw, gh).y],
      time: t,
      radius: Math.min(gw, gh) * place(gw, gh).r * (1 + 0.04 * Math.sin(t * 1.3) + O.energy * 0.12 + O.pulse * 0.1),
      energy: O.energy,
      hue: O.hue,
      sat: O.sat,
      pulse: O.pulse,
      spin: O.spin,
      ctx: O.ctx,
      kv: O.kv,
      rate: O.rate,
      inward: O.mode === 'prefill' || O.mode === 'boot' ? 1 : 0,
      ages,
      strs,
      eye: [look.eyeOpen, look.eyeScale, look.eyeSmile, look.strain],
      gaze: [look.gazeX, look.gazeY, look.glow, 0],
    });
    requestAnimationFrame(frame);
    return;
  }
  if (!g) {
    requestAnimationFrame(frame);
    return;
  }

  g.globalCompositeOperation = 'source-over';
  g.fillStyle = 'rgba(7,8,13,0.3)';
  g.fillRect(0, 0, W, H);

  const pl = place(W, H);
  const cx = W / 2,
    cy = H * pl.y;
  const base = Math.min(W, H) * pl.r;
  const R = base * (1 + 0.04 * Math.sin(t * 1.3) + O.energy * 0.12 + O.pulse * 0.1);
  const amp = 0.05 + 0.24 * O.energy;

  // Not 'lighter': with the trail fade above, adding light every frame saturates to a flat white disc.
  g.globalCompositeOperation = 'source-over';
  for (let layer = 0; layer < 3; layer++) {
    const n = 110;
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * 6.283;
      const w =
        Math.sin(a * 3 + t * (0.8 + layer * 0.35) + layer) * 0.5 +
        Math.sin(a * 5 - t * 1.3 + layer * 2) * 0.3 +
        Math.sin(a * 2 + t * 0.6 * (1 + O.spin)) * 0.2;
      const r = R * (1 + amp * w);
      const x = cx + Math.cos(a + t * O.spin * 0.2) * r;
      const y = cy + Math.sin(a + t * O.spin * 0.2) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    const gr = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.25);
    gr.addColorStop(0, hsl(O.hue + layer * 18, O.sat, 52, 0.4));
    gr.addColorStop(0.7, hsl(O.hue + 30 + layer * 18, O.sat, 48, 0.3));
    gr.addColorStop(1, hsl(O.hue + 50, O.sat, 35, 0));
    g.fillStyle = gr;
    g.shadowColor = hsl(O.hue, 90, 60, 0.8);
    g.shadowBlur = 40 * dpr * (0.5 + O.energy);
    g.fill();
  }
  g.shadowBlur = 0;

  const core = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.45);
  core.addColorStop(0, hsl(O.hue + 20, 60, 70, 0.35));
  core.addColorStop(1, hsl(O.hue, O.sat, 60, 0));
  g.fillStyle = core;
  g.beginPath();
  g.arc(cx, cy, R * 0.45, 0, 6.283);
  g.fill();
  drawEyes(g, cx, cy, R);

  // ripples on events (token, network call, tts chunk)
  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i] as Ripple;
    const age = (now - rp.t0) / 1000;
    if (age > 1.4) {
      ripples.splice(i, 1);
      continue;
    }
    g.strokeStyle = hsl(rp.hue ?? O.hue, 90, 70, (1 - age / 1.4) * 0.5 * rp.s);
    g.lineWidth = 2 * dpr;
    g.beginPath();
    g.arc(cx, cy, R * (1.05 + age * 1.1), 0, 6.283);
    g.stroke();
  }

  // particles: orbit speed follows token rate; prefill drags them inward
  const inward = O.mode === 'prefill' || O.mode === 'boot';
  for (const p of parts) {
    p.a += dt * p.sp * (0.15 + O.spin * 0.9 + O.rate * 0.004);
    const goal = inward ? 0.75 + (p.r - 1.25) * 0.4 : p.r + O.energy * 0.25;
    p.cr = lerp(p.cr ?? p.r, goal, 1 - Math.exp(-dt * 2.5));
    const rr = R * p.cr * (1 + O.pulse * 0.15);
    const x = cx + Math.cos(p.a) * rr,
      y = cy + Math.sin(p.a) * rr * 0.92;
    g.fillStyle = hsl(O.hue + p.sz * 40, O.sat, 78, 0.3 + O.energy * 0.4);
    g.beginPath();
    g.arc(x, y, p.sz * dpr * (1 + O.energy * 0.6), 0, 6.283);
    g.fill();
  }

  // context ring: length = context used, color = pressure
  g.globalCompositeOperation = 'source-over';
  const rc = R * 1.62;
  g.lineWidth = dpr;
  g.strokeStyle = 'rgba(255,255,255,0.16)';
  g.beginPath();
  g.arc(cx, cy, rc, 0, 6.283);
  g.stroke();
  // a tick every 6 degrees, longer every 30
  g.beginPath();
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * 6.283,
      inner = rc - (i % 5 ? 3 : 7) * dpr;
    g.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    g.lineTo(cx + Math.cos(a) * rc, cy + Math.sin(a) * rc);
  }
  g.stroke();
  if (O.ctx > 0.002) {
    g.strokeStyle = hsl(lerp(170, 0, O.ctx), 85, 60, 0.9);
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    g.arc(cx, cy, rc, -1.5708, -1.5708 + 6.283 * Math.min(1, O.ctx));
    g.stroke();
  }
  if (O.kv > 0.002) {
    g.setLineDash([dpr, 4 * dpr]);
    g.strokeStyle = hsl(210, 80, 70, 0.55);
    g.lineWidth = dpr;
    g.beginPath();
    g.arc(cx, cy, rc * 1.07, -1.5708, -1.5708 + 6.283 * Math.min(1, O.kv));
    g.stroke();
    g.setLineDash([]);
  }
  if (flash > 0.01) {
    g.fillStyle = `rgba(255,80,80,${flash * 0.25})`;
    g.fillRect(0, 0, W, H);
  }
  requestAnimationFrame(frame);
}

export const Orb = {
  ready: createGpuOrb(cv).then(r => {
    gpu = r;
    if (!gpu) g = cv.getContext('2d');
    requestAnimationFrame(frame);
    return gpu ? 'webgpu (vgpu)' : 'canvas 2d';
  }),
  state: O,
  setMode(m: Mode): void {
    O.mode = m;
  },
  pulse(s = 0.3): void {
    O.pulse = Math.min(1, O.pulse + s);
    if (s >= 0.2) this.ripple(s);
  },
  ripple(s = 0.5, hue?: number): void {
    ripples.push({ t0: performance.now(), s: Math.min(1, s), hue });
    if (ripples.length > 12) ripples.shift();
  },
  error(): void {
    flash = 1;
    this.setMode('error');
    this.event({ type: 'error' });
  },
  event(e: PersonaEvent): void {
    persona.event(e, performance.now() / 1000);
  },
  restore(m: Partial<Memory>): void {
    persona = new Persona(m);
  },
  memory(): Memory {
    return persona.snapshot();
  },
  expression(): string {
    return persona.expression;
  },
};
