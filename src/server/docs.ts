import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JPEG_QUALITY, renderPages } from './pdfium.ts';

const WORKER_TIMEOUT_MS = 120_000;
let workerExe: string | null = null;

// Makes renderPdf run PDFium in a child process (this binary started with --render-pdf) instead of in-process.
export function isolatePdfRendering(exe: string): void {
  workerExe = exe;
}

export interface Extracted { kind: 'text'; text: string }

function splitLong(s: string, size: number, overlap: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + size);
    if (end < s.length) {
      const sp = s.lastIndexOf(' ', end);
      if (sp > i + size / 2) end = sp;
    }
    const piece = s.slice(i, end).trim();
    if (piece) out.push(piece);
    if (end >= s.length) break;
    const next = s.indexOf(' ', Math.max(i + 1, end - overlap));
    i = next > 0 && next < end ? next + 1 : end;
  }
  return out;
}

export function chunkText(text: string, size: number, overlap: number): string[] {
  const out: string[] = [];
  let cur = '';
  const flush = (): void => { if (cur) out.push(cur); cur = ''; };
  for (const p of text.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean)) {
    if (p.length > size) { flush(); out.push(...splitLong(p, size, overlap)); continue; }
    if (cur && cur.length + 2 + p.length > size) flush();
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  flush();
  return out;
}

export function isPdf(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
}

// PDFs go to the vision model as page images; only plain text is extracted.
export async function extractDoc(name: string, bytes: Uint8Array): Promise<Extracted> {
  if (isPdf(bytes)) throw new Error(`${name}: PDFs are rendered to images with renderPdf, not extracted as text`);
  if (bytes.subarray(0, 8000).includes(0)) throw new Error(`${name}: binary file, unsupported (use text or PDF)`);
  const text = new TextDecoder().decode(bytes).replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new Error(`${name}: empty`);
  return { kind: 'text', text };
}

// Renders up to maxPages pages as JPEGs whose longest side is maxPx.
export async function renderPdf(name: string, bytes: Uint8Array, maxPx: number, maxPages: number): Promise<Uint8Array[]> {
  if (maxPages <= 0) return [];
  try {
    return workerExe === null ? renderPages(bytes, maxPx, maxPages, JPEG_QUALITY) : renderInChild(workerExe, bytes, maxPx, maxPages);
  } catch (e) {
    throw new Error(`${name}: unreadable PDF (${e instanceof Error ? e.message : String(e)})`);
  }
}

function renderInChild(exe: string, bytes: Uint8Array, maxPx: number, maxPages: number): Uint8Array[] {
  const dir = mkdtempSync(join(tmpdir(), 'ora-pdf-'));
  try {
    writeFileSync(join(dir, 'in.pdf'), bytes);
    try {
      execFileSync(exe, ['--render-pdf', join(dir, 'in.pdf'), dir, String(maxPx), String(maxPages)], { stdio: 'ignore', timeout: WORKER_TIMEOUT_MS });
    } catch {
      const why = existsSync(join(dir, 'error.txt')) ? readFileSync(join(dir, 'error.txt'), 'utf8') : 'the PDF engine crashed or timed out on this file';
      throw new Error(why);
    }
    const files = readdirSync(dir).filter(n => n.endsWith('.jpg')).sort();
    if (!files.length) throw new Error('no pages rendered');
    return files.map(f => new Uint8Array(readFileSync(join(dir, f))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
