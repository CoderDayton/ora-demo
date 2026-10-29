// The transcript: messages as DOM, Markdown rendering and scrolling.
import { Orb } from '../orb/orb.ts';
import { $, S } from '../state.ts';
import type { Block, Inline, ListItem } from './markdown.ts';
import { MarkdownStream } from './markdown.ts';

export const logEl = $('#log');
export const scrollEnd = (): void => {
  logEl.scrollTop = logEl.scrollHeight;
};
// Replies are shown as Markdown. The parser returns data and elements are built with textContent, so model
// output can never inject markup.
const inlineNodes = (parts: Inline[]): Node[] =>
  parts.map(p => {
    if (p.t === 'text') return document.createTextNode(p.v);
    const e = document.createElement(p.t === 'code' ? 'code' : p.t === 'strong' ? 'strong' : 'em');
    e.textContent = p.v;
    return e;
  });
function itemEl(it: ListItem): HTMLElement {
  const li = document.createElement('li');
  li.append(...inlineNodes(it.c));
  if (it.sub) li.append(...it.sub.map(blockEl));
  return li;
}
function blockEl(b: Block): HTMLElement {
  if (b.t === 'code') {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = b.v;
    pre.appendChild(code);
    return pre;
  }
  if (b.t === 'ul' || b.t === 'ol') {
    const list = document.createElement(b.t);
    for (const it of b.items) list.appendChild(itemEl(it));
    if (b.t === 'ol' && b.start !== 1) (list as HTMLOListElement).start = b.start;
    return list;
  }
  const e = document.createElement(b.t === 'h' ? `h${b.n}` : b.t === 'quote' ? 'blockquote' : 'p');
  e.append(...inlineNodes(b.c));
  return e;
}
// Each message keeps its own stream parser, so a growing reply rebuilds only the blocks that can still change and
// the finished ones keep their nodes (and any text selection in them).
const streams = new WeakMap<HTMLElement, MarkdownStream>();
const rendered = new WeakMap<HTMLElement, number>();
export function mdInto(el: HTMLElement, text: string): void {
  el.classList.add('md');
  let stream = streams.get(el);
  if (!stream) {
    stream = new MarkdownStream();
    streams.set(el, stream);
  }
  const { blocks, changedFrom } = stream.update(text);
  const keep = el.childNodes.length === (rendered.get(el) ?? 0) ? Math.min(changedFrom, el.childNodes.length) : 0;
  if (!keep) el.replaceChildren();
  rendered.set(el, blocks.length);
  while (el.childNodes.length > keep) (el.lastChild as ChildNode).remove();
  el.append(...blocks.slice(keep).map(blockEl));
}
// While a reply streams it is re-rendered at most every 120 ms, and the view follows it only if the reader is at the bottom.
let mdTimer = 0;
export const nearBottom = (): boolean => logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
export function mdSoon(el: HTMLElement, getText: () => string): void {
  if (mdTimer) return;
  mdTimer = window.setTimeout(() => {
    mdTimer = 0;
    const follow = nearBottom();
    mdInto(el, getText());
    if (follow) scrollEnd();
  }, 120);
}
export function cancelMdSoon(): void {
  clearTimeout(mdTimer);
  mdTimer = 0;
}

export function addMsg(role: string, text: string, cls = ''): HTMLElement {
  const d = document.createElement('div');
  d.className = `msg ${role} ${cls}`.trim();
  if (role === 'assistant' && text) mdInto(d, text);
  else d.textContent = text;
  logEl.appendChild(d);
  scrollEnd();
  return d;
}
export function note(text: string, isErr = false): void {
  addMsg('note', text, isErr ? 'err' : '');
  if (isErr) Orb.error();
}
// Late-bound: tools.ts draws saved tool steps and imports this file.
export const logHooks = { steps: (_steps: unknown): void => undefined };
export function renderLog(): void {
  document.body.classList.toggle('chatting', S.hist.length > 0);
  logEl.innerHTML = '';
  for (const m of S.hist) {
    if (m.role === 'tool') {
      logHooks.steps(m.content);
      continue;
    }
    const d = addMsg(m.role, typeof m.content === 'string' ? m.content : '');
    if (typeof m.content === 'string') continue;
    for (const p of m.content) {
      if (p.type === 'image_url') {
        const im = new Image();
        im.src = p.image_url.url;
        d.prepend(im);
      } else if (p.type === 'input_audio') d.appendChild(document.createTextNode('(voice message) '));
      else {
        d.appendChild(document.createTextNode(p.text));
        if (p.voice) d.classList.add('voice');
      }
    }
  }
}
