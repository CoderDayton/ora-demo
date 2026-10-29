import assert from 'node:assert';
import { test } from 'node:test';
import { startsToolMarkup, textToolCalls } from '../../src/server/chat/markup.ts';

function same(actual: unknown, expected: unknown): void {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}

test('a tool call written as text becomes a call with JSON arguments', () => {
  const text = '<tool_call>\n<function=web_search>\n<parameter=query>\nJapan population 2026\n</parameter>\n</function>\n</tool_call>';
  same(textToolCalls(text), [{ id: '', name: 'web_search', args: '{"query":"Japan population 2026"}' }]);
});

test('several calls and several parameters are all read, and surrounding prose is ignored', () => {
  const text =
    'Let me check.\n<tool_call>\n<function=read_document>\n<parameter=document>\nnotes.txt\n</parameter>\n<parameter=part>\n2\n</parameter>\n</function>\n</tool_call>' +
    '<tool_call><function=current_time></function></tool_call>';
  same(textToolCalls(text), [
    { id: '', name: 'read_document', args: '{"document":"notes.txt","part":"2"}' },
    { id: '', name: 'current_time', args: '{}' },
  ]);
});

test('text without a complete call gives none', () => {
  same(textToolCalls('The weather is fine.'), []);
  same(textToolCalls('<tool_call>\n<function=web_search>\n<parameter=query>\ncut off'), []);
});

test('a reply that begins like a tool call is held back, one that merely mentions it is not', () => {
  assert.ok(startsToolMarkup('<tool_call>\n<fun'));
  assert.ok(startsToolMarkup('  <tool'));
  assert.ok(startsToolMarkup('<'));
  assert.ok(!startsToolMarkup('Use the <tool_call> tag'));
  assert.ok(!startsToolMarkup('Hello'));
});
