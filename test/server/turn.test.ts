import assert from 'node:assert';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { TurnRequest } from '../../src/server/chat/turn.ts';
import { Cancel, parseTurn, Turns, transcribe } from '../../src/server/chat/turn.ts';
import { ingestPdf, PageRenderer } from '../../src/server/docs/pages.ts';
import type { Store } from '../../src/server/store/store.ts';
import { openStore } from '../../src/server/store/store.ts';

function same(actual: unknown, expected: unknown): void {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

// Stands in for llama-server. Records each completion request body as sent; `opts.mode` picks how it answers.
class Opts {
  mode = 'ok';
  vision = true;
  nctx = 4096;
}

interface Fake {
  server: Server;
  bodies: string[];
  opts: Opts;
}

function handle(req: IncomingMessage, res: ServerResponse, opts: Opts, bodies: string[]): void {
  if (req.url === '/props') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ default_generation_settings: { n_ctx: opts.nctx }, modalities: { vision: opts.vision, audio: true } }));
    return;
  }
  let raw = '';
  req.on('data', (d: Buffer) => {
    raw += d.toString();
  });
  req.on('end', () => {
    bodies.push(raw);
    const stream = (JSON.parse(raw) as Record<string, unknown>).stream === true;
    if (opts.mode === 'error') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'context too long' } }));
      return;
    }
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '  hello there \n' } }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (content: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
    if (opts.mode === 'slow') {
      const t = setInterval(() => res.write(chunk('word ')), 15);
      res.on('close', () => clearInterval(t));
      return;
    }
    res.write(chunk('Hel'));
    res.write(chunk('lo.'));
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 120, completion_tokens: 2, total_tokens: 122 },
        timings: { cache_n: 90, prompt_n: 30, predicted_per_second: 55, prompt_per_second: 900 },
      })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
}

async function fakeLlama(port: number): Promise<Fake> {
  const bodies: string[] = [];
  const opts = new Opts();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res, opts, bodies);
  });
  await new Promise<void>(ok => {
    server.listen(port, '127.0.0.1', () => ok());
  });
  return { server, bodies, opts };
}

// Closes the fake server even when the test fails, so a failure cannot keep the test process alive.
async function withLlama(port: number, fn: (llama: Fake) => Promise<void>): Promise<void> {
  const llama = await fakeLlama(port);
  try {
    await fn(llama);
  } finally {
    llama.server.close();
  }
}

const bodyOf = (f: Fake, i: number): Record<string, unknown> => JSON.parse(f.bodies[i] ?? '{}') as Record<string, unknown>;

type Ev = Record<string, unknown>;

function setup(port: number, store: Store, slots = 2): { turns: Turns; renderer: PageRenderer } {
  const renderer = new PageRenderer(store, null);
  const tools = { allowed: [], workDir: '', searchUrl: '' };
  return { turns: new Turns({ store, pages: renderer, llamaPort: port, slots: () => slots, tools }), renderer };
}

function ask(text: string, chatId: number | null, extra: Record<string, unknown> = {}): TurnRequest {
  return parseTurn({ chatId, text, system: 'Be brief.', temperature: 0.7, maxTokens: 256, ...extra });
}

async function run(turns: Turns, t: TurnRequest, cancel = new Cancel()): Promise<Ev[]> {
  const evs: Ev[] = [];
  await turns.run(
    t,
    (e: Record<string, unknown>) => {
      evs.push(e);
    },
    cancel,
  );
  return evs;
}

const messagesOf = (body: Record<string, unknown>): unknown[] => (Array.isArray(body.messages) ? body.messages : []);

function pdf(pages: string[]): Uint8Array {
  const kids: string[] = [];
  const body: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const page = 4 + i * 2;
    const stream = `BT /F1 24 Tf 72 700 Td (${pages[i]}) Tj ET`;
    kids.push(`${page} 0 R`);
    body.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    body.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...body,
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test('a turn stores the question and the reply, streams the words, and uses the chat slot with prompt caching', () =>
  withLlama(18941, async (llama: Fake) => {
    const store = openStore(':memory:');
    const { turns } = setup(18941, store);
    const evs = await run(turns, ask('What is the  launch   window?', null));
    const types = evs.map(e => e.type);
    same(types.slice(0, 2), ['chat', 'user']);
    same(
      evs.filter(e => e.type === 'delta').map(e => e.content),
      ['Hel', 'lo.'],
    );
    const done = evs[evs.length - 1] as Ev;
    same(done.type, 'done');
    same(done.cache, 0.75);
    const chat = store.listChats()[0];
    same(chat?.title, 'What is the launch window?');
    same(
      store.messages(chat?.id ?? 0).map(m => m.content),
      ['What is the  launch   window?', 'Hello.'],
    );
    const body = bodyOf(llama, 0);
    same([body?.id_slot, body?.cache_prompt, body?.stream, body?.max_tokens], [0, true, true, 256]);
  }));

test("the next turn sends the earlier messages unchanged, and this turn's excerpts only with the new question", () =>
  withLlama(18942, async (llama: Fake) => {
    const store = openStore(':memory:');
    const { turns } = setup(18942, store);
    const c = store.createChat('');
    const chunks: string[] = [];
    for (let i = 0; i < 60; i++) chunks.push(`filler paragraph number ${i} about nothing in particular `.repeat(6));
    chunks[10] = 'the launch window opens at dawn over the northern pad '.repeat(4);
    chunks[40] = 'the landing zone is a barge in the southern sea '.repeat(4);
    store.addDoc(c.id, 'big.txt', 'text', null, chunks);
    await run(turns, ask('When does the launch window open?', c.id));
    await run(turns, ask('Where is the landing zone?', c.id));
    const [one, two] = [messagesOf(bodyOf(llama, 0)), messagesOf(bodyOf(llama, 1))];
    same(two[0], one[0]);
    assert.ok(JSON.stringify(one[one.length - 1]).includes('opens at dawn'));
    same(two[1], { role: 'user', content: 'When does the launch window open?' });
    same(two[2], { role: 'assistant', content: 'Hello.' });
    const last = JSON.stringify(two[two.length - 1]);
    assert.ok(last.includes('barge in the southern sea') && !JSON.stringify(two.slice(0, -1)).includes('barge'));
  }));

test('with room for one page, the page that matches the question is sent, labelled by its number', () =>
  withLlama(18943, async (llama: Fake) => {
    llama.opts.nctx = 2048;
    const store = openStore(':memory:');
    const { turns, renderer } = setup(18943, store);
    const c = store.createChat('');
    const meta = await ingestPdf(store, renderer, c.id, 'm.pdf', pdf(['alpha intro', 'bravo details', 'charlie notes']), 1024, 200);
    await renderer.idle(meta.id);
    await run(turns, ask('tell me about bravo', c.id));
    const sent = JSON.stringify(messagesOf(bodyOf(llama, 0)));
    assert.ok(sent.includes('Page 2:') && !sent.includes('Page 1:'), sent.slice(0, 400));
    assert.ok(sent.includes('data:image/jpeg;base64,/9j/'));
    same(sent.split('"type":"image_url"').length - 1, 1);
  }));

test('an explicit page range is sent as given', () =>
  withLlama(18944, async (llama: Fake) => {
    const store = openStore(':memory:');
    const { turns, renderer } = setup(18944, store);
    const c = store.createChat('');
    const meta = await ingestPdf(store, renderer, c.id, 'm.pdf', pdf(['alpha', 'bravo', 'charlie']), 512, 200);
    await run(turns, ask('tell me about bravo', c.id, { ranges: { [String(meta.id)]: '3' } }));
    const sent = JSON.stringify(messagesOf(bodyOf(llama, 0)));
    assert.ok(sent.includes('Page 3:') && !sent.includes('Page 2:'));
  }));

test('a model without vision gets no pages, and the user is told', () =>
  withLlama(18945, async (llama: Fake) => {
    llama.opts.vision = false;
    const store = openStore(':memory:');
    const { turns, renderer } = setup(18945, store);
    const c = store.createChat('');
    await ingestPdf(store, renderer, c.id, 'm.pdf', pdf(['alpha']), 512, 200);
    const evs = await run(turns, ask('what is on the page?', c.id));
    assert.ok(!JSON.stringify(messagesOf(bodyOf(llama, 0))).includes('image_url'));
    assert.ok(evs.some(e => e.type === 'note' && String(e.text).includes('vision')));
  }));

test('cancelling mid-reply stops the model and keeps the words so far', () =>
  withLlama(18946, async (llama: Fake) => {
    llama.opts.mode = 'slow';
    const store = openStore(':memory:');
    const { turns } = setup(18946, store);
    const cancel = new Cancel();
    const evs: Ev[] = [];
    await turns.run(
      ask('keep talking', null),
      (e: Record<string, unknown>) => {
        evs.push(e);
        if (evs.filter(x => x.type === 'delta').length === 3) cancel.cancel();
      },
      cancel,
    );
    const chat = store.listChats()[0];
    const reply = store.messages(chat?.id ?? 0)[1]?.content;
    assert.ok(typeof reply === 'string' && reply.startsWith('word word word'), String(reply));
  }));

test('an upstream error is reported and no reply is stored', () =>
  withLlama(18947, async (llama: Fake) => {
    llama.opts.mode = 'error';
    const store = openStore(':memory:');
    const { turns } = setup(18947, store);
    const evs = await run(turns, ask('hello', null));
    const done = evs[evs.length - 1] as Ev;
    same([done.type, done.error], ['done', 'context too long']);
    same(store.messages(store.listChats()[0]?.id ?? 0).length, 1);
  }));

test('transcribe sends the audio on its own slot and returns the trimmed words', () =>
  withLlama(18948, async (llama: Fake) => {
    same(await transcribe(18948, 2, 'UklGRg==', new Cancel()), 'hello there');
    same(bodyOf(llama, 0).id_slot, 1);
    same(bodyOf(llama, 0).temperature, 0);
    await transcribe(18948, 1, 'UklGRg==', new Cancel());
    same(bodyOf(llama, 1).id_slot, 0);
  }));

test('transcribe limits the words to what the clip length can hold, so noise cannot run on', () =>
  withLlama(18949, async (llama: Fake) => {
    await transcribe(18949, 2, 'UklGRg==', new Cancel());
    same(bodyOf(llama, 0).max_tokens, 32);
    await transcribe(18949, 2, 'A'.repeat(427000), new Cancel());
    same(bodyOf(llama, 1).max_tokens, 85);
    await transcribe(18949, 2, 'A'.repeat(8000000), new Cancel());
    same(bodyOf(llama, 2).max_tokens, 400);
  }));

test('parseTurn refuses a turn with nothing to say and bounds the settings', () => {
  let msg = '';
  try {
    parseTurn({ chatId: null, text: '  ' });
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  assert.ok(msg.length > 0);
  const t = parseTurn({ chatId: 3, text: 'hi', maxTokens: 1e9, temperature: -4, images: ['data:image/jpeg;base64,xx', 'http://evil'] });
  same([t.chatId, t.maxTokens, t.temperature, t.images], [3, 8192, 0, ['data:image/jpeg;base64,xx']]);
});
