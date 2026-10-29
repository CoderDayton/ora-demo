import assert from 'node:assert';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Cancel, callLlama } from '../../src/server/llm/llama.ts';

test('a request that dies before any reply is sent once more', async () => {
  let seen = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      seen++;
      if (seen === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>(ok => {
    server.listen(18820, '127.0.0.1', () => ok());
  });
  try {
    const r = await callLlama(18820, 'POST', '/x', { a: 1 }, null, new Cancel());
    assert.equal(JSON.stringify(r), '{"ok":true}');
    assert.equal(seen, 2);
  } finally {
    server.close();
  }
});

test('a server that never answers is reported after one retry, not retried forever', async () => {
  let seen = 0;
  const server = createServer((req: IncomingMessage) => {
    req.resume();
    req.on('end', () => {
      seen++;
      req.socket.destroy();
    });
  });
  await new Promise<void>(ok => {
    server.listen(18821, '127.0.0.1', () => ok());
  });
  try {
    let failed = false;
    try {
      await callLlama(18821, 'POST', '/x', { a: 1 }, null, new Cancel());
    } catch {
      failed = true;
    }
    assert.ok(failed);
    assert.equal(seen, 2);
  } finally {
    server.close();
  }
});
