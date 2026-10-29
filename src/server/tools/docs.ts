// Tools over the documents uploaded to a chat, answered from the SQLite index.

import type { Store } from '../store/store.ts';

const PART_CHARS = 1200;

export function searchDocuments(store: Store, chatId: number, query: string, limit: number): string {
  const k = Math.min(8, Math.max(1, Math.round(limit) || 4));
  const hits = store.search(chatId, query, k);
  const pdfPages = store.searchPages(chatId, query, k);
  if (!hits.length && !pdfPages.length) return 'No matches.';
  const out: string[] = [];
  for (const h of hits) out.push(`[${h.name}, part ${h.idx}]\n${h.text.slice(0, PART_CHARS)}`);
  for (const p of pdfPages) {
    const d = store.getDoc(p.docId);
    if (d) out.push(`[${d.name}, PDF page ${p.page}] matches. PDF pages reach you as images when they are selected for the question.`);
  }
  return out.join('\n\n');
}

export function readDocument(store: Store, chatId: number, name: string, part: number): string {
  const doc = store.docs(chatId).find(d => d.name === name && d.kind !== 'pdf');
  if (!doc) throw new Error(`no document named "${name}" in this chat`);
  const hit = store.chunkAt(doc.id, Math.max(0, Math.round(part)));
  if (!hit) throw new Error(`${name} has parts 0 to ${Math.max(0, doc.chunks - 1)}`);
  return hit.text;
}
