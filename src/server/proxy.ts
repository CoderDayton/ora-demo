import { request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Forwards /llama/* to llama-server, streaming both ways.
export function proxy(req: IncomingMessage, res: ServerResponse, port: number): void {
  const fwd: Record<string, string> = {};
  for (const k of Object.keys(req.headers)) {
    const v = req.headers[k];
    if (typeof v === 'string' && k !== 'host' && k !== 'origin' && k !== 'referer') fwd[k] = v;
  }
  fwd.host = `127.0.0.1:${port}`;
  const up = request({
    host: '127.0.0.1', port, method: req.method, headers: fwd,
    path: (req.url ?? '/').replace(/^\/llama/, '') || '/',
  }, r => {
    // A hang-up on either side surfaces as an 'error' event; unhandled, it would take the whole server down.
    r.on('error', () => res.destroy());
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'llama-server is not reachable' } }));
  });
  req.on('error', () => up.destroy());
  res.on('close', () => up.destroy());
  req.pipe(up);
}
