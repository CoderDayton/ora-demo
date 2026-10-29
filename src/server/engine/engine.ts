import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface ModelInfo {
  path: string;
  name: string;
  sizeMB: number;
  mmproj: string[];
}
export interface StartOpts {
  model: string;
  mmproj: string;
  ctx: number;
  reasoning: string;
  parallel: number;
}
export interface EngineStatus {
  state: string;
  model: string | null;
  pid: number | null;
  startedAt: number;
  exit: string | null;
  args: string[];
  logs: string[];
}

const SKIP_DIRS = ['ora', 'public'];

const MODELS_README = `Ora models folder
=================

Drop your GGUF model files in here. Ora scans this folder, and up to two levels
of subfolders, whenever you open the page. There is nothing to register and no
restart is needed: new files simply show up in the engine panel's model list.

What a model needs
------------------
  1. The model file. Any file ending in .gguf.
  2. Optional, for models that can see images or hear audio: a projector file.
     Any .gguf with "mmproj" in its name is treated as a projector.

Text-only models need just the first file. Multimodal models such as LFM3-Omni
need both, and the projector is what turns on image and voice input.

Suggested layout
----------------
One subfolder per model, with its files side by side:

  models/
    lfm3-omni/
      LFM3-Omni-2B-Q8_0.gguf
      mmproj-LFM3-Omni-2B-BF16.gguf
    qwen-7b/
      Qwen-7B-Q4_K_M.gguf

Subfolders are optional. A projector is offered for every model that sits in
the same folder, and you pick it in the engine panel, so keep each multimodal
model's files in their own subfolder to avoid mixing them up.

Folders whose names start with a dot are ignored.

Changing this location
----------------------
Set "modelsDir" in config.json (next to this folder), or set ORA_MODELS_DIR.
Models are not downloaded for you: grab GGUF files from Hugging Face, for
example the LiquidAI/LFM3-Omni-2B-GGUF repository, and put them here.
`;

// Creates the models folder on first run and leaves a README that explains what goes in it.
export function prepareModelsDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const readme = join(dir, 'README.txt');
  if (!existsSync(readme)) writeFileSync(readme, MODELS_README);
}

export function scanModels(root: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const ggufs = names.filter(n => n.endsWith('.gguf'));
    const mmprojs = ggufs.filter(n => /mmproj/i.test(n)).map(n => join(dir, n));
    for (const n of ggufs) {
      if (/mmproj/i.test(n)) continue;
      const p = join(dir, n);
      out.push({ path: p, name: relative(root, p), sizeMB: Math.round(statSync(p).size / 1e6), mmproj: mmprojs });
    }
    if (depth >= 2) return;
    for (const n of names) {
      if (n.startsWith('.') || SKIP_DIRS.includes(n)) continue;
      const sub = join(dir, n);
      let isDir = false;
      try {
        isDir = statSync(sub).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir) walk(sub, depth + 1);
    }
  };
  walk(root, 0);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export class Engine {
  private child: ChildProcess | null = null;
  private state = 'stopped';
  private model: string | null = null;
  private args: string[] = [];
  private startedAt = 0;
  private exit: string | null = null;
  private logs: string[] = [];
  private np = 1;

  private bin: string;
  private port: number;
  private modelsDir: string;
  private extraArgs: string[];
  private signal: (pid: number, sig: string) => void;

  // `signal` sends a signal to a process; tests replace it to observe what would be sent.
  constructor(bin: string, port: number, modelsDir: string, extraArgs: string[], signal?: (pid: number, sig: string) => void) {
    this.bin = bin;
    this.port = port;
    this.modelsDir = modelsDir;
    this.extraArgs = extraArgs;
    this.signal =
      signal ??
      ((pid: number, sig: string): void => {
        process.kill(pid, sig);
      });
  }

  status(): EngineStatus {
    return {
      state: this.state,
      model: this.model,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      exit: this.exit,
      args: this.args,
      logs: this.logs.slice(-60),
    };
  }

  // How many requests llama-server serves at once, each with its own cached prompt.
  slots(): number {
    return this.np;
  }

  private log(line: string): void {
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.shift();
  }

  private async healthLoop(child: ChildProcess): Promise<void> {
    while (this.child === child && this.state === 'starting') {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (r.ok) {
          this.state = 'ready';
          return;
        }
      } catch {
        /* not up yet */
      }
      await new Promise<void>(res => setTimeout(res, 500));
    }
  }

  stop(): Promise<void> {
    const child = this.child;
    if (!child) return Promise.resolve();
    // A child that failed to spawn has no pid and only ever emits 'error'. Pid 0 would signal Ora's own group.
    const pid = child.pid ?? 0;
    if (pid <= 0) {
      if (this.child === child) this.child = null;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      const t = setTimeout(() => this.signal(pid, 'SIGKILL'), 6000);
      const done = (): void => {
        clearTimeout(t);
        resolve();
      };
      child.once('exit', done);
      child.once('error', done);
      this.state = 'stopping';
      try {
        this.signal(pid, 'SIGTERM');
      } catch {
        /* already exited; the exit event resolves */
      }
    });
  }

  async start(o: StartOpts): Promise<void> {
    const m = scanModels(this.modelsDir).find(x => x.path === o.model);
    if (!m) throw new Error('unknown model');
    if (o.mmproj && !m.mmproj.includes(o.mmproj)) throw new Error('unknown mmproj');
    const ctx = Math.round(o.ctx);
    if (!(ctx >= 1024 && ctx <= 131072)) throw new Error('ctx out of range');
    const np = Math.round(o.parallel || 2);
    if (!(np >= 1 && np <= 8)) throw new Error('parallel out of range');

    await this.stop();
    const args = [
      '-m',
      m.path,
      '-ngl',
      '99',
      '-c',
      String(ctx),
      '-np',
      String(np),
      '--kv-unified',
      '--reasoning',
      o.reasoning === 'auto' ? 'auto' : 'off',
      '--metrics',
      '--host',
      '127.0.0.1',
      '--port',
      String(this.port),
    ];
    if (o.mmproj) args.push('--mmproj', o.mmproj);
    args.push(...this.extraArgs);

    this.logs = [];
    this.exit = null;
    this.model = m.name;
    this.np = np;
    this.args = args;
    this.startedAt = Date.now();
    this.state = 'starting';
    const child = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const pump = (stream: NodeJS.ReadableStream | null): void => {
      let buf = '';
      stream?.on('data', (d: Buffer) => {
        buf += d.toString();
        for (;;) {
          const i = buf.indexOf('\n');
          if (i < 0) break;
          this.log(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
    };
    pump(child.stdout);
    pump(child.stderr);
    child.on('error', (e: Error) => {
      this.log(`spawn error: ${e.message}`);
      this.state = 'error';
      this.exit = e.message;
      this.child = null;
    });
    child.on('exit', (code: number | null, sig: string | null) => {
      if (this.child !== child) return;
      this.exit = `code ${code ?? '?'}${sig ? ` signal ${sig}` : ''}`;
      this.state = this.state === 'stopping' || code === 0 ? 'stopped' : 'error';
      this.child = null;
    });
    void this.healthLoop(child);
  }

  kill(): void {
    const pid = this.child?.pid ?? 0;
    if (pid > 0) this.signal(pid, 'SIGTERM');
  }
}
