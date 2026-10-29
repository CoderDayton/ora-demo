import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makePlan, parsePlan } from '../../src/server/chat/plan.ts';
import { Cancel, parseTurn, Turns } from '../../src/server/chat/turn.ts';
import { PageRenderer } from '../../src/server/docs/pages.ts';
import { openStore } from '../../src/server/store/store.ts';

function same(actual: unknown, expected: unknown): void {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

const GROUPS = ['docs', 'utility', 'web'];

test('a plan is read from JSON, clamped, and limited to the groups on offer', () => {
  same(parsePlan('{"temperature":0.2,"maxTokens":300,"tools":["web","system","x"],"pageShare":0.3,"speed":1.3,"pauseMs":1200}', GROUPS), {
    temperature: 0.2,
    maxTokens: 300,
    tools: ['web'],
    pageShare: 0.3,
    speed: 1.3,
    pauseMs: 1200,
  });
  same(parsePlan('{"temperature":9,"maxTokens":5,"pageShare":2,"speed":0.1,"pauseMs":10}', GROUPS), {
    temperature: 1.2,
    maxTokens: 64,
    pageShare: 0.6,
    speed: 0.9,
    pauseMs: 600,
  });
});

test('a plan can use plain words, which a small model fills in more sensibly than numbers', () => {
  same(
    parsePlan('{"length":"long","tone":"creative","tools":["web"],"pages":"many","speed":"fast","wait":"long","memory":"recent"}', GROUPS),
    {
      temperature: 1,
      maxTokens: 1200,
      tools: ['web'],
      pageShare: 0.5,
      speed: 1.3,
      pauseMs: 1400,
      memory: 3,
    },
  );
  same(parsePlan('{"length":"normal","tone":"balanced","speed":"normal","wait":"normal","memory":"all","pages":"some"}', GROUPS), {
    temperature: 0.7,
    maxTokens: 400,
    pageShare: 0.3,
  });
  same(parsePlan('{"length":"enormous","memory":"new","speed":"slow"}', GROUPS), { speed: 0.95, memory: 1 });
});

test('a plan tolerates what the small model really writes: a tools string, and words followed by an explanation', () => {
  same(
    parsePlan(
      '{"tools":"web, utility, nope","tone":"precise for facts, maths and code","memory":"all, recent for the last few","length":"short for a quick answer"}',
      GROUPS,
    ),
    {
      temperature: 0.2,
      maxTokens: 160,
      tools: ['web', 'utility'],
    },
  );
  same(parsePlan('{"memory":"recent for the last few earlier turns listed","tools":"web"}', GROUPS), { tools: ['web'], memory: 3 });
});

test('memory is how many earlier turns the question depends on, a whole number from 1 to 8', () => {
  same(parsePlan('{"memory":3.6}', GROUPS), { memory: 4 });
  same(parsePlan('{"memory":0}', GROUPS), { memory: 1 });
  same(parsePlan('{"memory":99}', GROUPS), { memory: 8 });
  same(parsePlan('{"memory":"all"}', GROUPS), {});
});

test('a plan survives prose and code fences around the JSON, and bad output is an empty plan', () => {
  same(parsePlan('Sure!\n```json\n{"temperature":0.5}\n```', GROUPS), { temperature: 0.5 });
  same(parsePlan('not json at all', GROUPS), {});
  same(parsePlan('{"temperature":"hot","tools":"web"}', GROUPS), { tools: ['web'] });
  same(parsePlan('{"temperature":"hot","tools":7}', GROUPS), {});
  same(parsePlan('', GROUPS), {});
});

interface Fake {
  server: Server;
  planBodies: Record<string, unknown>[];
  chatBodies: Record<string, unknown>[];
}

async function withLlama(
  port: number,
  plan: string | string[],
  fn: (f: Fake) => Promise<void>,
  fail = false,
  delayMs = 0,
  replies: string[] = [],
): Promise<void> {
  const planBodies: Record<string, unknown>[] = [];
  const chatBodies: Record<string, unknown>[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ default_generation_settings: { n_ctx: 8192 }, modalities: { vision: false } }));
      return;
    }
    let raw = '';
    req.on('data', (d: Buffer) => {
      raw += d.toString();
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (body.stream !== true) {
        planBodies.push(body);
        if (fail) {
          res.writeHead(500);
          res.end('boom');
          return;
        }
        const answer = (): void => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: Array.isArray(plan) ? (plan.shift() ?? '') : plan } }] }));
        };
        if (delayMs) setTimeout(answer, delayMs);
        else answer();
        return;
      }
      chatBodies.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replies.shift() ?? 'ok' }, finish_reason: null }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 1 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(ok => {
    server.listen(port, '127.0.0.1', () => ok());
  });
  try {
    await fn({ server, planBodies, chatBodies });
  } finally {
    server.close();
  }
}

test('makePlan asks on the recognizer slot, without streaming, and returns the parsed plan', async () => {
  await withLlama(18960, '{"temperature":0.1,"tools":["web"]}', async f => {
    const p = await makePlan(18960, 2, 'what is the btc price', GROUPS, false, new Cancel());
    same(p, { temperature: 0.1, tools: ['web'] });
    const b = f.planBodies[0] as Record<string, unknown>;
    same([b.id_slot, b.temperature, b.stream === true], [1, 0, false]);
    assert.ok(JSON.stringify(b.messages).includes('what is the btc price'));
    assert.ok(JSON.stringify(b.messages).includes('docs, utility, web'));
  });
});

test('makePlan shows the model the latest earlier turns so it can pick the memory it needs', async () => {
  await withLlama(18969, '{"memory":2}', async f => {
    const p = await makePlan(18969, 2, 'and the second one?', GROUPS, false, new Cancel(), 4000, [
      '1. user: price of LTC | you: about 80',
      '2. user: hello | you: hi',
    ]);
    same(p, { memory: 2 });
    const text = JSON.stringify(f.planBodies[0]);
    assert.ok(text.includes('1. user: price of LTC | you: about 80'));
    assert.ok(text.includes('memory'));
  });
});

test('makePlan gives an empty plan when there is one slot or the call fails', async () => {
  await withLlama(18961, '{"temperature":0.1}', async f => {
    same(await makePlan(18961, 1, 'hi', GROUPS, false, new Cancel()), {});
    same(f.planBodies.length, 0);
  });
  await withLlama(
    18962,
    '',
    async () => {
      same(await makePlan(18962, 2, 'hi', GROUPS, false, new Cancel()), {});
    },
    true,
  );
});

test('a slow plan is given up on, and cancelling stops waiting for it', async () => {
  await withLlama(
    18968,
    '{"temperature":0.1}',
    async () => {
      const t0 = Date.now();
      same(await makePlan(18968, 2, 'hi', GROUPS, false, new Cancel(), 60), {});
      assert.ok(Date.now() - t0 < 350, 'gave up at the timeout');
      const c = new Cancel();
      setTimeout(() => c.cancel(), 40);
      const t1 = Date.now();
      same(await makePlan(18968, 2, 'hi', GROUPS, false, c, 5000), {});
      assert.ok(Date.now() - t1 < 350, 'stopped on cancel');
    },
    false,
    400,
  );
});

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ora-plan-'));

function setup(port: number, allowed: string[]): Turns {
  const store = openStore(tmp());
  return new Turns({
    store,
    pages: new PageRenderer(store, null),
    llamaPort: port,
    slots: () => 2,
    tools: { allowed, workDir: tmp(), searchUrl: '' },
  });
}

type Ev = Record<string, unknown>;
async function run(turns: Turns, body: Record<string, unknown>): Promise<Ev[]> {
  const evs: Ev[] = [];
  await turns.run(
    parseTurn({ system: 'be brief', maxTokens: 400, temperature: 0.7, ...body }),
    (e: Record<string, unknown>) => {
      evs.push(e);
    },
    new Cancel(),
  );
  return evs;
}
const toolNames = (b: Record<string, unknown>): string[] =>
  (Array.isArray(b.tools) ? (b.tools as Record<string, unknown>[]) : []).map(t => String((t.function as Record<string, unknown>).name));

test('with auto on, the plan sets temperature and tools for the reply and is sent to the page', async () => {
  await withLlama(18963, '{"temperature":0.2,"maxTokens":200,"tools":["utility"],"speed":1.3,"pauseMs":1400}', async f => {
    const evs = await run(setup(18963, ['docs', 'utility', 'web']), { text: 'what is 2+3', auto: true, tools: [], maxTokens: 1000 });
    const body = f.chatBodies[0] as Record<string, unknown>;
    // A short planned length would cut a tool call's arguments off, so it never goes below 512 while tools are on.
    same([body.temperature, body.max_tokens], [0.2, 512]);
    same(toolNames(body), ['current_time', 'calculate']);
    const plan = evs.find(e => e.type === 'plan') as Ev;
    same(plan.plan, { temperature: 0.2, maxTokens: 200, tools: ['utility'], speed: 1.3, pauseMs: 1400 });
    assert.ok(JSON.stringify(body.messages).includes('When a task needs tools'));
  });
});

test('the plan cannot raise the limits the user set, add a group the config forbids, or reach shell and files unasked', async () => {
  await withLlama(18964, '{"maxTokens":2000,"tools":["web","system","docs"]}', async f => {
    await run(setup(18964, ['docs', 'web', 'system']), { text: 'q', auto: true, maxTokens: 300, tools: [] });
    const body = f.chatBodies[0] as Record<string, unknown>;
    same(body.max_tokens, 300);
    same(toolNames(body), ['search_documents', 'read_document', 'web_search', 'web_fetch']);
  });
});

test('a chat only gains tool groups in auto mode, so its cached prompt is not rewritten', async () => {
  await withLlama(18967, ['{"tools":["utility"]}', '{"tools":["web"]}', '{"tools":[]}'], async f => {
    const turns = setup(18967, ['docs', 'utility', 'web']);
    const first = await run(turns, { text: 'a', auto: true, tools: [] });
    const id = Number(((first.find(e => e.type === 'chat') as Ev).chat as Ev).id);
    await run(turns, { chatId: id, text: 'b', auto: true, tools: [] });
    await run(turns, { chatId: id, text: 'c', auto: true, tools: [] });
    same(toolNames(f.chatBodies[0] as Record<string, unknown>), ['current_time', 'calculate']);
    same(toolNames(f.chatBodies[1] as Record<string, unknown>), ['current_time', 'calculate', 'web_search', 'web_fetch']);
    same(toolNames(f.chatBodies[2] as Record<string, unknown>), ['current_time', 'calculate', 'web_search', 'web_fetch']);
  });
});

const prompted = (f: Fake, i: number): string[] =>
  (((f.chatBodies[i] as Record<string, unknown>).messages as Record<string, unknown>[]) ?? []).map(m =>
    typeof m.content === 'string' ? m.content : '',
  );

test('with auto on, the model chooses how many earlier turns the reply sees', async () => {
  await withLlama(18970, ['{}', '{}', '{}', '{"memory":1}'], async f => {
    const turns = setup(18970, ['utility']);
    const first = await run(turns, { text: 'q1', auto: true, tools: [] });
    const id = Number(((first.find(e => e.type === 'chat') as Ev).chat as Ev).id);
    for (const q of ['q2', 'q3', 'q4']) await run(turns, { chatId: id, text: q, auto: true, tools: [] });
    same(prompted(f, 3).slice(1), ['q3', 'ok', 'q4']);
    same(prompted(f, 2).slice(1), ['q1', 'ok', 'q2', 'ok', 'q3']);
  });
});

const REPEAT = "I'm LFM, the Liquid Foundation Model built by Liquid AI. I'm happy to help!";

test('replies repeated in a chat are left out of the prompt with their questions', async () => {
  await withLlama(18971, '', async f => {
    const store = openStore(tmp());
    const turns = new Turns({
      store,
      pages: new PageRenderer(store, null),
      llamaPort: 18971,
      slots: () => 2,
      tools: { allowed: [], workDir: tmp(), searchUrl: '' },
    });
    const chat = store.createChat('t');
    for (const [q, r] of [
      ['one', REPEAT],
      ['two', 'Two follows one in counting.'],
      ['three', REPEAT],
    ]) {
      store.addMessage(chat.id, 'user', q as string);
      store.addMessage(chat.id, 'assistant', r as string);
    }
    await run(turns, { chatId: chat.id, text: 'four', tools: [] });
    same(prompted(f, 0).slice(1), ['two', 'Two follows one in counting.', 'four']);
  });
});

test('a reply that starts like an earlier one is dropped before the page sees it, and asked again without that turn', async () => {
  await withLlama(
    18972,
    '',
    async f => {
      const store = openStore(tmp());
      const turns = new Turns({
        store,
        pages: new PageRenderer(store, null),
        llamaPort: 18972,
        slots: () => 2,
        tools: { allowed: [], workDir: tmp(), searchUrl: '' },
      });
      const chat = store.createChat('t');
      store.addMessage(chat.id, 'user', 'hello');
      store.addMessage(chat.id, 'assistant', REPEAT);
      const evs = await run(turns, { chatId: chat.id, text: 'whats the price of LTC', tools: [], temperature: 0.5 });
      same(f.chatBodies.length, 2);
      same(prompted(f, 0).slice(1), ['hello', REPEAT, 'whats the price of LTC']);
      same(prompted(f, 1).slice(1), ['whats the price of LTC']);
      same((f.chatBodies[1] as Record<string, unknown>).temperature, 0.8);
      const shown = evs
        .filter(e => e.type === 'delta')
        .map(e => String(e.content))
        .join('');
      same(shown, 'The price of LTC is about eighty dollars.');
    },
    false,
    0,
    [REPEAT, 'The price of LTC is about eighty dollars.'],
  );
});

test('a failed plan falls back to the request, and without auto there is no planning call', async () => {
  await withLlama(
    18965,
    '',
    async f => {
      await run(setup(18965, ['utility']), { text: 'q', auto: true, tools: ['utility'], temperature: 0.9 });
      const body = f.chatBodies[0] as Record<string, unknown>;
      same([body.temperature, body.max_tokens], [0.9, 400]);
      same(toolNames(body), ['current_time', 'calculate']);
    },
    true,
  );
  await withLlama(18966, '{"temperature":0.1}', async f => {
    await run(setup(18966, ['utility']), { text: 'q', tools: [] });
    same(f.planBodies.length, 0);
    same((f.chatBodies[0] as Record<string, unknown>).temperature, 0.7);
  });
});
