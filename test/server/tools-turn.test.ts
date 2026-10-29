import assert from 'node:assert';
import { existsSync, mkdtempSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TurnRequest } from '../../src/server/chat/turn.ts';
import { Cancel, parseTurn, Turns } from '../../src/server/chat/turn.ts';
import { PageRenderer } from '../../src/server/docs/pages.ts';
import { openStore } from '../../src/server/store/store.ts';

function same(actual: unknown, expected: unknown): void {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

// One scripted completion: reply text, then tool calls (name and JSON arguments).
interface Step {
  content: string;
  calls: { name: string; args: string }[];
}
const say = (content: string): Step => ({ content, calls: [] });
const call = (name: string, args: string, content = ''): Step => ({ content, calls: [{ name, args }] });

interface Fake {
  server: Server;
  bodies: string[];
  script: Step[];
}

function stream(res: ServerResponse, step: Step): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (delta: Record<string, unknown>, finish: string | null = null): void => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
  };
  if (step.content) send({ content: step.content });
  step.calls.forEach((c, index) => {
    const half = Math.floor(c.args.length / 2);
    send({ tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: c.name, arguments: c.args.slice(0, half) } }] });
    send({ tool_calls: [{ index, function: { arguments: c.args.slice(half) } }] });
  });
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step.calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5 }, timings: { cache_n: 10, prompt_n: 40 } })}\n\n`,
  );
  res.end('data: [DONE]\n\n');
}

async function withLlama(port: number, script: Step[], fn: (f: Fake) => Promise<void>): Promise<void> {
  const bodies: string[] = [];
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
      bodies.push(raw);
      stream(res, script.shift() ?? say('(script ended)'));
    });
  });
  await new Promise<void>(ok => {
    server.listen(port, '127.0.0.1', () => ok());
  });
  try {
    await fn({ server, bodies, script });
  } finally {
    server.close();
  }
}

type Ev = Record<string, unknown>;
const tmp = (): string => mkdtempSync(join(tmpdir(), 'ora-tt-'));

function setup(port: number, allowed: string[], workDir = tmp()): { turns: Turns; workDir: string; store: ReturnType<typeof openStore> } {
  const store = openStore(tmp());
  const turns = new Turns({
    store,
    pages: new PageRenderer(store, null),
    llamaPort: port,
    slots: () => 2,
    tools: { allowed, workDir, searchUrl: '' },
  });
  return { turns, workDir, store };
}

const ask = (text: string, tools: string[]): TurnRequest => parseTurn({ chatId: null, text, system: '', maxTokens: 256, tools });
const bodyOf = (f: Fake, i: number): Record<string, unknown> => JSON.parse(f.bodies[i] ?? '{}') as Record<string, unknown>;
const msgs = (b: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(b.messages) ? (b.messages as Record<string, unknown>[]) : [];
const toolNames = (b: Record<string, unknown>): string[] =>
  (Array.isArray(b.tools) ? (b.tools as Record<string, unknown>[]) : []).map(t => String((t.function as Record<string, unknown>).name));
const types = (evs: Ev[]): string[] => evs.map(e => String(e.type));

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

async function until(test: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !test(); i++) await new Promise<void>(ok => setTimeout(ok, 10));
  assert.ok(test(), 'timed out waiting');
}

test('a tool call runs and its result goes back to the model', async () => {
  await withLlama(18801, [call('calculate', '{"expression":"2+3"}', 'Checking.'), say('It is 5.')], async f => {
    const { turns } = setup(18801, ['utility']);
    const evs = await run(turns, ask('what is 2+3', ['utility']));
    assert.ok(toolNames(bodyOf(f, 0)).includes('calculate'));
    same(
      types(evs).filter(t => t !== 'delta'),
      ['chat', 'user', 'tool', 'tool_done', 'done'],
    );
    const t = evs.find(e => e.type === 'tool') as Ev;
    same([t.name, t.summary, t.ask], ['calculate', 'Calculate 2+3', false]);
    assert.equal(typeof t.say, 'string');
    const d = evs.find(e => e.type === 'tool_done') as Ev;
    same([d.ok, d.output], [true, '5']);
    const second = msgs(bodyOf(f, 1));
    const asst = second[second.length - 2] as Record<string, unknown>;
    const tool = second[second.length - 1] as Record<string, unknown>;
    same(asst.role, 'assistant');
    const fn = ((asst.tool_calls as Record<string, unknown>[])[0] as Record<string, unknown>).function as Record<string, unknown>;
    same([fn.name, fn.arguments], ['calculate', '{"expression":"2+3"}']);
    same([tool.role, tool.content], ['tool', '5']);
    same(tool.tool_call_id, 'call_0');
    const text = evs
      .filter(e => e.type === 'delta')
      .map(e => String(e.content))
      .join('');
    same(text, 'Checking.\n\nIt is 5.');
    const done = evs[evs.length - 1] as Ev;
    same((done.message as Ev).content, 'Checking.\n\nIt is 5.');
  });
});

test('tool steps are saved with the chat and replayed to the model as a tool call and its result', async () => {
  await withLlama(18810, [call('calculate', '{"expression":"2+3"}'), say('It is 5.'), say('ok')], async f => {
    const { turns, store } = setup(18810, ['utility']);
    const evs = await run(turns, ask('what is 2+3', ['utility']));
    const id = Number(((evs.find(e => e.type === 'chat') as Ev).chat as Ev).id);
    const saved = store.messages(id);
    same(
      saved.map(m => m.role),
      ['user', 'tool', 'assistant'],
    );
    same((saved[1] as { content: unknown }).content, [
      { name: 'calculate', summary: 'Calculate 2+3', ok: true, denied: false, output: '5', args: '{"expression":"2+3"}' },
    ]);
    await run(turns, parseTurn({ chatId: id, text: 'again', system: '', maxTokens: 256, tools: [] }));
    const replay = msgs(bodyOf(f, 2));
    same(
      replay.map(m => m.role),
      ['system', 'user', 'assistant', 'tool', 'assistant', 'user'],
    );
    const earlier = ((replay[2] as Record<string, unknown>).tool_calls as Record<string, unknown>[])[0] as Record<string, unknown>;
    same((earlier.function as Record<string, unknown>).arguments, '{"expression":"2+3"}');
    same((replay[3] as Record<string, unknown>).content, '5');
    same((replay[3] as Record<string, unknown>).tool_call_id, earlier.id);
  });
});

test('no tools are sent unless the request enables a group', async () => {
  await withLlama(18802, [say('hi')], async f => {
    const { turns } = setup(18802, ['utility', 'docs']);
    await run(turns, ask('hello', []));
    same(bodyOf(f, 0).tools, undefined);
  });
});

test('groups the config does not allow are dropped', async () => {
  await withLlama(18803, [say('hi')], async f => {
    const { turns } = setup(18803, ['utility']);
    await run(turns, ask('hello', ['utility', 'system', 'web']));
    const names = toolNames(bodyOf(f, 0));
    assert.ok(names.includes('calculate'));
    assert.ok(!names.includes('run_command'));
    assert.ok(!names.includes('web_fetch'));
  });
});

test('a system tool waits for approval, then runs', async () => {
  await withLlama(18804, [call('run_command', '{"command":"echo ok"}'), say('done')], async f => {
    const { turns } = setup(18804, ['system']);
    const evs: Ev[] = [];
    const running = turns.run(
      ask('run it', ['system']),
      (e: Record<string, unknown>) => {
        evs.push(e);
      },
      new Cancel(),
    );
    await until(() => evs.some(e => e.type === 'approval'));
    assert.ok(!evs.some(e => e.type === 'tool_done'));
    const a = evs.find(e => e.type === 'approval') as Ev;
    same([a.name, a.summary], ['run_command', 'Run the command: echo ok']);
    assert.equal(turns.approvals.resolve(String(a.id), 'allow'), true);
    await running;
    const d = evs.find(e => e.type === 'tool_done') as Ev;
    same(d.ok, true);
    assert.match(String(d.output), /ok/);
    const last = msgs(bodyOf(f, 1)).pop() as Record<string, unknown>;
    assert.match(String(last.content), /exit code 0/);
  });
});

test('a denied tool does not run and the model is told', async () => {
  await withLlama(18805, [call('write_file', '{"path":"marker.txt","content":"x"}'), say('ok, not writing')], async f => {
    const { turns, workDir } = setup(18805, ['system']);
    const evs: Ev[] = [];
    const running = turns.run(
      ask('write it', ['system']),
      (e: Record<string, unknown>) => {
        evs.push(e);
      },
      new Cancel(),
    );
    await until(() => evs.some(e => e.type === 'approval'));
    turns.approvals.resolve(String((evs.find(e => e.type === 'approval') as Ev).id), 'deny');
    await running;
    const d = evs.find(e => e.type === 'tool_done') as Ev;
    same([d.ok, d.denied], [false, true]);
    assert.equal(existsSync(join(workDir, 'marker.txt')), false);
    const last = msgs(bodyOf(f, 1)).pop() as Record<string, unknown>;
    same(last.content, 'The user denied this action.');
  });
});

test('a chat is reported running from its question until its reply is stored', async () => {
  await withLlama(18811, [call('run_command', '{"command":"true"}'), say('done')], async () => {
    const { turns } = setup(18811, ['system']);
    const evs: Ev[] = [];
    const running = turns.run(
      ask('go', ['system']),
      (e: Record<string, unknown>) => {
        evs.push(e);
      },
      new Cancel(),
    );
    await until(() => evs.some(e => e.type === 'approval'));
    const id = Number(((evs.find(e => e.type === 'chat') as Ev).chat as Ev).id);
    same([turns.isRunning(id), turns.isRunning(id + 1)], [true, false]);
    turns.approvals.resolve(String((evs.find(e => e.type === 'approval') as Ev).id), 'deny');
    await running;
    same(turns.isRunning(id), false);
  });
});

test('cancelling while an approval is open ends the turn without running the tool', async () => {
  await withLlama(18806, [call('run_command', '{"command":"touch ran.txt"}')], async () => {
    const { turns, workDir } = setup(18806, ['system']);
    const cancel = new Cancel();
    const evs: Ev[] = [];
    const running = turns.run(
      ask('go', ['system']),
      (e: Record<string, unknown>) => {
        evs.push(e);
      },
      cancel,
    );
    await until(() => evs.some(e => e.type === 'approval'));
    cancel.cancel();
    await running;
    assert.equal(existsSync(join(workDir, 'ran.txt')), false);
    same(turns.approvals.pending(), []);
  });
});

test('an unknown tool and a failing tool are reported to the model, not thrown', async () => {
  await withLlama(18807, [call('teleport', '{}'), call('calculate', '{"expression":"1/0"}'), say('sorry')], async f => {
    const { turns } = setup(18807, ['utility']);
    const evs = await run(turns, ask('x', ['utility']));
    const done = evs.filter(e => e.type === 'tool_done');
    same(
      done.map(e => e.ok),
      [false, false],
    );
    assert.match(String(done[0]?.output), /unknown tool/);
    assert.match(String(done[1]?.output), /division by zero/);
    same(evs[evs.length - 1]?.error, undefined);
    assert.equal(f.bodies.length, 3);
  });
});

test('every chat carries the rule to answer known facts directly and to hold a correct answer when disputed', async () => {
  await withLlama(18814, [say('Paris.')], async f => {
    const { turns } = setup(18814, ['utility']);
    await run(turns, ask('capital of France?', ['utility']));
    const sys = String(msgs(bodyOf(f, 0))[0]?.content);
    assert.match(sys, /own knowledge/);
    assert.match(sys, /disputes a fact/);
  });
});

test('a tool call written as text is run as a call and never shown', async () => {
  const markup = '<tool_call>\n<function=calculate>\n<parameter=expression>\n2+3\n</parameter>\n</function>\n</tool_call>';
  await withLlama(18812, [say(markup), say('It is 5.')], async f => {
    const { turns } = setup(18812, ['utility']);
    const evs = await run(turns, ask('what is 2+3', ['utility']));
    const shown = evs
      .filter(e => e.type === 'delta')
      .map(e => String(e.content))
      .join('');
    same(shown, 'It is 5.');
    same(
      evs.filter(e => e.type === 'tool_done').map(e => e.output),
      ['5'],
    );
    same(
      msgs(bodyOf(f, 1)).map(m => m.role),
      ['system', 'user', 'assistant', 'tool'],
    );
  });
});

test('a call the model repeats unchanged is not run again, and two repeats end the tool rounds', async () => {
  const same3 = call('calculate', '{"expression":"2+3"}');
  await withLlama(18813, [same3, same3, same3, say('5')], async f => {
    const { turns } = setup(18813, ['utility']);
    const evs = await run(turns, ask('x', ['utility']));
    assert.equal(evs.filter(e => e.type === 'tool').length, 1);
    assert.equal(f.bodies.length, 4);
    same(bodyOf(f, 3).tools, undefined);
    const last = msgs(bodyOf(f, 3));
    assert.match(String(last[last.length - 1]?.content), /already/i);
  });
});

test('a tool call written as text in the round without tools is not shown; the model is told to answer in words', async () => {
  const markup = '<tool_call>\n<function=web_search>\n<parameter=query>\nx\n</parameter>\n</function>\n</tool_call>';
  const same3 = call('calculate', '{"expression":"2+3"}');
  await withLlama(18815, [same3, same3, same3, say(markup), say('The answer is 5.')], async f => {
    const { turns } = setup(18815, ['utility']);
    const evs = await run(turns, ask('x', ['utility']));
    const shown = evs
      .filter(e => e.type === 'delta')
      .map(e => String(e.content))
      .join('');
    same(shown, 'The answer is 5.');
    assert.equal(f.bodies.length, 5);
    const last = msgs(bodyOf(f, 4));
    same(last[last.length - 1]?.role, 'user');
  });
});

test('tool rounds are capped, and the last request goes out without tools', async () => {
  const script: Step[] = [];
  for (let i = 0; i < 12; i++) script.push(call('calculate', `{"expression":"${i}+1"}`));
  await withLlama(18808, script, async f => {
    const { turns } = setup(18808, ['utility']);
    const evs = await run(turns, ask('loop', ['utility']));
    assert.equal(f.bodies.length, 9);
    same(bodyOf(f, 8).tools, undefined);
    assert.equal(evs.filter(e => e.type === 'tool').length, 8);
  });
});
