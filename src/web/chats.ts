import { Orb } from './orb.ts';
import type { ChatInfo, DocInfo, Part } from './state.ts';
import { $, api, hooks, S, store } from './state.ts';

interface ChatData {
  chat: ChatInfo;
  messages: { role: 'user' | 'assistant'; content: string | Part[] }[];
  docs: DocInfo[];
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
    title.onclick = () => {
      void openChat(c.id);
    };
    const del = document.createElement('button');
    del.textContent = 'x';
    del.title = 'delete chat';
    del.onclick = () => {
      void removeChat(c.id);
    };
    row.append(title, del);
    el.appendChild(row);
  }
}

export async function openChat(id: number): Promise<void> {
  await hooks.abortChat();
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
  await hooks.abortChat();
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

// The server creates a chat on its first message; this adopts it as the open chat.
export function adoptChat(id: number): void {
  if (S.chatId !== null) return;
  S.chatId = id;
  store.set('ora.chat', id);
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
      // Empty means the server picks the pages that match the question.
      const sel = document.createElement('input');
      sel.value = S.pageSel[String(d.id)] ?? '';
      sel.placeholder = 'auto';
      sel.title = 'pages sent to the model, e.g. 1-6,9; empty picks the pages that match the question';
      sel.size = 7;
      sel.onchange = () => {
        const v = sel.value.trim();
        if (v) S.pageSel[String(d.id)] = v;
        else delete S.pageSel[String(d.id)];
        store.set('ora.pages', S.pageSel);
      };
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

// The page ranges typed for this chat's PDFs, keyed by document id.
export function pageRanges(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of S.docs) {
    const v = S.pageSel[String(d.id)];
    if (d.kind === 'pdf' && v) out[String(d.id)] = v;
  }
  return out;
}

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
