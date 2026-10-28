import type { Hit, Store } from './store.ts';

export interface DocContext { mode: 'full' | 'excerpts'; text: string; sources: string[] }

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
  const picked: Hit[] = [];
  let used = 0;
  for (const h of hits) {
    if (picked.length && used + h.text.length > budget) break;
    picked.push(h);
    used += h.text.length;
  }
  picked.sort((a, b) => a.docId - b.docId || a.idx - b.idx);

  const sources: string[] = [];
  for (const h of picked) if (!sources.includes(h.name)) sources.push(h.name);
  return {
    mode: 'excerpts',
    text: picked.map(h => `[Document: ${h.name}, part ${h.idx + 1}]\n${h.text}`).join('\n\n'),
    sources,
  };
}
