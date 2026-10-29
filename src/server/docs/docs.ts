// Text documents. PDFs are handled in pages.ts.
export interface Extracted {
  kind: 'text';
  text: string;
}

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
  const flush = (): void => {
    if (cur) out.push(cur);
    cur = '';
  };
  for (const p of text
    .split(/\n\s*\n/)
    .map(x => x.trim())
    .filter(Boolean)) {
    if (p.length > size) {
      flush();
      out.push(...splitLong(p, size, overlap));
      continue;
    }
    if (cur && cur.length + 2 + p.length > size) flush();
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  flush();
  return out;
}

const MIN_OVERLAP = 16;
const MAX_OVERLAP = 400;

// Joins two neighbouring chunks. Chunks cut from one long paragraph share an overlap, which appears once; chunks
// that were whole paragraphs get back the blank line between them.
export function joinChunks(a: string, b: string): string {
  for (let k = Math.min(MAX_OVERLAP, a.length, b.length); k >= MIN_OVERLAP; k--) {
    if (a.endsWith(b.slice(0, k))) return a + b.slice(k);
  }
  return `${a}\n\n${b}`;
}

export function isPdf(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
}

// PDFs go to the vision model as page images; only plain text is extracted.
export async function extractDoc(name: string, bytes: Uint8Array): Promise<Extracted> {
  if (isPdf(bytes)) throw new Error(`${name}: PDFs are sent as page images, not extracted as text`);
  if (bytes.subarray(0, 8000).includes(0)) throw new Error(`${name}: binary file, unsupported (use text or PDF)`);
  const text = new TextDecoder().decode(bytes).replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new Error(`${name}: empty`);
  return { kind: 'text', text };
}
