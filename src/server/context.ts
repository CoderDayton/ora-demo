import { joinChunks } from './docs.ts';
import type { Hit, Store } from './store.ts';

export interface DocContext {
  mode: 'full' | 'excerpts';
  text: string;
  sources: string[];
}

// How many of the best matches bring the chunks on either side of them.
const FOCUS = 8;

// A run of consecutive chunks of one document, shown as one excerpt.
class Run {
  docId: number;
  name: string;
  first: number;
  last: number;
  text: string;

  constructor(h: Hit) {
    this.docId = h.docId;
    this.name = h.name;
    this.first = h.idx;
    this.last = h.idx;
    this.text = h.text;
  }

  label(): string {
    return this.first === this.last ? `part ${this.first + 1}` : `parts ${this.first + 1}-${this.last + 1}`;
  }
}

// Small document sets go in whole; larger ones contribute the chunks that best match the query.
export function buildContext(store: Store, chatId: number, query: string, budget: number): DocContext | null {
  const docs = store.docs(chatId);
  if (!docs.length) return null;
  let total = 0;
  for (const d of docs) total += d.chars;

  if (total <= budget) {
    const all = store.allText(chatId);
    return {
      mode: 'full',
      text: all.map(d => `[Document: ${d.name}]\n${d.text}`).join('\n\n'),
      sources: all.map(d => d.name),
    };
  }

  let hits = store.search(chatId, query, 64);
  if (!hits.length) hits = store.head(chatId, 64);
  const picked = new Map<string, Hit>();
  let used = 0;
  const key = (h: Hit): string => `${h.docId}:${h.idx}`;
  // A chunk that does not fit is skipped, so smaller ones after it can still use the room.
  const take = (h: Hit | null): boolean => {
    if (!h) return false;
    if (picked.has(key(h))) return true;
    if (picked.size && used + h.text.length > budget) return false;
    picked.set(key(h), h);
    used += h.text.length;
    return true;
  };
  // The best matches come with the text around them; the remaining matches fill what room is left.
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i] as Hit;
    if (take(h) && i < FOCUS) {
      take(store.chunkAt(h.docId, h.idx - 1));
      take(store.chunkAt(h.docId, h.idx + 1));
    }
  }

  const runs: Run[] = [];
  for (const h of [...picked.values()].sort((a, b) => a.docId - b.docId || a.idx - b.idx)) {
    const r = runs[runs.length - 1];
    if (r && r.docId === h.docId && r.last === h.idx - 1) {
      r.last = h.idx;
      r.text = joinChunks(r.text, h.text);
    } else {
      runs.push(new Run(h));
    }
  }
  const sources: string[] = [];
  for (const r of runs) if (!sources.includes(r.name)) sources.push(r.name);
  return {
    mode: 'excerpts',
    text: runs.map(r => `[Document: ${r.name}, ${r.label()}]\n${r.text}`).join('\n\n'),
    sources,
  };
}
