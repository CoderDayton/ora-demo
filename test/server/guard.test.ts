import assert from 'node:assert';
import { test } from 'node:test';
import { dropEchoes, dropRepeats, echoes, lastTurns, recap } from '../../src/server/chat/guard.ts';
import type { Msg } from '../../src/server/chat/prompt.ts';

function same(actual: unknown, expected: unknown): void {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}

const u = (text: string): Msg => ({ role: 'user', content: text });
const a = (text: string): Msg => ({ role: 'assistant', content: text });
const texts = (h: Msg[]): string[] => h.map(m => (typeof m.content === 'string' ? m.content : ''));

const ID = "I'm LFM, the Liquid Foundation Model built by Liquid AI. I'm happy to help with whatever you need!";

test('replies that occur more than once are left out with the questions they answered', () => {
  const h = [u('one'), a(ID), u('two'), a('Two is a number, the one after one.'), u('three'), a(ID), u('four')];
  same(texts(dropRepeats(h)), ['two', 'Two is a number, the one after one.', 'four']);
});

test('short or unique replies are kept, and the open question is never dropped', () => {
  const h = [u('hi'), a('Hello!'), u('hi'), a('Hello!'), u('what now')];
  same(texts(dropRepeats(h)), ['hi', 'Hello!', 'hi', 'Hello!', 'what now']);
});

test('a tool turn is dropped whole when its reply repeats', () => {
  const call: Msg = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }],
  };
  const res: Msg = { role: 'tool', content: 'r', tool_call_id: 'c' };
  const h = [u('a'), a(ID), u('b'), call, res, a(ID), u('c')];
  same(texts(dropRepeats(h)), ['c']);
});

test('echoes sees a reply that starts like an earlier one', () => {
  const h = [u('x'), a(ID), u('y')];
  assert.equal(echoes("I'm LFM, the Liquid Foundation Model built by", h), true);
  assert.equal(echoes('The price of LTC is about eighty dollars.', h), false);
  assert.equal(echoes('Hi', h), false);
});

test('dropEchoes removes the turns whose reply starts like the new one', () => {
  const h = [u('x'), a(ID), u('y'), a('Fine, thanks for asking about it.'), u('z')];
  same(texts(dropEchoes(h, "I'm LFM, the Liquid Foundation Model built by Liquid AI.")), ['y', 'Fine, thanks for asking about it.', 'z']);
});

test('lastTurns keeps the newest turns and always starts on a question', () => {
  const h = [u('1'), a('A1'), u('2'), a('A2'), u('3')];
  same(texts(lastTurns(h, 1)), ['2', 'A2', '3']);
  same(texts(lastTurns(h, 9)), ['1', 'A1', '2', 'A2', '3']);
  same(texts(lastTurns(h, 0)), ['3']);
});

test('recap lists the latest earlier turns, newest first, shortened', () => {
  const h = [u('first question'), a('first answer'), u('second question'), a('x'.repeat(200)), u('now')];
  const r = recap(h, 5);
  same(r.length, 2);
  assert.ok((r[0] as string).startsWith('1. user: second question | you: xxx'));
  assert.ok((r[0] as string).length < 140);
  assert.ok((r[1] as string).startsWith('2. user: first question'));
});
