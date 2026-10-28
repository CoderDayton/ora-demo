import { effect, frame, init, surface } from 'vgpu';
import orbShader from './orb.wgsl';

export interface OrbParams {
  res: [number, number]; center: [number, number]; time: number; radius: number; energy: number; hue: number; sat: number;
  pulse: number; spin: number; ctx: number; kv: number; rate: number; inward: number; ages: number[]; strs: number[];
  eye: number[]; gaze: number[];
}
export interface GpuOrb { size(): [number, number]; draw(params: OrbParams): void }

// Resolves to null when WebGPU is unavailable, so the caller can fall back to canvas 2d.
export async function createGpuOrb(canvas: HTMLCanvasElement): Promise<GpuOrb | null> {
  try {
    const gpu = await init();
    const surf = surface(gpu, canvas, { dpr: [1, 2] });
    const fx = effect(gpu, orbShader);
    return {
      size: () => [surf.size[0], surf.size[1]],
      draw(params) {
        fx.set({ params });
        frame(gpu, f => f.pass(surf, fx));
      },
    };
  } catch (e) {
    console.warn('vgpu unavailable, using canvas 2d:', e);
    return null;
  }
}
