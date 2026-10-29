// Calls to the llama-server this process started on 127.0.0.1.

import type { IncomingMessage } from 'node:http';
import { request } from 'node:http';

export type Json = Record<string, unknown>;

export const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// Stops a request in flight. Callbacks registered after cancel() run at once.
export class Cancel {
  cancelled = false;
  private fns: (() => void)[] = [];

  on(fn: () => void): void {
    if (this.cancelled) fn();
    else this.fns.push(fn);
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const fn of this.fns.splice(0)) fn();
  }
}

function errorMessage(raw: string): string {
  try {
    const e = obj(JSON.parse(raw)).error;
    if (typeof e === 'string') return e;
    const m = obj(e).message;
    return typeof m === 'string' ? m : '';
  } catch {
    return raw.trim().slice(0, 300);
  }
}

// Hands each complete `data:` event in buf to onEvent and returns the unfinished rest.
function drainEvents(buf: string, onEvent: (e: Json) => void, cancel: Cancel): string {
  let rest = buf;
  for (let i = rest.indexOf('\n\n'); i >= 0; i = rest.indexOf('\n\n')) {
    const ev = rest.slice(0, i);
    rest = rest.slice(i + 2);
    for (const line of ev.split('\n')) {
      const payload = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (payload && payload !== '[DONE]' && !cancel.cancelled) onEvent(obj(JSON.parse(payload)));
    }
  }
  return rest;
}

// With onEvent the reply is read as server-sent events, one parsed object per event, and resolves to {} at the end;
// otherwise it resolves to the parsed reply. A cancelled call resolves with what it had. An error status rejects
// with llama-server's own message.
export function callLlama(
  port: number,
  method: string,
  path: string,
  body: Json | null,
  onEvent: ((e: Json) => void) | null,
  cancel: Cancel,
): Promise<Json> {
  return new Promise<Json>((ok, fail) => {
    const data = body === null ? '' : JSON.stringify(body);
    const hdrs: Record<string, string> =
      body === null ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) };
    let settled = false;
    const done = (v: Json | null, e: Error | null): void => {
      if (settled) return;
      settled = true;
      if (e) fail(e);
      else ok(v ?? {});
    };
    const req = request({ host: '127.0.0.1', port: port, method: method, path: path, headers: hdrs }, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const good = status >= 200 && status < 300;
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        buf += d;
        if (good && onEvent) buf = drainEvents(buf, onEvent, cancel);
      });
      res.on('end', () => {
        if (!good) {
          done(null, new Error(errorMessage(buf) || `llama-server answered ${status}`));
          return;
        }
        if (onEvent) {
          done({}, null);
          return;
        }
        try {
          done(obj(JSON.parse(buf)), null);
        } catch {
          done(null, new Error('llama-server sent an unreadable reply'));
        }
      });
      res.on('error', () => done({}, cancel.cancelled ? null : new Error('llama-server closed the connection')));
      res.on('close', () => done({}, cancel.cancelled ? null : new Error('llama-server closed the connection')));
    });
    req.on('error', () => done({}, cancel.cancelled ? null : new Error('llama-server is not reachable')));
    cancel.on(() => req.destroy());
    req.end(data);
  });
}
