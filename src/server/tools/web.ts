// Web tools. Off unless the user enables them. Fetching refuses anything that is not a public http(s) address,
// so a page or a prompt cannot point the model at this machine or the local network.

import { lookup } from 'node:dns/promises';
import { arr, obj } from '../llm/llama.ts';

const TEXT_CAP = 20000;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 4;

function v4(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const n = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return n.every(x => x <= 255) ? n : null;
}

// Loopback, private, link-local, unspecified and IPv4-mapped IPv6 addresses.
export function isPrivateIp(ip: string): boolean {
  const a = v4(ip);
  if (a) {
    const [p, q] = a as [number, number, number, number];
    return p === 0 || p === 10 || p === 127 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168);
  }
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::' || s === '::1') return true;
  const mapped = s.match(/^::ffff:(.+)$/);
  if (mapped) {
    const rest = mapped[1] as string;
    const dotted = v4(rest);
    if (dotted) return isPrivateIp(rest);
    const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1] as string, 16);
      const lo = parseInt(hex[2] as string, 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return true;
  }
  return /^f[cd][0-9a-f]{2}:/.test(s) || /^fe[89ab][0-9a-f]:/.test(s);
}

// The normalised address, or an error saying why it is refused.
export function checkUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('not a valid web address');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http and https addresses are allowed');
  if (u.username || u.password) throw new Error('addresses with a user name or password are not allowed');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('local addresses are not allowed');
  }
  if (isPrivateIp(host)) throw new Error('private addresses are not allowed');
  return u.href;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m: string, e: string) => {
      if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith('#')) return String.fromCodePoint(Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const clip = (s: string): string => (s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP)}\n[truncated]` : s);

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`${what} timed out`)), TIMEOUT_MS);
    p.then(
      v => {
        clearTimeout(t);
        ok(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        fail(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

// Fetches a page as text. Every hop, redirects included, is checked, and the name is resolved first so a public
// name that points at a private address is refused too.
export async function fetchPage(raw: string): Promise<string> {
  let url = checkUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (!v4(host) && !host.includes(':')) {
      for (const a of await withTimeout(lookup(host, { all: true }), 'lookup')) {
        if (isPrivateIp(a.address)) throw new Error('that name points at a private address');
      }
    }
    const r = await withTimeout(fetch(url, { redirect: 'manual', headers: { 'user-agent': 'Ora' } }), 'the request');
    if (r.status >= 300 && r.status < 400) {
      const next = r.headers.get('location');
      if (!next) throw new Error(`redirect without a location (HTTP ${r.status})`);
      url = checkUrl(new URL(next, url).href);
      continue;
    }
    if (!r.ok) throw new Error(`the server answered HTTP ${r.status}`);
    const type = (r.headers.get('content-type') ?? '').toLowerCase();
    const body = await withTimeout(r.text(), 'the download');
    if (type.includes('html')) return clip(htmlToText(body));
    if (type.startsWith('text/') || type.includes('json') || type.includes('xml')) return clip(body);
    throw new Error(`not a text page (${type || 'unknown type'})`);
  }
  throw new Error('too many redirects');
}

// `searchUrl` comes from the config, so it may be on this machine (a local SearXNG); {q} stands for the query.
export async function searchWeb(searchUrl: string, query: string): Promise<string> {
  if (!searchUrl) throw new Error('web search is not configured: set searchUrl in the config');
  const r = await withTimeout(
    fetch(searchUrl.replace('{q}', encodeURIComponent(query)), { headers: { accept: 'application/json' } }),
    'the search',
  );
  if (!r.ok) throw new Error(`the search service answered HTTP ${r.status}`);
  const results = arr(obj(JSON.parse(await r.text())).results).slice(0, 6);
  if (!results.length) return 'No results.';
  return clip(
    results
      .map((v: unknown) => {
        const x = obj(v);
        return `${String(x.title ?? '')}\n${String(x.url ?? '')}\n${String(x.content ?? '')}`.trim();
      })
      .join('\n\n'),
  );
}
