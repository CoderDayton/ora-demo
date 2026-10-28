import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Bindings to ffi/orapdf.c (vendored PDFium, embedded in the binary). Bodyless declarations become native calls under scriptc --ffi.
declare function oraPdfOpen(data: Uint8Array): number;
declare function oraPdfRender(index: number, maxPx: number, quality: number): number;
declare function oraPdfCopy(out: Uint8Array): number;
declare function oraPdfRenderRaw(index: number, maxPx: number): number;
declare function oraPdfCopyRaw(out: Uint8Array): number;
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

// Renders up to maxPages pages as JPEGs whose longest side is maxPx. Throws when the file cannot be opened.
export function renderPages(bytes: Uint8Array, maxPx: number, maxPages: number, quality: number): Uint8Array[] {
  const count = oraPdfOpen(new Uint8Array(bytes));
  if (count < 0) throw new Error(openError(count));
  const pages: Uint8Array[] = [];
  try {
    const last = Math.min(count, maxPages);
    for (let i = 0; i < last; i++) {
      const n = oraPdfRender(i, maxPx, quality);
      if (n <= 0) throw new Error(`page ${i + 1} could not be rendered`);
      const buf = new Uint8Array(n);
      oraPdfCopy(buf);
      pages.push(buf);
    }
  } finally {
    oraPdfClose();
  }
  return pages;
}

export interface RawPage { width: number; height: number; rgb: Uint8Array }

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

// Entry point of the child process that does the actual rendering, so a hostile PDF can only take down the child.
// args: input pdf, output directory, longest side in px, page limit. Writes 0000.jpg, 0001.jpg, ... or error.txt.
export function renderWorker(args: string[]): number {
  const inFile = args[0];
  const outDir = args[1];
  const maxPx = Number(args[2]);
  const maxPages = Number(args[3]);
  if (inFile === undefined || outDir === undefined || !(maxPx > 0) || !(maxPages > 0)) return 2;
  try {
    const pages = renderPages(new Uint8Array(readFileSync(inFile)), maxPx, maxPages, JPEG_QUALITY);
    for (let i = 0; i < pages.length; i++) writeFileSync(join(outDir, `${String(i).padStart(4, '0')}.jpg`), pages[i] as Uint8Array);
    return 0;
  } catch (e) {
    writeFileSync(join(outDir, 'error.txt'), e instanceof Error ? e.message : String(e));
    return 2;
  }
}
