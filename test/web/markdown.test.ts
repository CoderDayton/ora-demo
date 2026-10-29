import assert from 'node:assert';
import { test } from 'node:test';
import { MarkdownStream, parseMarkdown } from '../../src/web/chat/markdown.ts';

const t = (v: string) => ({ t: 'text', v });
const li = (v: string) => ({ c: [t(v)] });

test('plain text is one paragraph and keeps its line breaks', () => {
  assert.deepStrictEqual(parseMarkdown('hello\nworld'), [{ t: 'p', c: [t('hello\nworld')] }]);
});

test('blank lines separate paragraphs', () => {
  assert.strictEqual(parseMarkdown('one\n\ntwo').length, 2);
});

test('bold, italic and inline code', () => {
  const [b] = parseMarkdown('a **bold** and *soft* and `x = 1` end');
  assert.deepStrictEqual(b, {
    t: 'p',
    c: [t('a '), { t: 'strong', v: 'bold' }, t(' and '), { t: 'em', v: 'soft' }, t(' and '), { t: 'code', v: 'x = 1' }, t(' end')],
  });
});

test('markers inside code are not formatting', () => {
  const [b] = parseMarkdown('`**no**`');
  assert.deepStrictEqual(b, { t: 'p', c: [{ t: 'code', v: '**no**' }] });
});

test('math and snake_case are not italics', () => {
  assert.deepStrictEqual(parseMarkdown('2 * 3 * 4 and snake_case_name'), [{ t: 'p', c: [t('2 * 3 * 4 and snake_case_name')] }]);
});

test('an unfinished marker stays literal while a reply is still streaming', () => {
  assert.deepStrictEqual(parseMarkdown('this is **half'), [{ t: 'p', c: [t('this is **half')] }]);
});

test('headings', () => {
  assert.deepStrictEqual(parseMarkdown('## Title\ntext')[0], { t: 'h', n: 2, c: [t('Title')] });
});

test('bullet and numbered lists', () => {
  assert.deepStrictEqual(parseMarkdown('- a\n- b'), [{ t: 'ul', items: [li('a'), li('b')] }]);
  assert.deepStrictEqual(parseMarkdown('1. a\n2) b'), [{ t: 'ol', start: 1, items: [li('a'), li('b')] }]);
});

test('fenced code keeps its text exactly, and an open fence runs to the end', () => {
  assert.deepStrictEqual(parseMarkdown('```ts\nlet a = 1;\n  b\n```'), [{ t: 'code', lang: 'ts', v: 'let a = 1;\n  b' }]);
  assert.deepStrictEqual(parseMarkdown('```\nstill typing'), [{ t: 'code', lang: '', v: 'still typing' }]);
});

test('quotes', () => {
  assert.deepStrictEqual(parseMarkdown('> wise words'), [{ t: 'quote', c: [t('wise words')] }]);
});

test('html is just text: the parser never produces markup', () => {
  assert.deepStrictEqual(parseMarkdown('<img src=x onerror=alert(1)>'), [{ t: 'p', c: [t('<img src=x onerror=alert(1)>')] }]);
});

test('blank lines between list items do not split the list, and numbering keeps its start', () => {
  const [l] = parseMarkdown('1. a\n\n2. b\n\n3. c');
  assert.deepStrictEqual(l, { t: 'ol', start: 1, items: [li('a'), li('b'), li('c')] });
  assert.deepStrictEqual(parseMarkdown('3. x\n4. y')[0], { t: 'ol', start: 3, items: [li('x'), li('y')] });
});

test('a paragraph after a list is not swallowed by it', () => {
  assert.deepStrictEqual(
    parseMarkdown('- a\n\nafter').map(b => b.t),
    ['ul', 'p'],
  );
});

test('fences accept info strings and longer fences', () => {
  assert.deepStrictEqual(parseMarkdown('```c++\nint x;\n```')[0], { t: 'code', lang: 'c++', v: 'int x;' });
  assert.deepStrictEqual(parseMarkdown('```js title="a.js"\nlet a;\n```')[0], { t: 'code', lang: 'js', v: 'let a;' });
  assert.deepStrictEqual(parseMarkdown('````\nx\n````')[0], { t: 'code', lang: '', v: 'x' });
});

test('deeper headings are headings, shown at the smallest size', () => {
  assert.deepStrictEqual(parseMarkdown('#### Deep')[0], { t: 'h', n: 3, c: [t('Deep')] });
});

test('italic text may contain bold', () => {
  assert.deepStrictEqual(parseMarkdown('*a **b** c*')[0], { t: 'p', c: [{ t: 'em', v: 'a **b** c' }] });
});

test('indented items nest under the item above them', () => {
  assert.deepStrictEqual(parseMarkdown('- a\n  - a1\n  - a2\n- b'), [
    {
      t: 'ul',
      items: [{ c: [t('a')], sub: [{ t: 'ul', items: [li('a1'), li('a2')] }] }, li('b')],
    },
  ]);
  assert.deepStrictEqual(parseMarkdown('1. step\n   - detail\n2. next')[0], {
    t: 'ol',
    start: 1,
    items: [{ c: [t('step')], sub: [{ t: 'ul', items: [li('detail')] }] }, li('next')],
  });
});

test('a code block indented under an item belongs to that item', () => {
  const [l] = parseMarkdown('- run:\n\n  ```sh\n  npm test\n  ```\n- done');
  assert.deepStrictEqual(l, { t: 'ul', items: [{ c: [t('run:')], sub: [{ t: 'code', lang: 'sh', v: 'npm test' }] }, li('done')] });
});

const SAMPLE = [
  '# Plan',
  '',
  'Some **bold** text and `code`.',
  'Second line.',
  '',
  '- one',
  '- two',
  '  - nested',
  '',
  '- three',
  '',
  '1. first',
  '',
  '2. second',
  '',
  '```ts',
  'const a = 1;',
  '',
  'const b = 2;',
  '```',
  '',
  '> quote',
  'after quote',
  '',
  'Final *words* here.',
].join('\n');

for (const step of [1, 2, 5, 13]) {
  test(`streaming in chunks of ${step} gives the same blocks as parsing the whole text each time`, () => {
    const s = new MarkdownStream();
    for (let n = step; n < SAMPLE.length + step; n += step) {
      const text = SAMPLE.slice(0, n);
      const r = s.update(text);
      assert.deepStrictEqual(r.blocks, parseMarkdown(text), `at ${n} chars`);
      assert.ok(r.changedFrom >= 0 && r.changedFrom <= r.blocks.length);
    }
  });
}

test('the stream only re-parses the unfinished tail', () => {
  const s = new MarkdownStream();
  s.update('para one\n\npara two\n\npara thr');
  const r = s.update('para one\n\npara two\n\npara three');
  assert.strictEqual(r.changedFrom, 2);
});

test('the stream starts over when the text is not a continuation', () => {
  const s = new MarkdownStream();
  s.update('first reply\n\nmore');
  assert.deepStrictEqual(s.update('other').blocks, parseMarkdown('other'));
});
