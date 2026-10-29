import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Cancel } from '../../src/server/llm/llama.ts';
import { openStore } from '../../src/server/store/store.ts';
import { Approvals } from '../../src/server/tools/approvals.ts';
import { definitions, find, summarize } from '../../src/server/tools/catalog.ts';
import { readDocument, searchDocuments } from '../../src/server/tools/docs.ts';
import { listDir, readFile, resolveInside, runCommand, writeFile } from '../../src/server/tools/system.ts';
import { calculate, currentTime } from '../../src/server/tools/utility.ts';
import { checkUrl, fetchPage, htmlToText, isPrivateIp, searchWeb } from '../../src/server/tools/web.ts';

function same(actual: unknown, expected: unknown): void {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}
const names = (groups: string[]): string[] => definitions(groups).map(d => String((d.function as Record<string, unknown>).name));
const tmp = (): string => mkdtempSync(join(tmpdir(), 'ora-tools-'));

test('definitions list only the enabled groups, in the OpenAI tool format', () => {
  same(names([]), []);
  assert.ok(names(['docs']).includes('search_documents'));
  assert.ok(!names(['docs']).includes('run_command'));
  assert.ok(names(['system']).includes('run_command'));
  const d = definitions(['utility'])[0] as Record<string, unknown>;
  same(d.type, 'function');
  const fn = d.function as Record<string, unknown>;
  assert.equal(typeof fn.description, 'string');
  same((fn.parameters as Record<string, unknown>).type, 'object');
});

test('only system tools ask first; web tools do not', () => {
  assert.equal(find('run_command')?.ask, true);
  assert.equal(find('write_file')?.ask, true);
  assert.equal(find('web_fetch')?.ask, false);
  assert.equal(find('search_documents')?.ask, false);
  same(find('nope'), null);
});

test('summarize names the action and its main argument', () => {
  assert.equal(summarize('run_command', { command: 'ls -la' }), 'Run the command: ls -la');
  assert.equal(summarize('write_file', { path: 'notes/a.txt', content: 'x' }), 'Write the file notes/a.txt');
  assert.equal(summarize('web_fetch', { url: 'https://example.com' }), 'Fetch https://example.com');
  assert.equal(summarize('search_documents', { query: 'revenue' }), 'Search the documents for "revenue"');
});

test('calculate evaluates arithmetic without eval', () => {
  assert.equal(calculate('2+3*4'), '14');
  assert.equal(calculate('(1+2)^3'), '27');
  assert.equal(calculate('-4 + 10 / 4'), '-1.5');
  assert.equal(calculate('7 % 3'), '1');
  assert.throws(() => calculate('1/0'), /division by zero/);
  assert.throws(() => calculate('process.exit(1)'), /not a valid expression/);
  assert.throws(() => calculate('2 +'), /not a valid expression/);
});

test('currentTime gives an ISO timestamp', () => {
  assert.match(currentTime(), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
});

test('isPrivateIp covers loopback, private, link-local and mapped addresses', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '192.168.0.9',
    '172.16.5.5',
    '172.31.255.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});

test('checkUrl accepts public http(s) and rejects everything else', () => {
  assert.equal(checkUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  for (const bad of [
    'file:///etc/passwd',
    'ftp://example.com',
    'http://user:pw@example.com',
    'http://localhost/',
    'http://127.0.0.1:8099/props',
    'http://[::1]/',
    'http://192.168.1.1/',
    'not a url',
  ]) {
    assert.throws(() => checkUrl(bad));
  }
});

test('htmlToText drops scripts and styles and keeps the visible text', () => {
  const t = htmlToText(
    '<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>One &amp; two</p></body></html>',
  );
  assert.equal(t.includes('alert'), false);
  assert.equal(t.includes('p{}'), false);
  assert.match(t, /Title/);
  assert.match(t, /One & two/);
});

test('searchWeb reads results from the configured service; fetchPage refuses local addresses', async () => {
  const seen: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Ora', url: 'https://example.com/ora', content: 'A demo.' }] }));
  });
  await new Promise<void>(ok => {
    server.listen(18791, '127.0.0.1', () => ok());
  });
  try {
    const out = await searchWeb('http://127.0.0.1:18791/search?format=json&q={q}', 'hello world');
    assert.match(out, /Ora\nhttps:\/\/example\.com\/ora\nA demo\./);
    assert.match(seen[0] ?? '', /q=hello%20world/);
    await assert.rejects(searchWeb('', 'x'), /not configured/);
    await assert.rejects(fetchPage('http://127.0.0.1:18791/secret'), /private/);
    assert.equal(seen.length, 1);
  } finally {
    server.close();
  }
});

test('resolveInside keeps paths in the work folder', () => {
  const root = tmp();
  mkdirSync(join(root, 'sub'));
  assert.equal(resolveInside(root, 'sub/a.txt').endsWith('/sub/a.txt'), true);
  assert.throws(() => resolveInside(root, '../x'), /outside the work folder/);
  assert.throws(() => resolveInside(root, '/etc/passwd'), /outside the work folder/);
  const outside = tmp();
  symlinkSync(outside, join(root, 'link'));
  assert.throws(() => resolveInside(root, 'link/secret.txt'), /outside the work folder/);
});

test('file tools read, write and list inside the work folder', () => {
  const root = tmp();
  assert.match(writeFile(root, 'a/b.txt', 'hello'), /5 bytes/);
  assert.equal(readFileSync(join(root, 'a/b.txt'), 'utf8'), 'hello');
  assert.equal(readFile(root, 'a/b.txt'), 'hello');
  assert.equal(listDir(root, 'a'), 'b.txt');
  assert.match(listDir(root, '.'), /a\//);
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(50000));
  assert.ok(readFile(root, 'big.txt').length < 21000);
  assert.throws(() => readFile(root, 'missing.txt'));
});

test('runCommand returns output and the exit code', async () => {
  const root = tmp();
  const ok = await runCommand('echo hi', root, 5000, new Cancel());
  assert.match(ok, /hi/);
  assert.match(ok, /exit code 0/);
  const bad = await runCommand('echo oops >&2; exit 3', root, 5000, new Cancel());
  assert.match(bad, /oops/);
  assert.match(bad, /exit code 3/);
});

test('runCommand stops a command that runs too long', async () => {
  const out = await runCommand('sleep 5', tmp(), 200, new Cancel());
  assert.match(out, /timed out/);
});

test('runCommand caps what it returns', async () => {
  const out = await runCommand('head -c 100000 /dev/zero | tr "\\0" x', tmp(), 5000, new Cancel());
  assert.ok(out.length < 21000);
  assert.match(out, /truncated/);
});

test('approvals resolve on an answer and deny when cancelled', async () => {
  const a = new Approvals();
  const p = a.wait('t1', new Cancel());
  assert.equal(a.resolve('t1', 'allow'), true);
  assert.equal(await p, 'allow');
  assert.equal(a.resolve('t1', 'allow'), false);
  assert.equal(a.resolve('unknown', 'deny'), false);
  const ctl = new Cancel();
  const q = a.wait('t2', ctl);
  ctl.cancel();
  assert.equal(await q, 'deny');
  assert.equal(a.pending().length, 0);
});

test('document tools search and read the chat documents', () => {
  const store = openStore(tmp());
  const chat = store.createChat('t');
  store.addDoc(chat.id, 'report.txt', 'text', null, ['Revenue grew 12 percent in 2024.', 'Costs fell slightly in the second half.']);
  const found = searchDocuments(store, chat.id, 'revenue', 3);
  assert.match(found, /report\.txt/);
  assert.match(found, /Revenue grew/);
  assert.match(searchDocuments(store, chat.id, 'zebra', 3), /no matches/i);
  const doc = store.docs(chat.id)[0];
  assert.ok(doc);
  assert.match(readDocument(store, chat.id, doc?.name ?? '', 1), /Costs fell/);
  assert.throws(() => readDocument(store, chat.id, 'nope.txt', 0), /no document/i);
  store.close();
});
