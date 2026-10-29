export type Inline = { t: 'text' | 'code' | 'strong' | 'em'; v: string };
export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; n: number; c: Inline[] }
  | { t: 'ul'; items: ListItem[] }
  | { t: 'ol'; start: number; items: ListItem[] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'code'; lang: string; v: string };

export type ListItem = { c: Inline[]; sub?: Block[] };

const word = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

// Inline marks. An opener with no closer stays literal, so a reply that is still streaming never flickers into
// the wrong shape. Output is data, never markup: the page builds elements from it with textContent.
function inline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) {
      out.push({ t: 'text', v: buf });
      buf = '';
    }
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush();
        out.push({ t: 'code', v: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    } else if (c === '*' && s[i + 1] === '*') {
      const j = s.indexOf('**', i + 2);
      if (j > i + 2) {
        flush();
        out.push({ t: 'strong', v: s.slice(i + 2, j) });
        i = j + 2;
        continue;
      }
    } else if (
      (c === '*' || c === '_') &&
      s[i + 1] !== c &&
      s[i + 1] !== undefined &&
      !/\s/.test(s[i + 1] as string) &&
      !(c === '_' && word(s[i - 1]))
    ) {
      let j = s.indexOf(c, i + 1);
      while (
        j > 0 &&
        (/\s/.test(s[j - 1] as string) || (c === '_' && word(s[j + 1])) || (c === '*' && (s[j + 1] === '*' || s[j - 1] === '*')))
      ) {
        j = s.indexOf(c, s[j + 1] === c ? j + 2 : j + 1);
      }
      if (j > i + 1) {
        flush();
        out.push({ t: 'em', v: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

const indent = (l: string): number => (l.match(/^[ \t]*/) as RegExpMatchArray)[0].replace(/\t/g, '    ').length;
const dedent = (l: string, n: number): string => {
  const e = l.replace(/^[ \t]*/, w => w.replace(/\t/g, '    '));
  return e.slice(Math.min(n, indent(e)));
};
const FENCE = /^\s*(`{3,})\s*([\w+#.-]*)[^`]*$/;
const fenceClose = (open: string): RegExp => new RegExp(`^\\s*\`{${open.length},}\\s*$`);

const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const endPara = (): void => {
    if (para.length) {
      out.push({ t: 'p', c: inline(para.join('\n')) });
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const fence = line.match(FENCE);
    if (fence) {
      endPara();
      const body: string[] = [];
      i++;
      const close = fenceClose(fence[1] as string);
      while (i < lines.length && !close.test(lines[i] as string)) body.push(lines[i++] as string);
      i++;
      out.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      endPara();
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      endPara();
      out.push({ t: 'h', n: Math.min(3, (h[1] as string).length), c: inline(h[2] as string) });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      endPara();
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] as string)) q.push((lines[i++] as string).replace(/^>\s?/, ''));
      out.push({ t: 'quote', c: inline(q.join('\n')) });
      continue;
    }
    const kind = UL.test(line) ? 'ul' : OL.test(line) ? 'ol' : '';
    if (kind) {
      endPara();
      const re = kind === 'ul' ? UL : OL;
      const items: ListItem[] = [];
      const start = Number((line.match(/\d+/) ?? ['1'])[0]);
      const base = indent(line);
      const sameList = (l: string | undefined): RegExpMatchArray | null => (l !== undefined && indent(l) === base ? l.match(re) : null);
      for (let m = sameList(lines[i]); m; m = sameList(lines[i])) {
        const item: ListItem = { c: inline(m[1] as string) };
        items.push(item);
        i++;
        // Lines indented deeper than the marker (blank lines between them included) are the item's own content.
        const inner: string[] = [];
        for (;;) {
          let k = i;
          while (k < lines.length && !(lines[k] as string).trim()) k++;
          if (k >= lines.length || indent(lines[k] as string) <= base) break;
          inner.push(...lines.slice(i, k + 1));
          i = k + 1;
        }
        if (inner.length) {
          const d = Math.min(...inner.filter(l => l.trim()).map(indent));
          item.sub = parseMarkdown(inner.map(l => dedent(l, d)).join('\n'));
        }
        let k = i;
        while (k < lines.length && !(lines[k] as string).trim()) k++;
        if (k > i && sameList(lines[k])) i = k;
      }
      out.push(kind === 'ul' ? { t: 'ul', items } : { t: 'ol', start, items });
      continue;
    }
    para.push(line);
    i++;
  }
  endPara();
  return out;
}

// Offset just past the last blank line that is outside a code fence, or 0. Text before it cannot change shape
// when more is appended, unless it ends in a list (a list may continue after a blank line).
function lastBoundary(s: string): number {
  let close: RegExp | null = null;
  let off = 0,
    cut = 0;
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    const end = off + l.length + 1;
    if (close) {
      if (close.test(l)) close = null;
    } else {
      const f = l.match(FENCE);
      if (f) close = fenceClose(f[1] as string);
      else if (!l.trim() && i < lines.length - 1) cut = end;
    }
    off = end;
  }
  return cut;
}

// Parses a reply as it streams in: finished blocks are kept and only the unfinished tail is parsed again.
// `changedFrom` is the first block index that may differ from the previous update.
export class MarkdownStream {
  private text = '';
  private doneLen = 0;
  private done: Block[] = [];

  update(raw: string): { blocks: Block[]; changedFrom: number } {
    const text = raw.replace(/\r\n?/g, '\n');
    if (!text.startsWith(this.text.slice(0, this.doneLen))) {
      this.doneLen = 0;
      this.done = [];
    }
    this.text = text;
    const changedFrom = this.done.length;
    const tail = text.slice(this.doneLen);
    const cut = lastBoundary(tail);
    if (cut > 0) {
      const head = parseMarkdown(tail.slice(0, cut));
      const last = head[head.length - 1];
      if (!last || (last.t !== 'ul' && last.t !== 'ol')) {
        this.done.push(...head);
        this.doneLen += cut;
      }
    }
    return { blocks: [...this.done, ...parseMarkdown(text.slice(this.doneLen))], changedFrom };
  }
}
