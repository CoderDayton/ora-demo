import assert from 'node:assert';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkText, extractDoc, isPdf, renderPdf } from '../src/server/docs.ts';
import { renderRaw, renderWorker } from '../src/server/pdfium.ts';

function same(actual: unknown, expected: unknown): void {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function tinyPdf(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
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
  return enc(out);
}

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return '';
}

test('chunkText: empty input gives no chunks', () => {
  same(chunkText('  \n\n ', 1200, 150), []);
});

test('chunkText: short text is one chunk', () => {
  same(chunkText('hello world', 1200, 150), ['hello world']);
});

test('chunkText: long text splits under the size limit and keeps every word', () => {
  const words: string[] = [];
  for (let i = 0; i < 2000; i++) words.push(`w${i}`);
  const chunks = chunkText(words.join(' '), 500, 50);
  assert.ok(chunks.length > 5);
  const seen = new Set<string>();
  for (const c of chunks) {
    assert.ok(c.length <= 500);
    for (const w of c.split(/\s+/)) seen.add(w);
  }
  for (const w of words) assert.ok(seen.has(w));
});

test('chunkText: prefers paragraph boundaries', () => {
  const a = 'a'.repeat(300);
  const b = 'b'.repeat(300);
  same(chunkText(`${a}\n\n${b}`, 400, 0), [a, b]);
});

test('extractDoc: plain text', async () => {
  const d = await extractDoc('notes.md', enc('# Title\n\nbody'));
  same(d.kind, 'text');
  same(d.text, '# Title\n\nbody');
});

test('extractDoc: rejects binary data that is not a PDF', async () => {
  const msg = await failure(extractDoc('x.bin', new Uint8Array([1, 2, 0, 3, 0, 255])));
  assert.ok(/binary|unsupported/i.test(msg));
});

test('isPdf recognises the magic bytes only', () => {
  assert.ok(isPdf(tinyPdf('x')));
  assert.ok(!isPdf(enc('hello world')));
});

test('extractDoc: refuses PDFs, which are rendered to images instead', async () => {
  const msg = await failure(extractDoc('a.pdf', tinyPdf('Hello')));
  assert.ok(/renderPdf|image/i.test(msg));
});

test('renderPdf: one JPEG per page, scaled to the requested size', async () => {
  const pages = await renderPdf('a.pdf', tinyPdf('Hello PDF world'), 512, 50);
  same(pages.length, 1);
  const p = pages[0] as Uint8Array;
  same([p[0], p[1]], [0xff, 0xd8]);
  assert.ok(p.length > 500);
});

test('renderPdf: respects the page limit', async () => {
  const pages = await renderPdf('a.pdf', tinyPdf('Hello'), 256, 0);
  same(pages.length, 0);
});

test('renderPdf: rejects data that is not a readable PDF', async () => {
  const msg = await failure(renderPdf('bad.pdf', enc('%PDF-1.4\nnot really a pdf'), 512, 50));
  assert.ok(/unreadable|pdf/i.test(msg));
});

test('renderWorker: writes numbered JPEGs and returns 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ora-worker-'));
  writeFileSync(join(dir, 'in.pdf'), tinyPdf('Worker page'));
  same(renderWorker([join(dir, 'in.pdf'), dir, '384', '5']), 0);
  const jpgs = readdirSync(dir).filter(n => n.endsWith('.jpg'));
  same(jpgs, ['0000.jpg']);
  const b = readFileSync(join(dir, '0000.jpg'));
  same([b[0], b[1]], [0xff, 0xd8]);
});

test('renderWorker: an unreadable PDF returns 2 and explains in error.txt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ora-worker-'));
  writeFileSync(join(dir, 'in.pdf'), enc('%PDF-1.4\nnot really a pdf'));
  same(renderWorker([join(dir, 'in.pdf'), dir, '384', '5']), 2);
  assert.ok(existsSync(join(dir, 'error.txt')));
  assert.ok(readFileSync(join(dir, 'error.txt'), 'utf8').length > 0);
});

test('renderWorker: missing or invalid arguments return 2', () => {
  same(renderWorker(['only-one']), 2);
});

// A page with only two filled boxes, so any misplaced, smeared or colour-swapped pixel is detectable.
function boxPdf(): Uint8Array {
  const stream = '0 g 400 100 150 150 re f 1 0 0 rg 72 100 100 100 re f';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
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
  return enc(out);
}

test('renderRaw: boxes land where the page puts them, in the right colours, with nothing stray', () => {
  const r = renderRaw(boxPdf(), 0, 1024);
  same([r.width, r.height], [791, 1024]);
  const s = 1024 / 792;
  const box = (x0: number, y0: number, x1: number, y1: number): number[] =>
    [Math.round(x0 * s), Math.round((792 - y1) * s), Math.round(x1 * s), Math.round((792 - y0) * s)];
  const black = box(400, 100, 550, 250);
  const red = box(72, 100, 172, 200);
  const px = (x: number, y: number): number[] => {
    const i = (y * r.width + x) * 3;
    return [r.rgb[i] as number, r.rgb[i + 1] as number, r.rgb[i + 2] as number];
  };
  const within = (x: number, y: number, b: number[], pad: number): boolean =>
    x >= (b[0] as number) - pad && x < (b[2] as number) + pad && y >= (b[1] as number) - pad && y < (b[3] as number) + pad;

  let blackHits = 0, blackTotal = 0, redHits = 0, redTotal = 0, stray = 0;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const [R, G, B] = px(x, y) as [number, number, number];
      if (within(x, y, black, 0)) { blackTotal++; if (R < 40 && G < 40 && B < 40) blackHits++; }
      else if (within(x, y, red, 0)) { redTotal++; if (R > 215 && G < 40 && B < 40) redHits++; }
      else if (!within(x, y, black, 4) && !within(x, y, red, 4) && Math.min(R, G, B) < 200) stray++;
    }
  }
  assert.ok(blackHits / blackTotal > 0.99, `black box ${blackHits}/${blackTotal}`);
  assert.ok(redHits / redTotal > 0.99, `red box ${redHits}/${redTotal}`);
  same(stray, 0);
});
