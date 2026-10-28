export type VadEvent = 'start' | 'barge' | 'end';
export interface VadOptions { silenceMs: number; maxMs: number }

// Decides when the user starts and stops talking from the microphone level, one frame at a time. While the model
// is speaking the bar is higher and speech must last longer, so its own voice leaking into the mic does not cut it off.
export class Vad {
  floor = 0.005;
  recording = false;
  private startN = 0;
  private lastVoice = 0;
  private t0 = 0;
  private readonly opt: VadOptions;

  constructor(opt: Partial<VadOptions> = {}) {
    this.opt = { silenceMs: 900, maxMs: 30000, ...opt };
  }

  set silenceMs(ms: number) { this.opt.silenceMs = ms; }

  reset(): void {
    this.recording = false;
    this.startN = 0;
  }

  push(rms: number, now: number, playing: boolean): VadEvent | null {
    if (!this.recording && !playing) this.floor = this.floor * 0.97 + Math.min(rms, this.floor * 3 + 0.002) * 0.03;
    const th = Math.max(0.015, this.floor * 4) * (playing && !this.recording ? 2.5 : 1);
    if (!this.recording) {
      if (rms <= th) { this.startN = 0; return null; }
      if (++this.startN < (playing ? 6 : 2)) return null;
      this.recording = true;
      this.startN = 0;
      this.lastVoice = now;
      this.t0 = now;
      return playing ? 'barge' : 'start';
    }
    if (rms > th * 0.6) this.lastVoice = now;
    if (now - this.lastVoice > this.opt.silenceMs || now - this.t0 > this.opt.maxMs) {
      this.recording = false;
      return 'end';
    }
    return null;
  }
}
