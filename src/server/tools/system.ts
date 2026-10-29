// Shell commands and files inside one work folder. The caller asks the user first; the folder limit and caps hold even so.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Cancel } from '../llm/llama.ts';

const OUT_CAP = 20000;
const WRITE_CAP = 1_000_000;

// The real path of `p` under `root`, symlinks followed, or an error if it leads outside. `p` need not exist yet:
// the nearest existing parent is resolved and the missing rest appended.
export function resolveInside(root: string, p: string): string {
  const base = realpathSync(root);
  let probe = resolve(base, p);
  const rest: string[] = [];
  while (!existsSync(probe)) {
    rest.unshift(probe.slice(dirname(probe).length + 1));
    const up = dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const real = join(realpathSync(probe), ...rest);
  const rel = relative(base, real);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`${p} is outside the work folder`);
  return real;
}

const clip = (s: string): string => (s.length > OUT_CAP ? `${s.slice(0, OUT_CAP)}\n[truncated: ${s.length - OUT_CAP} more characters]` : s);

export function readFile(root: string, p: string): string {
  return clip(readFileSync(resolveInside(root, p), 'utf8'));
}

export function writeFile(root: string, p: string, content: string): string {
  const bytes = Buffer.byteLength(content);
  if (bytes > WRITE_CAP) throw new Error('the file is larger than 1 MB');
  const abs = resolveInside(root, p);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return `Wrote ${bytes} bytes to ${p}`;
}

export function listDir(root: string, p: string): string {
  const abs = resolveInside(root, p || '.');
  const names = readdirSync(abs)
    .sort()
    .map(n => (statSync(join(abs, n)).isDirectory() ? `${n}/` : n));
  return names.length ? clip(names.join('\n')) : '(empty)';
}

// Runs `sh -c command` in its own process group, so a timeout or a cancel stops everything it started.
export function runCommand(command: string, cwd: string, timeoutMs: number, cancel: Cancel): Promise<string> {
  return new Promise<string>(ok => {
    mkdirSync(cwd, { recursive: true });
    const child = spawn('sh', ['-c', command], { cwd: cwd, detached: true });
    let out = '';
    let more = 0;
    let note = '';
    const take = (d: Buffer): void => {
      const s = d.toString();
      if (out.length < OUT_CAP) out += s.slice(0, OUT_CAP - out.length);
      else more += s.length;
      if (out.length + more > OUT_CAP && !note.includes('truncated')) note += '\n[output truncated]';
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const stop = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      note += `\n[timed out after ${Math.round(timeoutMs / 1000)} s]`;
      stop();
    }, timeoutMs);
    cancel.on(stop);
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      ok(`could not start: ${e.message}`);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      ok(`${out}${note}\n[exit code ${code ?? 'none'}]`.trim());
    });
  });
}
