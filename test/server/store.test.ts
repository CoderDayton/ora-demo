import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Sql } from '../../src/server/store/sqlite.ts';
import { openStore } from '../../src/server/store/store.ts';

// JSON comparison keeps every operand the same static type, which scriptc's assert lowering requires.
function same(actual: unknown, expected: unknown): void {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test('chats list newest-updated first and titles rename', () => {
  const db = openStore(':memory:');
  const a = db.createChat('first');
  const b = db.createChat('second');
  db.addMessage(a.id, 'user', 'hi');
  same(
    db.listChats().map(c => c.id),
    [a.id, b.id],
  );
  db.renameChat(b.id, 'renamed');
  same(db.getChat(b.id)?.title, 'renamed');
});

test('deleting a turn removes the question and everything up to the next question', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  const q1 = db.addMessage(c.id, 'user', 'one');
  db.addMessage(c.id, 'tool', [{ name: 'x' }]);
  db.addMessage(c.id, 'assistant', 'a1');
  const q2 = db.addMessage(c.id, 'user', 'two');
  db.addMessage(c.id, 'assistant', 'a2');
  same(db.deleteTurn(c.id, q1.id), true);
  same(
    db.messages(c.id).map(m => m.content),
    ['two', 'a2'],
  );
  same(db.deleteTurn(c.id, q2.id + 1), false);
  same(db.deleteTurn(c.id, q2.id), true);
  same(db.messages(c.id).length, 0);
});

test('messages round-trip structured content in order', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  const parts = [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: 'data:x' } },
  ];
  db.addMessage(c.id, 'user', parts);
  db.addMessage(c.id, 'assistant', 'a red circle');
  const ms = db.messages(c.id);
  same(ms.length, 2);
  same(ms[0]?.role, 'user');
  same(ms[0]?.content, parts);
  same(ms[1]?.content, 'a red circle');
});

test('text with quotes, newlines and unicode survives storage', () => {
  const db = openStore(':memory:');
  const c = db.createChat('naïve "title"');
  const text = 'line1\nline2 \'q\' "dq" é 日本語 \u{1F600}'.repeat(200);
  db.addMessage(c.id, 'user', text);
  same(db.getChat(c.id)?.title, 'naïve "title"');
  same(db.messages(c.id)[0]?.content, text);
});

test('deleting a chat removes its messages, docs and search hits', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  db.addMessage(c.id, 'user', 'hi');
  db.addDoc(c.id, 'a.txt', 'text', null, ['alpha beta gamma']);
  db.deleteChat(c.id);
  same(db.getChat(c.id), null);
  same(db.messages(c.id), []);
  same(db.docs(c.id), []);
  same(db.search(c.id, 'alpha', 5), []);
});

test('search ranks the matching chunk first and stays inside the chat', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  const other = db.createChat('');
  const d = db.addDoc(c.id, 'manual.pdf', 'pdf', 3, ['the quick brown fox', 'orbital mechanics and delta-v budgets', 'cooking pasta']);
  db.addDoc(other.id, 'other.txt', 'text', null, ['orbital decay of satellites']);
  const hits = db.search(c.id, 'orbital delta-v', 3);
  same(hits[0]?.text, 'orbital mechanics and delta-v budgets');
  same(hits[0]?.docId, d.id);
  same(hits[0]?.name, 'manual.pdf');
  same(hits.filter(h => h.docId !== d.id).length, 0);
});

test('search tolerates FTS syntax characters and empty queries', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  db.addDoc(c.id, 'a.txt', 'text', null, ['say "hello" - world (now)']);
  same(db.search(c.id, 'say "hello" - NEAR( AND OR *', 5).length, 1);
  same(db.search(c.id, '  ?! ', 5), []);
});

test('doc metadata reports chunk count and chars; deleteDoc drops chunks', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  const d = db.addDoc(c.id, 'a.txt', 'text', null, ['one two', 'three']);
  same(d.chunks, 2);
  same(d.chars, 'one two'.length + 'three'.length);
  same(db.docs(c.id)[0]?.name, 'a.txt');
  same(db.docs(c.id)[0]?.pages, null);
  db.deleteDoc(d.id);
  same(db.docs(c.id), []);
  same(db.search(c.id, 'three', 5), []);
});

test('allText returns whole docs in order for small-document inlining', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  db.addDoc(c.id, 'a.txt', 'text', null, ['first', 'second']);
  same(db.allText(c.id), [{ name: 'a.txt', text: 'first\n\nsecond' }]);
});

test('head returns the leading chunks in document order', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  db.addDoc(c.id, 'a.txt', 'text', null, ['one', 'two', 'three']);
  same(
    db.head(c.id, 2).map(h => h.text),
    ['one', 'two'],
  );
});

test('pdf pages are stored as files, served by number, and removed with the doc and chat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ora-pages-'));
  try {
    const db = openStore(dir);
    const c = db.createChat('');
    const d = db.addDoc(c.id, 'scan.pdf', 'pdf', 2, []);
    db.addPages(d.id, [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
    same(Array.from(db.readPage(d.id, 1) ?? []), [1, 2, 3]);
    same(Array.from(db.readPage(d.id, 2) ?? []), [4, 5]);
    same(db.readPage(d.id, 3), null);
    same(db.readPage(d.id, 0), null);
    db.deleteDoc(d.id);
    same(db.readPage(d.id, 1), null);
    const d2 = db.addDoc(c.id, 'b.pdf', 'pdf', 1, []);
    db.addPages(d2.id, [new Uint8Array([9])]);
    db.deleteChat(c.id);
    same(db.readPage(d2.id, 1), null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allText skips pdf documents, which carry no text', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  db.addDoc(c.id, 'scan.pdf', 'pdf', 3, []);
  db.addDoc(c.id, 'a.txt', 'text', null, ['hello']);
  same(db.allText(c.id), [{ name: 'a.txt', text: 'hello' }]);
});

test('pdf page text is searchable per page, ranked, and scoped to the chat', () => {
  const db = openStore(':memory:');
  const c = db.createChat('');
  const other = db.createChat('');
  const d = db.addDoc(c.id, 'manual.pdf', 'pdf', 3, []);
  db.addPageText(d.id, ['table of contents', 'orbital mechanics and delta-v budgets', 'appendix: delta tables']);
  const o = db.addDoc(other.id, 'x.pdf', 'pdf', 1, []);
  db.addPageText(o.id, ['orbital decay']);
  const hits = db.searchPages(c.id, 'what are the orbital delta-v budgets?', 5);
  same(hits[0], { docId: d.id, page: 2 });
  same(hits.filter(h => h.docId !== d.id).length, 0);
  same(db.searchPages(c.id, 'the of', 5), []);
  db.deleteDoc(d.id);
  same(db.searchPages(c.id, 'orbital', 5), []);
});

test('a pdf keeps its source and page size so pages can be rendered later', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ora-src-'));
  try {
    const db = openStore(dir);
    const c = db.createChat('');
    const d = db.addDoc(c.id, 'a.pdf', 'pdf', 2, []);
    db.savePdf(d.id, new Uint8Array([37, 80, 68, 70]), 1536);
    same(db.getDoc(d.id)?.px, 1536);
    const src = db.pdfFile(d.id);
    assert.ok(src !== null && existsSync(src));
    same(db.pageFile(d.id, 2)?.endsWith('2.jpg'), true);
    db.deleteDoc(d.id);
    same(existsSync(src as string), false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing database from before page search is upgraded in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ora-mig-'));
  try {
    // The docs table as it was before page search and stored page sizes.
    const s = new Sql();
    s.open(join(dir, 'ora.db'));
    s.exec(`create table chats(id integer primary key, title text not null, created integer not null, updated integer not null);
      create table docs(id integer primary key, chat_id integer not null references chats(id) on delete cascade,
        name text not null, kind text not null, pages integer, chars integer not null, chunks integer not null, created integer not null);`);
    s.run('insert into chats(title, created, updated) values (?, ?, ?)', ['old', 1, 1]);
    s.run('insert into docs(chat_id, name, kind, pages, chars, chunks, created) values (?, ?, ?, ?, ?, ?, ?)', [
      1,
      'a.pdf',
      'pdf',
      2,
      0,
      0,
      1,
    ]);
    s.close();
    const b = openStore(dir);
    same(b.getChat(1)?.title, 'old');
    same(b.getDoc(1)?.px, null);
    b.addPageText(1, ['first page', 'hello there']);
    same(b.searchPages(1, 'hello', 1), [{ docId: 1, page: 2 }]);
    b.close();
    const again = openStore(dir);
    same(again.searchPages(1, 'hello', 1).length, 1);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('data survives reopening the same directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ora-store-'));
  try {
    const a = openStore(dir);
    const c = a.createChat('keep me');
    a.addMessage(c.id, 'user', 'hello');
    a.addMessage(c.id, 'assistant', 'hi there');
    const d = a.addDoc(c.id, 'n.txt', 'text', null, ['persistent searchable words']);
    a.close();
    const b = openStore(dir);
    same(b.getChat(c.id)?.title, 'keep me');
    same(
      b.messages(c.id).map(m => m.content),
      ['hello', 'hi there'],
    );
    same(b.search(c.id, 'searchable', 3)[0]?.docId, d.id);
    b.deleteChat(c.id);
    same(b.getChat(c.id), null);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
