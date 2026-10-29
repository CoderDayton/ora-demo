// PDF uploads: the page count and text are read before the upload returns; page images are rendered afterwards, in
// child processes so the server keeps answering, and any page that is asked for before it is ready is rendered then.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PageTexts } from './pdfium.ts';
import { JPEG_QUALITY, pageTexts, renderPages } from './pdfium.ts';
import type { DocMeta, Store } from './store.ts';

const WORKER_TIMEOUT_MS = 120_000;
const MAX_WORKERS = 4;
const PAGES_PER_WORKER = 4;
const DEFAULT_PX = 1024;

// Runs `exe --render-pdf ...args` (see renderWorker). Rejects with the worker's own explanation when it fails.
function runWorker(exe: string, args: string[]): Promise<void> {
  return new Promise<void>((ok, fail) => {
    const child = spawn(exe, ['--render-pdf', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => {
      if (err.length < 2000) err += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, WORKER_TIMEOUT_MS);
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) ok();
      else fail(new Error(err.trim() || 'the PDF engine crashed or timed out on this file'));
    });
  });
}

export class PageRenderer {
  private store: Store;
  private exe: string | null;
  private jobs = new Map<number, Promise<void>>();
  private single = new Map<string, Promise<void>>();

  // exe: this binary, which renders when started with --render-pdf. Null renders in this process (tests, dev).
  constructor(store: Store, exe: string | null) {
    this.store = store;
    this.exe = exe;
  }

  // Page count and text layer. Throws when the file cannot be read as a PDF.
  async info(bytes: Uint8Array, maxPages: number): Promise<PageTexts> {
    if (this.exe === null) return pageTexts(bytes, maxPages);
    const dir = mkdtempSync(join(tmpdir(), 'ora-pdf-'));
    try {
      writeFileSync(join(dir, 'in.pdf'), bytes);
      await runWorker(this.exe, ['info', join(dir, 'in.pdf'), join(dir, 'info.json'), String(maxPages)]);
      const v = JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8')) as Record<string, unknown>;
      const text = Array.isArray(v.text) ? v.text.map(t => (typeof t === 'string' ? t : '')) : [];
      return { pages: text.length, text };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Renders every page in the background, split across a few workers so the first pages are ready soonest.
  start(docId: number): Promise<void> {
    const doc = this.store.getDoc(docId);
    const pages = doc?.pages ?? 0;
    if (!doc || pages < 1) return Promise.resolve();
    const workers = Math.min(MAX_WORKERS, Math.ceil(pages / PAGES_PER_WORKER));
    const per = Math.ceil(pages / workers);
    const parts: Promise<void>[] = [];
    for (let from = 1; from <= pages; from += per) parts.push(this.render(doc, from, Math.min(pages, from + per - 1)));
    const job = this.settle(docId, parts);
    this.jobs.set(docId, job);
    return job;
  }

  private async settle(docId: number, parts: Promise<void>[]): Promise<void> {
    try {
      await Promise.all(parts);
    } catch (e) {
      // Pages that failed here are retried one at a time when they are asked for.
      console.warn(`pdf ${docId}: background render stopped: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.jobs.delete(docId);
    }
  }

  // Resolves when the background render of a document has finished.
  idle(docId: number): Promise<void> {
    return this.jobs.get(docId) ?? Promise.resolve();
  }

  // A page's JPEG, rendered now if it is not ready yet. Null for a page the document does not have.
  async page(docId: number, n: number): Promise<Uint8Array | null> {
    const doc = this.store.getDoc(docId);
    if (doc?.kind !== 'pdf' || !(n >= 1 && n <= (doc.pages ?? 0))) return null;
    const ready = this.store.readPage(docId, n);
    if (ready) return ready;
    const key = `${docId}:${n}`;
    let p = this.single.get(key);
    if (!p) {
      p = this.renderOne(doc, n, key);
      this.single.set(key, p);
    }
    await p;
    return this.store.readPage(docId, n);
  }

  private async renderOne(doc: DocMeta, n: number, key: string): Promise<void> {
    try {
      await this.render(doc, n, n);
    } finally {
      this.single.delete(key);
    }
  }

  private async render(doc: DocMeta, from: number, to: number): Promise<void> {
    const px = doc.px ?? DEFAULT_PX;
    const file = this.store.pdfFile(doc.id);
    const dir = this.store.pageDir(doc.id);
    if (this.exe !== null && file !== null && dir !== null) {
      await runWorker(this.exe, ['pages', file, dir, String(px), String(from), String(to)]);
      return;
    }
    const bytes = this.store.readPdf(doc.id);
    if (!bytes) throw new Error('the PDF source is missing');
    renderPages(bytes, px, from, to, JPEG_QUALITY, (p: number, jpg: Uint8Array) => this.store.putPage(doc.id, p, jpg));
  }
}

// Stores a PDF upload: refuses an unreadable file, indexes each page's text, keeps the source, and starts rendering.
export async function ingestPdf(
  store: Store,
  renderer: PageRenderer,
  chatId: number,
  name: string,
  bytes: Uint8Array,
  px: number,
  maxPages: number,
): Promise<DocMeta> {
  let info: PageTexts;
  try {
    info = await renderer.info(bytes, maxPages);
  } catch (e) {
    throw new Error(`${name}: unreadable PDF (${e instanceof Error ? e.message : String(e)})`);
  }
  if (info.pages < 1) throw new Error(`${name}: the PDF has no pages`);
  const meta = store.addDoc(chatId, name, 'pdf', info.pages, []);
  store.addPageText(meta.id, info.text);
  store.savePdf(meta.id, bytes, px);
  void renderer.start(meta.id);
  return store.getDoc(meta.id) as DocMeta;
}
