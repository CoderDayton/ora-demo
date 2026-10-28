import assert from 'node:assert';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { test } from 'node:test';
import { proxy } from '../src/server/proxy.ts';

function listen(s: Server, port: number): Promise<number> {
  return new Promise(ok => s.listen(port, '127.0.0.1', () => ok(port)));
}

function get(port: number, path: string, abortAfterMs = 0): Promise<string> {
  return new Promise((ok, fail) => {
    const r = request({ host: '127.0.0.1', port, path }, res => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString(); });
      res.on('end', () => ok(body));
      res.on('error', () => ok('aborted'));
    });
    r.on('error', (e: Error) => (abortAfterMs ? ok('aborted') : fail(e)));
    r.end();
    if (abortAfterMs) setTimeout(() => r.destroy(), abortAfterMs);
  });
}

test('a client that hangs up mid-stream does not crash the proxy, and the next request still works', async () => {
  // Stands in for llama-server: streams slowly until the connection goes away.
  const upstream = createServer((req, res) => {
    if (req.url === '/health') { res.end('ok'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const t = setInterval(() => res.write('data: {}\n\n'), 20);
    res.on('close', () => clearInterval(t));
  });
  const up = await listen(upstream, 18931);
  const front = createServer((req, res) => proxy(req, res, up));
  const port = await listen(front, 18932);

  assert.strictEqual(await get(port, '/llama/v1/chat/completions', 150), 'aborted');
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(await get(port, '/llama/health'), 'ok');

  front.close();
  upstream.close();
});
