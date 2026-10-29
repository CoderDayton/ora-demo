import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Bindings to ffi/orapdf.c (vendored PDFium, embedded in the binary). Bodyless declarations become native calls under scriptc --ffi.
declare function oraPdfOpen(data: Uint8Array): number;
declare function oraPdfRender(index: number, maxPx: number, quality: number): number;
declare function oraPdfCopy(out: Uint8Array): number;
declare function oraPdfRenderRaw(index: number, maxPx: number): number;
declare function oraPdfCopyRaw(out: Uint8Array): number;
declare function oraPdfPageText(index: number): number;
declare function oraPdfCopyText(out: Uint8Array): number;
declare function oraPdfClose(): number;

export const JPEG_QUALITY = 80;
const ERR_LIB = -100;
const ERR_PASSWORD = -4;
const ERR_FORMAT = -3;

function openError(code: number): string {
  if (code === ERR_PASSWORD) return 'password protected';
  if (code === ERR_FORMAT) return 'not a valid PDF';
  if (code === ERR_LIB) return 'the PDF engine could not start';
  return `PDF error ${-code}`;
}

// Renders pages from..to (numbered from 1, clamped to the document) as JPEGs whose longest side is maxPx, handing each
// to onPage as soon as it is encoded. Returns how many were rendered. Throws when the file cannot be opened.
export function renderPages(
  bytes: Uint8Array,
  maxPx: number,
  from: number,
  to: number,
  quality: number,
  onPage: (n: number, jpg: Uint8Array) => void,
): number {
  const count = oraPdfOpen(new Uint8Array(bytes));
  if (count < 0) throw new Error(openError(count));
  let done = 0;
  try {
    for (let p = Math.max(1, from); p <= Math.min(count, to); p++) {
      const n = oraPdfRender(p - 1, maxPx, quality);
      if (n <= 0) throw new Error(`page ${p} could not be rendered`);
      const buf = new Uint8Array(n);
      oraPdfCopy(buf);
      onPage(p, buf);
      done++;
    }
  } finally {
    oraPdfClose();
  }
  return done;
}

export interface PageTexts {
  pages: number;
  text: string[];
}

// The page count (up to maxPages) and each page's text layer. The text only ranks pages for a question; the model
// is always sent page images. A page whose text cannot be read counts as having none.
export function pageTexts(bytes: Uint8Array, maxPages: number): PageTexts {
  const count = oraPdfOpen(new Uint8Array(bytes));
  if (count < 0) throw new Error(openError(count));
  const text: string[] = [];
  try {
    const last = Math.min(count, maxPages);
    for (let i = 0; i < last; i++) {
      const n = oraPdfPageText(i);
      if (n <= 0) {
        text.push('');
        continue;
      }
      const buf = new Uint8Array(n);
      oraPdfCopyText(buf);
      text.push(Buffer.from(buf).toString('utf8'));
    }
  } finally {
    oraPdfClose();
  }
  return { pages: text.length, text };
}

export interface RawPage {
  width: number;
  height: number;
  rgb: Uint8Array;
}

// One page as RGB pixels (3 bytes each, rows top to bottom). Used by tests to check what the renderer actually drew.
export function renderRaw(bytes: Uint8Array, index: number, maxPx: number): RawPage {
  const count = oraPdfOpen(new Uint8Array(bytes));
  if (count < 0) throw new Error(openError(count));
  try {
    const dims = oraPdfRenderRaw(index, maxPx);
    if (dims < 0) throw new Error(`page ${index + 1} could not be rendered`);
    const width = Math.floor(dims / 8192);
    const height = dims - width * 8192;
    const rgb = new Uint8Array(width * height * 3);
    oraPdfCopyRaw(rgb);
    return { width, height, rgb };
  } finally {
    oraPdfClose();
  }
}

// Entry point of the child process that parses PDFs, so a hostile file can only take down the child.
//   pages <in.pdf> <outDir> <px> <from> <to>  writes <n>.jpg per page, each renamed into place once complete
//   info <in.pdf> <out.json> <maxPages>       writes {"pages": n, "text": [...]} (see pageTexts)
// Returns 0, or 2 after writing the reason to stderr.
export function renderWorker(args: string[]): number {
  const mode = args[0];
  const inFile = args[1];
  const out = args[2];
  if (inFile === undefined || out === undefined) return fail('usage: pages|info <in.pdf> <out> ...');
  try {
    if (mode === 'pages') {
      const px = Number(args[3]),
        from = Number(args[4]),
        to = Number(args[5]);
      if (!(px > 0) || !(from >= 1) || !(to >= from)) return fail('pages: bad page size or range');
      renderPages(new Uint8Array(readFileSync(inFile)), px, from, to, JPEG_QUALITY, (n: number, jpg: Uint8Array) => {
        const f = join(out, `${n}.jpg`);
        const tmp = `${f}.${process.pid}.tmp`;
        writeFileSync(tmp, jpg);
        renameSync(tmp, f);
      });
      return 0;
    }
    if (mode === 'info') {
      const max = Number(args[3]);
      if (!(max > 0)) return fail('info: bad page limit');
      writeFileSync(out, JSON.stringify(pageTexts(new Uint8Array(readFileSync(inFile)), max)));
      return 0;
    }
    return fail(`unknown mode ${mode ?? ''}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function fail(why: string): number {
  process.stderr.write(`${why}\n`);
  return 2;
}
