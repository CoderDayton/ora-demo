import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ingestPdf, PageRenderer } from '../../src/server/docs/pages.ts';
import { renderWorker } from '../../src/server/docs/pdfium.ts';
import { openStore } from '../../src/server/store/store.ts';

// Like the server binary, this test binary renders pages when started as a worker, so the child path runs for real.
if (process.argv[2] === '--render-pdf') process.exit(renderWorker(process.argv.slice(3)));

function same(actual: unknown, expected: unknown): void {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

// One page per entry, each with its words in large type.
// Objects: 1 catalog, 2 page tree, 3 font, then a page and its content stream for each entry.
function pdf(pages: string[]): Uint8Array {
  const kids: string[] = [];
  const body: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = 4 + i * 2;
    const stream = `BT /F1 24 Tf 72 700 Td (${pages[i]}) Tj ET 0.2 g 72 100 400 400 re f`;
    kids.push(`${page} 0 R`);
    body.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    body.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...body,
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const isJpeg = (b: Uint8Array | null): boolean => b !== null && b[0] === 0xff && b[1] === 0xd8;

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return '';
}

for (const mode of ['in-process', 'child']) {
  const exe = mode === 'child' ? process.execPath : null;

  test(`${mode}: ingesting a pdf indexes page text and renders every page`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ora-pages-'));
    try {
      const db = openStore(dir);
      const c = db.createChat('');
      const r = new PageRenderer(db, exe);
      const meta = await ingestPdf(db, r, c.id, 'a.pdf', pdf(['alpha page', 'bravo page', 'charlie page']), 512, 200);
      same([meta.kind, meta.pages, meta.px], ['pdf', 3, 512]);
      same(db.searchPages(c.id, 'bravo', 1), [{ docId: meta.id, page: 2 }]);
      await r.idle(meta.id);
      for (const n of [1, 2, 3]) assert.ok(isJpeg(db.readPage(meta.id, n)), `page ${n}`);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${mode}: a page missing from disk is rendered when it is asked for`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ora-pages-'));
    try {
      const db = openStore(dir);
      const c = db.createChat('');
      const r = new PageRenderer(db, exe);
      const meta = await ingestPdf(db, r, c.id, 'a.pdf', pdf(['one', 'two']), 400, 200);
      await r.idle(meta.id);
      rmSync(db.pageFile(meta.id, 2) as string);
      assert.ok(isJpeg(await r.page(meta.id, 2)));
      assert.ok(existsSync(db.pageFile(meta.id, 2) as string));
      same(await r.page(meta.id, 3), null);
      same(await r.page(meta.id, 0), null);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${mode}: an unreadable pdf is refused and nothing is stored`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ora-pages-'));
    try {
      const db = openStore(dir);
      const c = db.createChat('');
      const r = new PageRenderer(db, exe);
      const msg = await failure(ingestPdf(db, r, c.id, 'bad.pdf', new TextEncoder().encode('%PDF-1.4\nnot really a pdf'), 512, 200));
      assert.ok(/bad\.pdf/.test(msg) && /unreadable/i.test(msg), msg);
      same(db.docs(c.id), []);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('child: rendering a large pdf leaves the event loop free', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ora-pages-'));
  try {
    const db = openStore(dir);
    const c = db.createChat('');
    const r = new PageRenderer(db, process.execPath);
    const words: string[] = [];
    for (let i = 0; i < 40; i++) words.push(`page number ${i + 1}`);
    let last = Date.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = Date.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 5);
    const t0 = Date.now();
    const meta = await ingestPdf(db, r, c.id, 'big.pdf', pdf(words), 2048, 200);
    await r.idle(meta.id);
    const took = Date.now() - t0;
    clearInterval(tick);
    for (let n = 1; n <= 40; n++) assert.ok(isJpeg(db.readPage(meta.id, n)), `page ${n}`);
    assert.ok(worst < 100, `event loop blocked for ${worst} ms during a ${took} ms render`);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
