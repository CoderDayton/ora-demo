// Headless render of the orb shader through vgpu/node (Dawn). Usage: node scripts/render-check.ts <outDir>
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PNG } from 'pngjs';
import { init, effect, target } from 'vgpu/node';
import { resolveShader } from '@vgpu/wgsl/runtime';
import { prepareShader } from '@vgpu/wgsl/prepare';

const out = process.argv[2] || '.';
mkdirSync(out, { recursive: true });
const W = 960, H = 720;
const resolved = await resolveShader({ entry: fileURLToPath(new URL('../src/web/orb.wgsl', import.meta.url)) });
const gpu = await init();
const colorTarget = target(gpu, { size: [W, H] });
const fx = effect(gpu, prepareShader(resolved.wgsl));

const base = { res: [W, H], center: [W / 2, H * 0.4], time: 3.2, radius: H * 0.2, energy: 0.15, hue: 195, sat: 70, pulse: 0, spin: 0.12, ctx: 0, kv: 0, rate: 0, inward: 0, ages: [0, 0, 0, 0], strs: [0, 0, 0, 0] };
const eyes = { eye: [1, 1, 0.1, 0], gaze: [0, 0.05, 0.8, 0] };
const states = {
  idle: { ...base, ...eyes, hue: 262 },
  thinking: { ...base, hue: 255, energy: 0.55, spin: 0.7, inward: 1, eye: [0.6, 0.95, 0, 0], gaze: [-0.45, 0.55, 0.9, 0] },
  happy: { ...base, hue: 300, sat: 90, energy: 0.5, eye: [0.55, 1, 1, 0], gaze: [0, 0.05, 1, 0] },
  surprised: { ...base, hue: 215, energy: 0.4, eye: [1, 1.4, 0, 0], gaze: [0.2, 0.1, 0.9, 0] },
  strained: { ...base, hue: 6, sat: 90, energy: 0.8, ctx: 0.95, kv: 0.6, eye: [0.55, 1, 0, 1], gaze: [0, 0, 1, 0] },
  generating: { ...base, ...eyes, energy: 0.8, hue: 300, sat: 90, pulse: 0.6, spin: 1.2, rate: 300, ctx: 0.35, kv: 0.2, ages: [0.2, 0.6, 0, 0], strs: [0.8, 0.5, 0, 0] },
  sleepy: { ...base, hue: 240, sat: 40, energy: 0.05, eye: [0.4, 1, 0.05, 0], gaze: [0, -0.3, 0.35, 0] },
};
for (const [name, params] of Object.entries(states)) {
  fx.set({ params });
  fx.draw(colorTarget);
  const px = await colorTarget.color.read({ mipLevel: 0, region: 'all' });
  const png = new PNG({ width: W, height: H });
  png.data.set(px);
  writeFileSync(path.join(out, `orb-${name}.png`), PNG.sync.write(png));
  let lum = 0, bright = 0;
  for (let i = 0; i < px.length; i += 4) { const l = ((px[i] ?? 0) + (px[i + 1] ?? 0) + (px[i + 2] ?? 0)) / 3; lum += l; if (l > 120) bright++; }
  console.log(name, 'mean', (lum / (W * H)).toFixed(1), 'bright px', bright);
}
gpu.dispose();
