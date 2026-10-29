import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { joinChunks } from '../docs/docs.ts';
import type { Val } from './sqlite.ts';
import { Sql } from './sqlite.ts';

export interface Chat {
  id: number;
  title: string;
  created: number;
  updated: number;
}
export interface Message {
  id: number;
  chatId: number;
  role: string;
  content: unknown;
  created: number;
}
export interface DocMeta {
  id: number;
  chatId: number;
  name: string;
  kind: string;
  pages: number | null;
  chars: number;
  chunks: number;
  created: number;
  px: number | null;
}
export interface Hit {
  docId: number;
  name: string;
  idx: number;
  text: string;
}
export interface PageHit {
  docId: number;
  page: number;
}

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

// Applied in order to databases whose user_version is below their index + 1.
const MIGRATIONS = [
  // PDF page size (for rendering pages later) and each page's text layer, which only ranks pages for a question.
  `alter table docs add column px integer;
  create table page_text(
    id integer primary key, doc_id integer not null references docs(id) on delete cascade,
    page integer not null, body text not null);
  create index page_doc on page_text(doc_id, page);
  create virtual table page_fts using fts5(body, content='page_text', content_rowid='id', tokenize='porter unicode61');
  create trigger page_ai after insert on page_text begin
    insert into page_fts(rowid, body) values (new.id, new.body);
  end;
  create trigger page_ad after delete on page_text begin
    insert into page_fts(page_fts, rowid, body) values ('delete', old.id, old.body);
  end;`,
];

// Words that match nearly every passage and only add noise to an OR query.
const STOPWORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'give',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'please',
  'show',
  'so',
  'tell',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'up',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

// Each term is quoted, so FTS syntax in user text can't reach the query parser. Empty when nothing is left to match.
function ftsQuery(query: string): string {
  const seen = new Set<string>();
  for (const t of query.toLowerCase().match(/[a-z0-9À-￿]+/g) ?? []) {
    if (seen.size < 24 && !STOPWORDS.has(t)) seen.add(t);
  }
  return [...seen].map(t => `"${t}"`).join(' OR ');
}

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
    id: num(r[0]),
    chatId: num(r[1]),
    name: str(r[2]),
    kind: str(r[3]),
    pages: typeof pages === 'number' ? pages : null,
    chars: num(r[5]),
    chunks: num(r[6]),
    created: num(r[7]),
    px: typeof r[8] === 'number' ? r[8] : null,
  };
}

function hitOf(r: Val[]): Hit {
  return { docId: num(r[0]), name: str(r[1]), idx: num(r[2]), text: str(r[3]) };
}

const DOC_COLS = 'id, chat_id, name, kind, pages, chars, chunks, created, px';

export class Store {
  private sql = new Sql();
  private pagesDir: string | null = null;
  private memPages = new Map<number, Uint8Array[]>();
  private memPdf = new Map<number, Uint8Array>();

  constructor(dir: string) {
    if (dir === ':memory:') {
      this.sql.open(':memory:');
    } else {
      mkdirSync(dir, { recursive: true });
      this.pagesDir = join(dir, 'pages');
      this.sql.open(join(dir, 'ora.db'));
    }
    this.sql.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const v = num(this.sql.query('pragma user_version', [])[0]?.[0]);
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.sql.transaction(() => {
        this.sql.exec(MIGRATIONS[i] as string);
        this.sql.exec(`pragma user_version = ${i + 1}`);
      });
    }
  }

  private dropPages(docId: number): void {
    this.memPages.delete(docId);
    this.memPdf.delete(docId);
    if (this.pagesDir) rmSync(join(this.pagesDir, String(docId)), { recursive: true, force: true });
  }

  addPages(docId: number, pages: Uint8Array[]): void {
    for (let i = 0; i < pages.length; i++) this.putPage(docId, i + 1, pages[i] as Uint8Array);
  }

  // Written under a temporary name and renamed, so a reader never sees half a page.
  putPage(docId: number, n: number, jpg: Uint8Array): void {
    if (!this.pagesDir) {
      const list = this.memPages.get(docId) ?? [];
      list[n - 1] = jpg;
      this.memPages.set(docId, list);
      return;
    }
    const d = this.pageDir(docId) as string;
    mkdirSync(d, { recursive: true });
    const f = join(d, `${n}.jpg`);
    writeFileSync(`${f}.tmp`, jpg);
    renameSync(`${f}.tmp`, f);
  }

  pageDir(docId: number): string | null {
    return this.pagesDir ? join(this.pagesDir, String(docId)) : null;
  }

  // Keeps the original PDF so pages can be rendered after the upload returns, and the page size to render at.
  savePdf(docId: number, bytes: Uint8Array, px: number): void {
    this.sql.run('update docs set px = ? where id = ?', [px, docId]);
    if (!this.pagesDir) {
      this.memPdf.set(docId, bytes);
      return;
    }
    const d = join(this.pagesDir, String(docId));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'source.pdf'), bytes);
  }

  readPdf(docId: number): Uint8Array | null {
    const f = this.pdfFile(docId);
    if (f !== null) return new Uint8Array(readFileSync(f));
    return this.memPdf.get(docId) ?? null;
  }

  // On-disk paths, or null for an in-memory store.
  pdfFile(docId: number): string | null {
    if (!this.pagesDir) return null;
    const f = join(this.pagesDir, String(docId), 'source.pdf');
    return existsSync(f) ? f : null;
  }

  pageFile(docId: number, n: number): string | null {
    return this.pagesDir ? join(this.pagesDir, String(docId), `${n}.jpg`) : null;
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
      id = this.sql.run('insert into messages(chat_id, role, content, created) values (?, ?, ?, ?)', [
        chatId,
        role,
        JSON.stringify(content),
        t,
      ]);
      this.sql.run('update chats set updated = ? where id = ?', [t, chatId]);
    });
    return { id, chatId, role, content, created: t };
  }

  messages(chatId: number): Message[] {
    return this.sql.query('select id, chat_id, role, content, created from messages where chat_id = ? order by id', [chatId]).map(r => ({
      id: num(r[0]),
      chatId: num(r[1]),
      role: str(r[2]),
      content: JSON.parse(str(r[3])) as unknown,
      created: num(r[4]),
    }));
  }

  addDoc(chatId: number, name: string, kind: string, pages: number | null, chunks: string[]): DocMeta {
    const t = tick();
    let chars = 0;
    for (const c of chunks) chars += c.length;
    let id = 0;
    this.sql.transaction(() => {
      id = this.sql.run('insert into docs(chat_id, name, kind, pages, chars, chunks, created) values (?, ?, ?, ?, ?, ?, ?)', [
        chatId,
        name,
        kind,
        pages,
        chars,
        chunks.length,
        t,
      ]);
      for (let i = 0; i < chunks.length; i++) {
        this.sql.run('insert into chunks(doc_id, idx, body) values (?, ?, ?)', [id, i, chunks[i] as string]);
      }
      this.sql.run('update chats set updated = ? where id = ?', [t, chatId]);
    });
    return { id, chatId, name, kind, pages, chars, chunks: chunks.length, created: t, px: null };
  }

  // One row per page that has text; page numbers start at 1.
  addPageText(docId: number, texts: string[]): void {
    this.sql.transaction(() => {
      for (let i = 0; i < texts.length; i++) {
        const body = (texts[i] as string).trim();
        if (body) this.sql.run('insert into page_text(doc_id, page, body) values (?, ?, ?)', [docId, i + 1, body]);
      }
    });
  }

  searchPages(chatId: number, query: string, k: number): PageHit[] {
    const q = ftsQuery(query);
    if (!q) return [];
    return this.sql
      .query(
        `select p.doc_id, p.page from page_fts f
       join page_text p on p.id = f.rowid join docs d on d.id = p.doc_id
       where page_fts match ? and d.chat_id = ? order by bm25(page_fts) limit ?`,
        [q, chatId, k],
      )
      .map(r => ({ docId: num(r[0]), page: num(r[1]) }));
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
      let text = '';
      for (const r of rows) text = text ? joinChunks(text, str(r[0])) : str(r[0]);
      out.push({ name: d.name, text });
    }
    return out;
  }

  chunkAt(docId: number, idx: number): Hit | null {
    if (idx < 0) return null;
    const r = this.sql.query(
      'select c.doc_id, d.name, c.idx, c.body from chunks c join docs d on d.id = c.doc_id where c.doc_id = ? and c.idx = ?',
      [docId, idx],
    )[0];
    return r ? hitOf(r) : null;
  }

  head(chatId: number, k: number): Hit[] {
    return this.sql
      .query(
        `select c.doc_id, d.name, c.idx, c.body from chunks c join docs d on d.id = c.doc_id
       where d.chat_id = ? order by c.doc_id, c.idx limit ?`,
        [chatId, k],
      )
      .map(hitOf);
  }

  search(chatId: number, query: string, k: number): Hit[] {
    const q = ftsQuery(query);
    if (!q) return [];
    return this.sql
      .query(
        `select c.doc_id, d.name, c.idx, c.body from chunks_fts f
       join chunks c on c.id = f.rowid join docs d on d.id = c.doc_id
       where chunks_fts match ? and d.chat_id = ? order by bm25(chunks_fts) limit ?`,
        [q, chatId, k],
      )
      .map(hitOf);
  }

  close(): void {
    this.sql.close();
  }
}

export function openStore(dir: string): Store {
  return new Store(dir);
}
