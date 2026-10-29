export const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

export const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k);
      return v ? (JSON.parse(v) as T) : d;
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown): boolean {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch {
      return false;
    }
  },
};

export type Part =
  | { type: 'text'; text: string; voice?: boolean }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };
export interface Msg {
  role: 'user' | 'assistant' | 'system';
  content: string | Part[];
}

export interface ChatInfo {
  id: number;
  title: string;
  created: number;
  updated: number;
}
export interface DocInfo {
  id: number;
  chatId: number;
  name: string;
  kind: string;
  pages: number | null;
  chars: number;
  chunks: number;
}

export interface Settings {
  sys: string;
  speak: boolean;
  voice: string;
  temp: number;
  maxtok: number;
  pagepx: number;
  pause: number;
}
export interface Props {
  modalities?: { vision?: boolean; audio?: boolean; video?: boolean };
  default_generation_settings?: { n_ctx?: number };
}
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export const L = '/llama';

export const S = {
  engine: 'stopped',
  props: null as Props | null,
  nctx: 0,
  usage: null as Usage | null,
  busy: false,
  abort: null as AbortController | null,
  handsfree: false,
  hist: [] as Msg[],
  pending: [] as string[],
  totals: { in: 0, out: 0 },
  m: {} as Record<string, string>,
  chatId: null as number | null,
  chats: [] as ChatInfo[],
  docs: [] as DocInfo[],
  pageSel: store.get<Record<string, string>>('ora.pages', {}),
  set: {
    sys: 'You are a warm, concise voice assistant. Keep replies short and conversational unless asked for detail.',
    speak: true,
    voice: 'female',
    temp: 0.7,
    maxtok: 1024,
    pagepx: 1024,
    pause: 900,
    ...store.get<Partial<Settings>>('ora.set', {}),
  } as Settings,
};

// Late-bound so chats.ts and app.ts can call each other without an import cycle.
export const hooks = {
  renderLog: (): void => {},
  showCtx: (): void => {},
  note: (_text: string, _isErr?: boolean): void => {},
  statusline: (_t: string): void => {},
  stopSpeech: (): void => {},
  abortChat: (): Promise<void> => Promise.resolve(),
};

export const fmt = (n: number | null | undefined, d = 0): string => (n == null || Number.isNaN(n) ? '-' : Number(n).toFixed(d));

export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const init: RequestInit | undefined =
    body === undefined && !method
      ? undefined
      : {
          method: method ?? 'POST',
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        };
  const r = await fetch(path, init);
  const j = (await r.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}
