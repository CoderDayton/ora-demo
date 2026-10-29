import assert from 'node:assert';
import { test } from 'node:test';
import type { Msg, PageRef } from '../../src/server/chat/prompt.ts';
import { assemble, estTokens, fitHistory, selectPages } from '../../src/server/chat/prompt.ts';

const cost = { charsPerToken: 4, imageTokens: 100, scale: 1 };
const user = (t: string): Msg => ({ role: 'user', content: t });
const bot = (t: string): Msg => ({ role: 'assistant', content: t });
const pad = (n: number): string => 'x'.repeat(n * 4);
const total = (ms: Msg[]): number => ms.reduce((a, m) => a + estTokens(m, cost), 0);
const p = (docId: number, page: number): PageRef => ({ docId, page });

function same(actual: unknown, expected: unknown): void {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}

test('once trimmed, the start of the history stays put while later turns still fit', () => {
  const h: Msg[] = [];
  for (let i = 0; i < 10; i++) h.push(user(`q${i} ${pad(20)}`), bot(`a${i} ${pad(20)}`));
  const first = fitHistory(h, 300, cost);
  assert.ok(first.dropped > 0);
  const head = JSON.stringify(first.msgs[0] ?? null);
  const longer = [...h, user(`q10 ${pad(5)}`), bot(`a10 ${pad(5)}`)];
  const second = fitHistory(longer, 300, cost, first.window);
  same(JSON.stringify(second.msgs[0] ?? null), head);
  same(second.dropped, first.dropped);
});

test('a cut leaves room for several more turns instead of trimming one message per turn', () => {
  const h: Msg[] = [];
  for (let i = 0; i < 10; i++) h.push(user(`q${i} ${pad(20)}`), bot(`a${i} ${pad(20)}`));
  const r = fitHistory(h, 300, cost);
  assert.ok(total(r.msgs) <= 300 * 0.75, `${total(r.msgs)} tokens kept`);
  same((r.msgs[0] as Msg).role, 'user');
});

test('a history that fits again starts from the beginning', () => {
  const h = [user('hi'), bot('hello'), user('again')];
  const r = fitHistory(h, 1000, cost, { start: 2, stripBefore: 2 });
  same(r.msgs.length, 3);
  same([r.dropped, r.stripped], [0, 0]);
});

test('stripped images stay stripped on later turns', () => {
  const img = { type: 'image_url' as const, image_url: { url: 'data:x' } };
  const h: Msg[] = [{ role: 'user', content: [img, { type: 'text', text: 'look' }] }, bot('a cat'), user(pad(30)), bot('ok'), user('next')];
  const r = fitHistory(h, 120, cost);
  same(r.stripped, 1);
  const again = fitHistory([...h, bot('sure'), user('more')], 120, cost, r.window);
  assert.ok(!JSON.stringify(again.msgs).includes('image_url'));
});

test('selectPages starts from the best-matching pages, then the opening pages', () => {
  same(selectPages([p(1, 7), p(1, 3)], [], [p(1, 1), p(1, 2), p(1, 3)], 4), [p(1, 7), p(1, 3), p(1, 1), p(1, 2)]);
  same(selectPages([], [], [p(1, 1), p(1, 2), p(1, 3)], 2), [p(1, 1), p(1, 2)]);
  same(selectPages([p(1, 1)], [], [], 0), []);
});

test('selectPages keeps the chosen pages while the best matches are already among them', () => {
  const cur = [p(1, 7), p(1, 3), p(1, 1)];
  same(selectPages([p(1, 3), p(1, 1)], cur, [p(1, 1)], 3), cur);
  same(selectPages([], cur, [p(1, 1)], 3), cur);
});

test('selectPages brings in new best matches and lets the oldest pages go', () => {
  const cur = [p(1, 7), p(1, 3), p(1, 1)];
  same(selectPages([p(1, 9), p(1, 3)], cur, [], 3), [p(1, 9), p(1, 7), p(1, 3)]);
});

test("assemble keeps stable text first, puts this turn's excerpts with the question, and lists pages by number", () => {
  const msgs = assemble({
    system: 'Be brief.',
    docs: '[Document: a.txt]\nall of it',
    pages: [
      {
        name: 'm.pdf',
        pages: [
          { page: 2, url: 'data:p2' },
          { page: 5, url: 'data:p5' },
        ],
      },
    ],
    history: [user('earlier'), bot('reply'), { role: 'user', content: [{ type: 'text', text: 'and now?', voice: true }] }],
    excerpts: '[Document: b.txt, part 3]\nthe launch window',
  });
  const sys = msgs[0];
  same(sys?.role, 'system');
  assert.ok(JSON.stringify(sys?.content ?? null).includes('all of it'));
  assert.ok(!JSON.stringify(sys?.content ?? null).includes('launch window'));
  same(msgs[1]?.role, 'user');
  const lead = JSON.stringify(msgs[1]?.content ?? null);
  assert.ok(lead.includes('Page 2') && lead.includes('data:p5') && lead.includes('m.pdf'));
  same(msgs[2]?.role, 'assistant');
  same(msgs[3]?.content, 'earlier');
  const last = JSON.stringify(msgs[msgs.length - 1]?.content ?? null);
  assert.ok(last.includes('launch window') && last.indexOf('launch window') < last.indexOf('and now?'));
  assert.ok(!last.includes('voice'));
});

test('assemble without documents is the system prompt and the history', () => {
  const msgs = assemble({ system: 'S', docs: '', pages: [], history: [user('hi')], excerpts: '' });
  same(msgs, [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'hi' },
  ]);
});
