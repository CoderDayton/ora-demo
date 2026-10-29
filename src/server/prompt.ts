// The prompt for one reply. llama-server reuses its work on a prompt up to the first token that differs, so the
// start is kept the same from turn to turn and each reply only reads what is new.
export type Part =
  | { type: 'text'; text: string; voice?: boolean }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };
export interface Msg {
  role: 'user' | 'assistant' | 'system';
  content: string | Part[];
}

// The wire format: only the fields llama-server defines.
export type ApiPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };
export interface ApiMsg {
  role: string;
  content: string | ApiPart[];
}

export interface Cost {
  charsPerToken: number;
  imageTokens: number;
  scale: number;
}
// Where the history sent to the model starts, and before which message its images are left out. Kept per chat.
export interface Window {
  start: number;
  stripBefore: number;
}
export interface Fit {
  msgs: Msg[];
  window: Window;
  dropped: number;
  stripped: number;
}
export interface PageRef {
  docId: number;
  page: number;
}
export interface PageGroup {
  name: string;
  pages: { page: number; url: string }[];
}
export interface PromptParts {
  system: string;
  docs: string;
  pages: PageGroup[];
  history: Msg[];
  excerpts: string;
}

const IMAGE_OMITTED: Part = { type: 'text', text: '[image omitted to save context]' };
// A trim cuts the history to this share of the budget, so the next turns fit without moving its start again.
const TRIM_TO = 0.75;
// How many of a question's best-matching pages it may bring into the pages already chosen.
const TOP_PAGES = 4;
const DOCS_NOTE = 'The user uploaded reference documents. Use them to answer and name the document you rely on.';
const EXCERPTS_NOTE = "Excerpts from the user's reference documents that may help with this message. Name the document you rely on.";

const textTokens = (s: string, c: Cost): number => Math.ceil((s.length / c.charsPerToken) * c.scale);

export function estTokens(m: Msg, c: Cost): number {
  if (typeof m.content === 'string') return textTokens(m.content, c) + 6;
  let n = 6;
  for (const p of m.content) {
    n += p.type === 'text' ? textTokens(p.text, c) : p.type === 'input_audio' ? Math.ceil(p.input_audio.data.length / 3300) : c.imageTokens;
  }
  return n;
}

const hasImage = (m: Msg): boolean => typeof m.content !== 'string' && m.content.some((p: Part) => p.type === 'image_url');
const stripImages = (m: Msg): Msg =>
  typeof m.content === 'string' ? m : { role: m.role, content: m.content.map((p: Part) => (p.type === 'image_url' ? IMAGE_OMITTED : p)) };

// Trims a copy of the history to fit the budget: images go first, oldest first (the assistant's description of
// each stays in the text), then whole messages from the oldest end, starting on a user turn. The newest message is
// always kept. `prev` is the window of the chat's previous reply: it is kept while the history fits, and a new trim
// cuts to well under the budget, so the start of the prompt moves rarely.
export function fitHistory(hist: Msg[], budget: number, c: Cost, prev?: Window): Fit {
  const whole = hist.reduce((a: number, m: Msg) => a + estTokens(m, c), 0);
  if (!hist.length || whole <= budget) return { msgs: hist.slice(), window: { start: 0, stripBefore: 0 }, dropped: 0, stripped: 0 };
  const last = hist.length - 1;
  let start = Math.min(prev?.start ?? 0, last);
  let stripBefore = Math.min(Math.max(prev?.stripBefore ?? 0, start), last);
  const at = (i: number): Msg => (i < stripBefore ? stripImages(hist[i] as Msg) : (hist[i] as Msg));
  let tot = 0;
  for (let i = start; i <= last; i++) tot += estTokens(at(i), c);

  if (tot > budget) {
    const target = budget * TRIM_TO;
    for (; stripBefore < last && tot > target; stripBefore++) {
      const m = hist[stripBefore] as Msg;
      if (stripBefore >= start && hasImage(m)) tot += estTokens(stripImages(m), c) - estTokens(m, c);
    }
    for (; start < last && tot > target; start++) tot -= estTokens(at(start), c);
    while (start < last && (hist[start] as Msg).role !== 'user') start++;
    stripBefore = Math.max(stripBefore, start);
  }

  const msgs: Msg[] = [];
  let stripped = 0;
  for (let i = start; i <= last; i++) {
    msgs.push(at(i));
    if (i < stripBefore && hasImage(hist[i] as Msg)) stripped++;
  }
  return { msgs, window: { start, stripBefore }, dropped: start, stripped };
}

// `scale` multiplies the character-based estimate. After a reply the server reports the real prompt size, so the
// scale moves toward the measured ratio (within 0.5 to 2.5) and the next estimate is closer.
export function calibrate(scale: number, estimated: number, actual: number): number {
  if (!(estimated > 0) || !(actual > 0)) return scale;
  const next = scale + (scale * (actual / estimated) - scale) * 0.6;
  return Math.min(2.5, Math.max(0.5, next));
}

export function toApi(msgs: Msg[]): ApiMsg[] {
  return msgs.map(
    (m: Msg): ApiMsg => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p: Part): ApiPart => {
              if (p.type === 'text') return { type: 'text', text: p.text };
              if (p.type === 'image_url') return { type: 'image_url', image_url: { url: p.image_url.url } };
              return { type: 'input_audio', input_audio: { data: p.input_audio.data, format: p.input_audio.format } };
            }),
    }),
  );
}

const samePage = (a: PageRef, b: PageRef): boolean => a.docId === b.docId && a.page === b.page;
const hasPage = (list: PageRef[], x: PageRef): boolean => list.some((y: PageRef) => samePage(x, y));

// Chooses the PDF pages sent with a reply, most recently brought in first. Pages sit early in the prompt, where a
// change means everything after them is read again, so the chosen pages stay while a question's best matches are
// among them; a question whose best matches are missing brings them in and the oldest pages make room. With nothing
// chosen yet, the best matches come first and the opening pages fill the rest.
export function selectPages(ranked: PageRef[], current: PageRef[], fallback: PageRef[], room: number): PageRef[] {
  if (room <= 0) return [];
  const out: PageRef[] = [];
  if (!current.length) {
    for (const x of [...ranked, ...fallback]) if (out.length < room && !hasPage(out, x)) out.push(x);
    return out;
  }
  const fresh = ranked.slice(0, Math.min(room, TOP_PAGES)).filter((x: PageRef) => !hasPage(current, x));
  if (!fresh.length) return current.slice(0, room);
  out.push(...fresh);
  for (const x of current) if (out.length < room && !hasPage(out, x)) out.push(x);
  return out;
}

// Only the excerpts change with every question, so they go last, in front of the newest user message.
export function assemble(o: PromptParts): ApiMsg[] {
  const out: ApiMsg[] = [{ role: 'system', content: o.docs ? `${o.system}\n\n${DOCS_NOTE}\n\n${o.docs}` : o.system }];
  for (const g of o.pages) {
    if (!g.pages.length) continue;
    const parts: ApiPart[] = [{ type: 'text', text: `Pages ${g.pages.map(p => p.page).join(', ')} of the document "${g.name}":` }];
    for (const p of g.pages) {
      parts.push({ type: 'text', text: `Page ${p.page}:` });
      parts.push({ type: 'image_url', image_url: { url: p.url } });
    }
    out.push({ role: 'user', content: parts });
    out.push({ role: 'assistant', content: `I have read those pages of "${g.name}".` });
  }
  const hist = toApi(o.history);
  const lastMsg = hist[hist.length - 1];
  if (o.excerpts && lastMsg && lastMsg.role === 'user') {
    const note = `${EXCERPTS_NOTE}\n\n${o.excerpts}\n\n---\n\n`;
    const content = lastMsg.content;
    hist[hist.length - 1] = {
      role: 'user',
      content: typeof content === 'string' ? `${note}${content}` : [{ type: 'text', text: note }, ...content],
    };
  }
  return [...out, ...hist];
}
