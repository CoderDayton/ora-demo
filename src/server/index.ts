// Ora controller: serves the web app, owns chats/documents (SQLite), starts/stops llama-server and proxies /llama/*.
// Local only: binds 127.0.0.1 and rejects foreign Host/Origin headers.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { ASSETS } from './assets.gen.ts';
import { buildContext } from './context.ts';
import { configPath, loadConfig } from './config.ts';
import { chunkText, extractDoc, isPdf, isolatePdfRendering, renderPdf } from './docs.ts';
import { Engine, prepareModelsDir, scanModels } from './engine.ts';
import { renderWorker } from './pdfium.ts';
import { proxy } from './proxy.ts';
import { openStore } from './store.ts';

// Child mode: PDFium parses untrusted files, so uploads are rendered by this same binary in a separate process.
if (process.argv[2] === '--render-pdf') process.exit(renderWorker(process.argv.slice(3)));
isolatePdfRendering(process.execPath);

const cfgFile = configPath(process.env);
const config = loadConfig(process.env, existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8') : null);
const PORT = config.port;
const LLAMA_PORT = config.llamaPort;
const LLAMA_BIN = config.llamaServer;
const MODELS_DIR = config.modelsDir;
const DIST = config.distDir === null ? null : resolve(config.distDir);
const DATA = resolve(config.dataDir);
const MAX_UPLOAD = 64 * 1024 * 1024;
const MAX_DOC_CHARS = 8_000_000;
const PAGE_PX = 1024;
const MAX_PAGES = 200;
const DEFAULT_BUDGET = 24000;
const ALLOWED_HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
};

prepareModelsDir(MODELS_DIR);
const store = openStore(DATA);
const engine = new Engine(LLAMA_BIN, LLAMA_PORT, MODELS_DIR, config.llamaArgs);

class HttpError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise<Buffer>((ok, fail) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let dead = false;
    req.on('data', (c: Buffer) => {
      if (dead) return;
      n += c.length;
      if (n > limit) {
        dead = true;
        fail(new HttpError(413, 'body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!dead) ok(Buffer.concat(chunks)); });
    req.on('error', (e: Error) => { if (!dead) fail(e); });
  });
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const raw = (await readBody(req, limit)).toString('utf8');
  if (!raw.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'expected a JSON object');
  return v as Record<string, unknown>;
}

function serveStatic(pathname: string, res: ServerResponse): void {
  let rel = 'index.html';
  if (pathname !== '/') {
    try {
      rel = decodeURIComponent(pathname.slice(1));
    } catch {
      throw new HttpError(400, 'bad path');
    }
  }
  const headers = { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-store' };
  if (DIST !== null) {
    const file = resolve(DIST, rel);
    if (file.startsWith(DIST + sep) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, headers);
      res.end(readFileSync(file));
      return;
    }
  } else if (Object.hasOwn(ASSETS, rel)) {
    res.writeHead(200, headers);
    res.end(ASSETS[rel]);
    return;
  }
  throw new HttpError(404, 'not found');
}

function chatId(raw: string): number {
  const id = Number(raw);
  if (!store.getChat(id)) throw new HttpError(404, 'no such chat');
  return id;
}

// A missing or corrupt memory file just means the persona starts fresh.
function readPersona(file: string): unknown {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function contentOk(v: unknown): boolean {
  return typeof v === 'string' || Array.isArray(v);
}

async function chatRoute(req: IncomingMessage, res: ServerResponse, url: URL, m: RegExpMatchArray): Promise<void> {
  const method = req.method ?? 'GET';
  const sub = m[2] ?? '';
  if (!m[1]) {
    if (method === 'GET') return send(res, 200, store.listChats());
    if (method === 'POST') {
      const b = await readJson(req, 4096);
      return send(res, 200, store.createChat(typeof b.title === 'string' ? b.title.slice(0, 120) : ''));
    }
    throw new HttpError(405, 'method not allowed');
  }
  const id = chatId(m[1]);

  if (!sub) {
    if (method === 'GET') return send(res, 200, { chat: store.getChat(id), messages: store.messages(id), docs: store.docs(id) });
    if (method === 'PATCH') {
      const b = await readJson(req, 4096);
      if (typeof b.title !== 'string' || !b.title.trim()) throw new HttpError(400, 'title required');
      store.renameChat(id, b.title.trim().slice(0, 120));
      return send(res, 200, store.getChat(id));
    }
    if (method === 'DELETE') { store.deleteChat(id); return send(res, 200, { ok: true }); }
    throw new HttpError(405, 'method not allowed');
  }

  if (sub === 'messages' && method === 'POST') {
    const b = await readJson(req, 32 * 1024 * 1024);
    if ((b.role !== 'user' && b.role !== 'assistant') || !contentOk(b.content)) throw new HttpError(400, 'role and content required');
    return send(res, 200, store.addMessage(id, b.role, b.content));
  }

  if (sub === 'docs' && method === 'POST') {
    const name = (url.searchParams.get('name') ?? 'document').replace(/[\\/]/g, '_').slice(0, 200);
    const body = new Uint8Array(await readBody(req, MAX_UPLOAD));
    if (isPdf(body)) {
      let pages: Uint8Array[];
      try {
        const px = Math.min(2400, Math.max(512, Math.round(Number(url.searchParams.get('px') ?? PAGE_PX)) || PAGE_PX));
        pages = await renderPdf(name, body, px, MAX_PAGES);
      } catch (e) {
        throw new HttpError(422, e instanceof Error ? e.message : String(e));
      }
      const meta = store.addDoc(id, name, 'pdf', pages.length, []);
      store.addPages(meta.id, pages);
      return send(res, 200, meta);
    }
    let ex;
    try {
      ex = await extractDoc(name, body);
    } catch (e) {
      throw new HttpError(422, e instanceof Error ? e.message : String(e));
    }
    if (ex.text.length > MAX_DOC_CHARS) throw new HttpError(413, `${name}: more than ${MAX_DOC_CHARS} characters of text`);
    const chunks = chunkText(ex.text, 1200, 150);
    return send(res, 200, store.addDoc(id, name, ex.kind, null, chunks));
  }

  if (sub === 'context' && method === 'GET') {
    const asked = Number(url.searchParams.get('budget') ?? DEFAULT_BUDGET);
    const budget = Math.min(400000, Math.max(1000, Number.isFinite(asked) ? asked : DEFAULT_BUDGET));
    return send(res, 200, buildContext(store, id, url.searchParams.get('q') ?? '', budget));
  }
  throw new HttpError(404, 'not found');
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = req.headers.host ?? '';
  if (!ALLOWED_HOSTS.includes(host)) throw new HttpError(403, 'bad host');
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) throw new HttpError(403, 'bad origin');
  }
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;

  if (p === '/llama' || p.startsWith('/llama/')) return proxy(req, res, LLAMA_PORT);
  if (!p.startsWith('/api/')) {
    if (method !== 'GET') throw new HttpError(405, 'method not allowed');
    return serveStatic(p, res);
  }

  if (p === '/api/models' && method === 'GET') return send(res, 200, scanModels(MODELS_DIR));
  if (p === '/api/status' && method === 'GET') return send(res, 200, engine.status());
  if (p === '/api/start' && method === 'POST') {
    const b = await readJson(req, 65536);
    try {
      await engine.start({
        model: String(b.model ?? ''), mmproj: String(b.mmproj ?? ''), ctx: Number(b.ctx), reasoning: String(b.reasoning ?? 'off'),
        parallel: Number(b.parallel ?? 2),
      });
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/stop' && method === 'POST') { await engine.stop(); return send(res, 200, { ok: true }); }

  if (p === '/api/persona') {
    const file = join(DATA, 'persona.json');
    if (method === 'GET') return send(res, 200, readPersona(file));
    if (method === 'PUT') {
      writeFileSync(file, JSON.stringify(await readJson(req, 65536)));
      return send(res, 200, { ok: true });
    }
  }

  const cm = p.match(/^\/api\/chats(?:\/(\d+)(?:\/(messages|docs|context))?)?$/);
  if (cm) return chatRoute(req, res, url, cm);

  const pm = p.match(/^\/api\/docs\/(\d+)\/pages\/(\d+)$/);
  if (pm && method === 'GET') {
    const img = store.readPage(Number(pm[1]), Number(pm[2]));
    if (!img) throw new HttpError(404, 'no such page');
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' });
    res.end(Buffer.from(img));
    return;
  }

  const dm = p.match(/^\/api\/docs\/(\d+)$/);
  if (dm && method === 'DELETE') {
    const id = Number(dm[1]);
    if (!store.getDoc(id)) throw new HttpError(404, 'no such document');
    store.deleteDoc(id);
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, 'not found');
}

const server = createServer((req, res) => {
  route(req, res).catch((e: unknown) => {
    const code = e instanceof HttpError ? e.code : 500;
    if (!res.headersSent) send(res, code, { error: e instanceof Error ? e.message : String(e) });
    else res.end();
  });
});

function shutdown(): void {
  engine.kill();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ora on http://127.0.0.1:${PORT}  (llama-server -> :${LLAMA_PORT}, data ${DATA})`);
});
