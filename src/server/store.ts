import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sql } from './sqlite.ts';
import type { Val } from './sqlite.ts';

export interface Chat { id: number; title: string; created: number; updated: number }
export interface Message { id: number; chatId: number; role: string; content: unknown; created: number }
export interface DocMeta { id: number; chatId: number; name: string; kind: string; pages: number | null; chars: number; chunks: number; created: number }
export interface Hit { docId: number; name: string; idx: number; text: string }

const SCHEMA = `
pragma journal_mode = wal;
pragma foreign_keys = on;
create table if not exists chats(id integer primary key, title text not null, created integer not null, updated integer not null);
create table if not exists messages(
  id integer primary key, chat_id integer not null references chats(id) on delete cascade,
  role text not null, content text not null, created integer not null);
create index if not exists msg_chat on messages(chat_id, id);
create table if not exists docs(
  id integer primary key, chat_id integer not null references chats(id) on delete cascade,
  name text not null, kind text not null, pages integer, chars integer not null, chunks integer not null, created integer not null);
create index if not exists doc_chat on docs(chat_id);
create table if not exists chunks(
  id integer primary key, doc_id integer not null references docs(id) on delete cascade,
  idx integer not null, body text not null);
create index if not exists chunk_doc on chunks(doc_id, idx);
create virtual table if not exists chunks_fts using fts5(body, content='chunks', content_rowid='id', tokenize='porter unicode61');
create trigger if not exists chunks_ai after insert on chunks begin
  insert into chunks_fts(rowid, body) values (new.id, new.body);
end;
create trigger if not exists chunks_ad after delete on chunks begin
  insert into chunks_fts(chunks_fts, rowid, body) values ('delete', old.id, old.body);
end;
`;

let lastTick = 0;
function tick(): number {
  lastTick = Math.max(Date.now(), lastTick + 1);
  return lastTick;
}

const num = (v: Val | undefined): number => (typeof v === 'number' ? v : 0);
const str = (v: Val | undefined): string => (typeof v === 'string' ? v : '');

function chatOf(r: Val[]): Chat {
  return { id: num(r[0]), title: str(r[1]), created: num(r[2]), updated: num(r[3]) };
}

function docOf(r: Val[]): DocMeta {
  const pages = r[4];
  return {
    id: num(r[0]), chatId: num(r[1]), name: str(r[2]), kind: str(r[3]), pages: typeof pages === 'number' ? pages : null,
    chars: num(r[5]), chunks: num(r[6]), created: num(r[7]),
  };
}

function hitOf(r: Val[]): Hit {
  return { docId: num(r[0]), name: str(r[1]), idx: num(r[2]), text: str(r[3]) };
}

const DOC_COLS = 'id, chat_id, name, kind, pages, chars, chunks, created';

export class Store {
  private sql = new Sql();
  private pagesDir: string | null = null;
  private memPages = new Map<number, Uint8Array[]>();

  constructor(dir: string) {
    if (dir === ':memory:') {
      this.sql.open(':memory:');
    } else {
      mkdirSync(dir, { recursive: true });
      this.pagesDir = join(dir, 'pages');
      this.sql.open(join(dir, 'ora.db'));
    }
    this.sql.exec(SCHEMA);
  }

  private dropPages(docId: number): void {
    this.memPages.delete(docId);
    if (this.pagesDir) rmSync(join(this.pagesDir, String(docId)), { recursive: true, force: true });
  }

  addPages(docId: number, pages: Uint8Array[]): void {
    if (!this.pagesDir) { this.memPages.set(docId, pages); return; }
    const d = join(this.pagesDir, String(docId));
    mkdirSync(d, { recursive: true });
    for (let i = 0; i < pages.length; i++) writeFileSync(join(d, `${i + 1}.jpg`), pages[i] as Uint8Array);
  }

  readPage(docId: number, n: number): Uint8Array | null {
    if (n < 1) return null;
    if (!this.pagesDir) return this.memPages.get(docId)?.[n - 1] ?? null;
    const f = join(this.pagesDir, String(docId), `${n}.jpg`);
    return existsSync(f) ? new Uint8Array(readFileSync(f)) : null;
  }

  createChat(title: string): Chat {
    const t = tick();
    const name = title || 'New chat';
    const id = this.sql.run('insert into chats(title, created, updated) values (?, ?, ?)', [name, t, t]);
    return { id, title: name, created: t, updated: t };
  }

  listChats(): Chat[] {
    return this.sql.query('select id, title, created, updated from chats order by updated desc, id desc', []).map(chatOf);
  }

  getChat(id: number): Chat | null {
    const rows = this.sql.query('select id, title, created, updated from chats where id = ?', [id]);
    const r = rows[0];
    return r ? chatOf(r) : null;
  }

  renameChat(id: number, title: string): void {
    this.sql.run('update chats set title = ? where id = ?', [title, id]);
  }

  deleteChat(id: number): void {
    for (const d of this.docs(id)) this.dropPages(d.id);
    this.sql.run('delete from chats where id = ?', [id]);
  }

  addMessage(chatId: number, role: string, content: unknown): Message {
    const t = tick();
    let id = 0;
    this.sql.transaction(() => {
      id = this.sql.run('insert into messages(chat_id, role, content, created) values (?, ?, ?, ?)', [chatId, role, JSON.stringify(content), t]);
      this.sql.run('update chats set updated = ? where id = ?', [t, chatId]);
    });
    return { id, chatId, role, content, created: t };
  }

  messages(chatId: number): Message[] {
    return this.sql.query('select id, chat_id, role, content, created from messages where chat_id = ? order by id', [chatId]).map(r => ({
      id: num(r[0]), chatId: num(r[1]), role: str(r[2]), content: JSON.parse(str(r[3])) as unknown, created: num(r[4]),
    }));
  }

  addDoc(chatId: number, name: string, kind: string, pages: number | null, chunks: string[]): DocMeta {
    const t = tick();
    let chars = 0;
    for (const c of chunks) chars += c.length;
    let id = 0;
    this.sql.transaction(() => {
      id = this.sql.run(
        'insert into docs(chat_id, name, kind, pages, chars, chunks, created) values (?, ?, ?, ?, ?, ?, ?)',
        [chatId, name, kind, pages, chars, chunks.length, t]);
      for (let i = 0; i < chunks.length; i++) {
        this.sql.run('insert into chunks(doc_id, idx, body) values (?, ?, ?)', [id, i, chunks[i] as string]);
      }
      this.sql.run('update chats set updated = ? where id = ?', [t, chatId]);
    });
    return { id, chatId, name, kind, pages, chars, chunks: chunks.length, created: t };
  }

  docs(chatId: number): DocMeta[] {
    return this.sql.query(`select ${DOC_COLS} from docs where chat_id = ? order by id`, [chatId]).map(docOf);
  }

  getDoc(id: number): DocMeta | null {
    const r = this.sql.query(`select ${DOC_COLS} from docs where id = ?`, [id])[0];
    return r ? docOf(r) : null;
  }

  deleteDoc(id: number): void {
    this.dropPages(id);
    this.sql.run('delete from docs where id = ?', [id]);
  }

  allText(chatId: number): { name: string; text: string }[] {
    const out: { name: string; text: string }[] = [];
    for (const d of this.docs(chatId)) {
      if (d.kind === 'pdf') continue;
      const rows = this.sql.query('select body from chunks where doc_id = ? order by idx', [d.id]);
      out.push({ name: d.name, text: rows.map(r => str(r[0])).join('\n') });
    }
    return out;
  }

  head(chatId: number, k: number): Hit[] {
    return this.sql.query(
      `select c.doc_id, d.name, c.idx, c.body from chunks c join docs d on d.id = c.doc_id
       where d.chat_id = ? order by c.doc_id, c.idx limit ?`, [chatId, k]).map(hitOf);
  }

  // Each term is quoted, so FTS syntax in user text can't reach the query parser.
  search(chatId: number, query: string, k: number): Hit[] {
    const seen = new Set<string>();
    for (const t of query.toLowerCase().match(/[a-z0-9À-￿]+/g) ?? []) {
      if (seen.size < 24) seen.add(t);
    }
    if (!seen.size) return [];
    const q = [...seen].map(t => `"${t}"`).join(' OR ');
    return this.sql.query(
      `select c.doc_id, d.name, c.idx, c.body from chunks_fts f
       join chunks c on c.id = f.rowid join docs d on d.id = c.doc_id
       where chunks_fts match ? and d.chat_id = ? order by bm25(chunks_fts) limit ?`, [q, chatId, k]).map(hitOf);
  }

  close(): void {
    this.sql.close();
  }
}

export function openStore(dir: string): Store {
  return new Store(dir);
}
