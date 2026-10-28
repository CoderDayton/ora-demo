import { Orb } from './orb.ts';
import { $, S, api, hooks, store } from './state.ts';
import type { ChatInfo, DocInfo, Msg, Part } from './state.ts';

// Measured on LFM3-Omni: a 792x1024 page added about 780 prompt tokens.
export const IMG_TOKENS = 800;
const CHARS_PER_TOKEN = 3.6;
const SHARE_TEXT = 0.4;
const SHARE_PAGES = 0.5;

interface ChatData { chat: ChatInfo; messages: { role: 'user' | 'assistant'; content: string | Part[] }[]; docs: DocInfo[] }

// Voice audio is large and only meaningful to the live turn, so storage keeps a marker instead.
function storable(m: Msg): Msg {
  if (typeof m.content === 'string' || !m.content.some(p => p.type === 'input_audio')) return m;
  return { role: m.role, content: m.content.map(p => (p.type === 'input_audio' ? { type: 'text', text: '[voice message]' } : p)) };
}

export async function refreshChats(): Promise<void> {
  S.chats = await api<ChatInfo[]>('/api/chats');
  renderChats();
}

function group(updated: number): string {
  const day = 86_400_000;
  const startToday = new Date().setHours(0, 0, 0, 0);
  if (updated >= startToday) return 'Today';
  if (updated >= startToday - day) return 'Yesterday';
  if (updated >= startToday - 7 * day) return 'Previous 7 days';
  return 'Older';
}

export function renderChats(): void {
  const el = $('#chatlist');
  el.innerHTML = '';
  if (!S.chats.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No chats yet';
    el.appendChild(e);
  }
  let current = '';
  for (const c of S.chats) {
    const g = group(c.updated);
    if (g !== current) {
      current = g;
      const h = document.createElement('div');
      h.className = 'grp label';
      h.textContent = g;
      el.appendChild(h);
    }
    const row = document.createElement('div');
    row.className = `chatrow${c.id === S.chatId ? ' active' : ''}`;
    const title = document.createElement('span');
    title.textContent = c.title;
    title.title = c.title;
    title.onclick = () => { void openChat(c.id); };
    const del = document.createElement('button');
    del.textContent = 'x';
    del.title = 'delete chat';
    del.onclick = () => { void removeChat(c.id); };
    row.append(title, del);
    el.appendChild(row);
  }
}

export async function openChat(id: number): Promise<void> {
  if (S.busy) hooks.abortChat();
  hooks.stopSpeech();
  const d = await api<ChatData>(`/api/chats/${id}`);
  S.chatId = id;
  S.hist = d.messages.map(m => ({ role: m.role, content: m.content }));
  S.docs = d.docs;
  S.usage = null;
  S.totals = { in: 0, out: 0 };
  store.set('ora.chat', id);
  hooks.renderLog();
  hooks.showCtx();
  renderDocs();
  renderChats();
}

export async function newChat(): Promise<void> {
  if (S.busy) hooks.abortChat();
  hooks.stopSpeech();
  S.chatId = null;
  S.hist = [];
  S.docs = [];
  S.usage = null;
  S.totals = { in: 0, out: 0 };
  store.set('ora.chat', 0);
  hooks.renderLog();
  hooks.showCtx();
  renderDocs();
  renderChats();
}

export async function removeChat(id: number): Promise<void> {
  await api(`/api/chats/${id}`, undefined, 'DELETE');
  if (id === S.chatId) await newChat();
  await refreshChats();
}

// Chats are created on the first message or upload, so an empty page never leaves an empty chat behind.
export async function ensureChat(): Promise<number> {
  if (S.chatId !== null) return S.chatId;
  const c = await api<ChatInfo>('/api/chats', { title: '' });
  S.chatId = c.id;
  store.set('ora.chat', c.id);
  await refreshChats();
  return c.id;
}

export async function persist(m: Msg, titleHint = ''): Promise<void> {
  const first = S.hist.length === 1 && m.role === 'user';
  const id = await ensureChat();
  await api(`/api/chats/${id}/messages`, { role: m.role, content: storable(m).content });
  if (first) {
    const t = titleHint.trim().replace(/\s+/g, ' ').slice(0, 48) || 'Voice chat';
    await api(`/api/chats/${id}`, { title: t }, 'PATCH');
  }
  await refreshChats();
}

export async function restoreLastChat(): Promise<void> {
  await refreshChats();
  const last = store.get<number>('ora.chat', 0);
  const id = S.chats.some(c => c.id === last) ? last : 0;
  if (id) await openChat(id);
}

/* ---------- documents ---------- */

export function renderDocs(): void {
  const el = $('#docs');
  el.classList.toggle('show', S.docs.length > 0);
  el.innerHTML = '';
  for (const d of S.docs) {
    const chip = document.createElement('div');
    chip.className = 'doc';
    const label = document.createElement('span');
    label.textContent = d.kind === 'pdf' ? `${d.name} (${d.pages}p)` : `${d.name} (${Math.round(d.chars / 1000)}k chars)`;
    label.title = d.name;
    chip.appendChild(label);
    if (d.kind === 'pdf') {
      const sel = document.createElement('input');
      sel.value = S.pageSel[String(d.id)] ?? defaultRange(d);
      sel.title = 'pages sent to the model, e.g. 1-6,9';
      sel.size = 7;
      sel.onchange = () => { S.pageSel[String(d.id)] = sel.value; store.set('ora.pages', S.pageSel); };
      chip.appendChild(sel);
    }
    const del = document.createElement('button');
    del.textContent = 'x';
    del.onclick = async () => {
      await api(`/api/docs/${d.id}`, undefined, 'DELETE');
      S.docs = S.docs.filter(x => x.id !== d.id);
      renderDocs();
    };
    chip.appendChild(del);
    el.appendChild(chip);
  }
}

// Page images cost roughly in proportion to their area.
const imgTokens = (): number => Math.round(IMG_TOKENS * (S.set.pagepx / 1024) ** 2);
const pageCap = (): number => Math.max(1, Math.floor((S.nctx * SHARE_PAGES) / imgTokens()));
const defaultRange = (d: DocInfo): string => `1-${Math.min(d.pages ?? 1, pageCap())}`;

export async function uploadDocs(files: Iterable<File>): Promise<void> {
  for (const f of files) {
    hooks.statusline(`reading ${f.name}...`);
    try {
      const id = await ensureChat();
      const r = await fetch(`/api/chats/${id}/docs?name=${encodeURIComponent(f.name)}&px=${S.set.pagepx}`, { method: 'POST', body: f });
      const j = (await r.json()) as DocInfo & { error?: string };
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      S.docs.push(j);
      renderDocs();
      Orb.event({ type: 'doc' });
    } catch (e) {
      hooks.note(`${f.name}: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }
  hooks.statusline('');
}

export function parseRange(spec: string, max: number): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = Math.max(1, a); n <= Math.min(max, b); n++) if (!out.includes(n)) out.push(n);
  }
  return out;
}

const pageCache = new Map<string, string>();
async function pageUrl(docId: number, n: number): Promise<string> {
  const key = `${docId}:${n}`;
  const hit = pageCache.get(key);
  if (hit) return hit;
  const blob = await (await fetch(`/api/docs/${docId}/pages/${n}`)).blob();
  const url = await new Promise<string>(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsDataURL(blob); });
  pageCache.set(key, url);
  return url;
}

export interface DocPayload { system: string; lead: Msg[]; tokens: number; note: string }

// What a request carries for this chat's documents: excerpts as system text, PDF pages as leading images.
export async function docPayload(query: string): Promise<DocPayload> {
  const out: DocPayload = { system: '', lead: [], tokens: 0, note: '' };
  if (S.chatId === null || !S.docs.length) return out;
  const pdfs = S.docs.filter(d => d.kind === 'pdf');
  const hasText = S.docs.some(d => d.kind !== 'pdf');

  if (pdfs.length) {
    if (!S.props?.modalities?.vision) {
      out.note = 'this model has no vision encoder: PDF pages were not sent';
    } else {
      let room = Math.max(1, Math.floor((S.nctx * (hasText ? 0.4 : SHARE_PAGES)) / imgTokens()));
      let dropped = 0;
      for (const d of pdfs) {
        const wanted = parseRange(S.pageSel[String(d.id)] ?? defaultRange(d), d.pages ?? 0);
        const take = wanted.slice(0, room);
        dropped += wanted.length - take.length;
        room -= take.length;
        if (!take.length) continue;
        const parts: Part[] = [{ type: 'text', text: `Pages ${take[0]}-${take[take.length - 1]} of the document "${d.name}":` }];
        for (const n of take) parts.push({ type: 'image_url', image_url: { url: await pageUrl(d.id, n) } });
        out.lead.push({ role: 'user', content: parts });
        out.lead.push({ role: 'assistant', content: `I have read those pages of "${d.name}".` });
        out.tokens += take.length * imgTokens();
      }
      if (dropped) out.note = `context limit: ${dropped} selected PDF page(s) left out`;
    }
  }

  if (hasText && S.chatId !== null) {
    const budget = Math.floor(S.nctx * (pdfs.length ? 0.2 : SHARE_TEXT) * CHARS_PER_TOKEN);
    const c = await api<{ mode: string; text: string } | null>(`/api/chats/${S.chatId}/context?q=${encodeURIComponent(query)}&budget=${budget}`);
    if (c) {
      out.system = `\n\nThe user uploaded reference documents${c.mode === 'excerpts' ? ' (the most relevant excerpts follow)' : ''}. Use them to answer and name the document you rely on.\n\n${c.text}`;
      out.tokens += Math.ceil(c.text.length / CHARS_PER_TOKEN);
    }
  }
  return out;
}
