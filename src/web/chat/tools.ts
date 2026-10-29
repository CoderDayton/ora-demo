// Tool calls in the transcript: each call is a step with its state and output. A call that acts on the machine
// asks first; the answer comes from the Allow and Deny buttons, a typed word or a spoken one.
import { $, S, store } from '../state.ts';
import { say } from '../voice/speech.ts';
import { parseApproval } from './approval.ts';
import { addMsg, logHooks, scrollEnd } from './render.ts';

export interface ToolEvent {
  type: string;
  id?: string;
  name?: string;
  summary?: string;
  say?: string;
  ask?: boolean;
  ok?: boolean;
  denied?: boolean;
  output?: string;
}

const steps = new Map<string, HTMLElement>();
let open: { id: string; el: HTMLElement } | null = null;
// Steps are placed above the reply bubble of the running turn, so they read as what happened before the answer.
let anchor: HTMLElement | null = null;
export function toolsBegin(bubble: HTMLElement): void {
  anchor = bubble;
}

const part = (el: HTMLElement, cls: string): HTMLElement => el.querySelector(`.${cls}`) as HTMLElement;
function setState(el: HTMLElement, state: string, label: string): void {
  el.className = `msg tool ${state}`;
  part(el, 'tstate').textContent = label;
}

function makeStep(summary: string): HTMLElement {
  const el = addMsg('tool', '', 'running');
  const head = document.createElement('div');
  head.className = 'thead';
  const name = document.createElement('span');
  name.className = 'tname';
  name.textContent = summary;
  const state = document.createElement('span');
  state.className = 'tstate';
  state.textContent = 'running';
  head.append(name, state);
  const actions = document.createElement('div');
  actions.className = 'tactions';
  const out = document.createElement('pre');
  out.className = 'tout';
  el.append(head, actions, out);
  return el;
}

function stepEl(id: string, summary: string): HTMLElement {
  const el = makeStep(summary);
  anchor?.before(el);
  steps.set(id, el);
  return el;
}

interface Saved {
  summary?: string;
  name?: string;
  ok?: boolean;
  denied?: boolean;
  output?: string;
}
// The steps of an earlier turn, as stored with the chat.
logHooks.steps = (list: unknown): void => {
  if (!Array.isArray(list)) return;
  for (const s of list as Saved[]) {
    const el = makeStep(s.summary ?? s.name ?? 'tool');
    const state = s.denied ? 'denied' : s.ok ? 'done' : 'failed';
    setState(el, state, state);
    const out = part(el, 'tout');
    out.textContent = s.output ?? '';
    out.hidden = !s.output;
  }
};

// A tool call has started. Tools that do not ask are announced by voice; asking tools speak their question instead.
export function toolStart(e: ToolEvent): void {
  stepEl(e.id ?? '', e.summary ?? e.name ?? 'tool');
  if (!e.ask && e.say) say(e.say);
  scrollEnd();
}

export function awaitingApproval(): boolean {
  return open !== null;
}

async function post(id: string, decision: 'allow' | 'deny'): Promise<void> {
  try {
    await fetch('/api/turn/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, decision }),
    });
  } catch {
    /* the turn ends on its own if the server is gone */
  }
}

// Answers the open question: the call runs or is refused, and the page shows which.
export function answerApproval(decision: 'allow' | 'deny'): void {
  if (!open) return;
  const { id, el } = open;
  open = null;
  part(el, 'tactions').replaceChildren();
  setState(el, decision === 'allow' ? 'running' : 'denied', decision === 'allow' ? 'allowed, running' : 'denied');
  void post(id, decision);
}

// The user typed or said something while a question is open. Returns false when it was not a clear answer.
export function answerFromWords(text: string): boolean {
  const d = parseApproval(text);
  if (!d) return false;
  answerApproval(d);
  return true;
}

// The model wants to run something that needs the user's say-so: buttons, and the question spoken aloud.
export function toolApproval(e: ToolEvent): void {
  const id = e.id ?? '';
  const el = steps.get(id) ?? stepEl(id, e.summary ?? e.name ?? 'tool');
  setState(el, 'waiting', 'waiting for you');
  const actions = part(el, 'tactions');
  for (const [label, decision, cls] of [
    ['Allow', 'allow', 'primary'],
    ['Deny', 'deny', 'danger'],
  ] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.onclick = () => answerApproval(decision);
    actions.append(b);
  }
  open = { id, el };
  say(`${e.summary ?? 'An action'}. Allow it? Say allow or deny.`);
  scrollEnd();
}

export function toolDone(e: ToolEvent): void {
  const id = e.id ?? '';
  const el = steps.get(id);
  steps.delete(id);
  if (!el) return;
  if (open?.id === id) open = null;
  part(el, 'tactions').replaceChildren();
  setState(el, e.denied ? 'denied' : e.ok ? 'done' : 'failed', e.denied ? 'denied' : e.ok ? 'done' : 'failed');
  const out = part(el, 'tout');
  out.textContent = e.output ?? '';
  out.hidden = !e.output;
}

// The turn ended with a question still open (stopped, or the connection closed): the steps are over.
export function toolsEnded(): void {
  open = null;
  for (const el of steps.values()) {
    part(el, 'tactions').replaceChildren();
    setState(el, 'denied', 'stopped');
  }
  steps.clear();
}

const GROUP_LABEL: Record<string, string> = {
  docs: 'Search and read uploaded documents',
  utility: 'Clock and calculator',
  web: 'Web search and fetch',
  system: 'Shell and files (asks before each action)',
};

const SHORT: Record<string, string> = { docs: 'documents', utility: 'clock, calculator', web: 'web', system: 'shell and files' };
let allowed: string[] | null = null;

// The groups to send with a turn: the ones switched on here that the server's config allows.
export const enabledGroups = (): string[] => S.set.tools.filter(g => allowed === null || allowed.includes(g));

// The chip beside the composer says which tools the model can use right now.
function showChip(): void {
  const chip = $('#toolchip');
  const on = enabledGroups().map(g => SHORT[g] ?? g);
  chip.textContent = on.length ? `Tools: ${on.join(', ')}` : 'Tools off';
  chip.classList.toggle('off', on.length === 0);
}

// Lists the tool groups in the settings. A group the config does not allow is shown off and cannot be switched on.
export async function initToolSettings(box: HTMLElement): Promise<void> {
  let info: { groups: { group: string; allowed: boolean }[]; workDir: string };
  try {
    info = (await (await fetch('/api/tools')).json()) as typeof info;
  } catch {
    box.textContent = 'Tools are unavailable.';
    return;
  }
  allowed = info.groups.filter(g => g.allowed).map(g => g.group);
  showChip();
  box.replaceChildren();
  for (const g of info.groups) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.disabled = !g.allowed;
    input.checked = g.allowed && S.set.tools.includes(g.group);
    input.onchange = () => {
      S.set.tools = S.set.tools.filter(x => x !== g.group);
      if (input.checked) S.set.tools.push(g.group);
      store.set('ora.tools', S.set.tools);
      showChip();
    };
    label.append(`${GROUP_LABEL[g.group] ?? g.group} `, input);
    if (!g.allowed) label.title = 'Not enabled in the config: add it to "tools" in config.json';
    box.append(label);
  }
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = `Shell and file tools work in ${info.workDir}.`;
  box.append(hint);
}

export const toolsBox = (): HTMLElement => $('#toolgroups');
