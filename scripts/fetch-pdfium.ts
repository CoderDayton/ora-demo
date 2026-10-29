// Downloads the PDFium build for this machine, checks it against the pinned SHA-256 in ffi/pdfium.lock.json and
// prints the library path on stdout. ORA_PDFIUM_LIB=/path/to/library skips the download (offline or packaged builds).
// Usage: node scripts/fetch-pdfium.ts
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Asset {
  asset: string;
  sha256: string;
  lib: string;
  member: string;
}
export interface Lock {
  release: string;
  baseUrl: string;
  assets: Record<string, Asset>;
}

const SUPPORTED = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64'];
const root = fileURLToPath(new URL('..', import.meta.url));

export function platformKey(platform: string, arch: string): string {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED.includes(key)) throw new Error(`unsupported platform ${key} (supported: ${SUPPORTED.join(', ')})`);
  return key;
}

export function assetUrl(lock: Lock, key: string): string {
  const a = lock.assets[key];
  if (!a) throw new Error(`no PDFium asset locked for ${key}`);
  return `${lock.baseUrl}/${encodeURIComponent(lock.release)}/${a.asset}`;
}

export function checkSha(bytes: Uint8Array, expected: string, label: string): void {
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== expected) throw new Error(`checksum mismatch for ${label}: expected ${expected}, got ${got}`);
}

export async function ensurePdfium(): Promise<string> {
  const override = process.env.ORA_PDFIUM_LIB;
  if (override) {
    if (!existsSync(override)) throw new Error(`ORA_PDFIUM_LIB does not exist: ${override}`);
    return override;
  }
  const lock = JSON.parse(readFileSync(join(root, 'ffi/pdfium.lock.json'), 'utf8')) as Lock;
  const key = platformKey(process.platform, process.arch);
  const a = lock.assets[key] as Asset;
  const dir = join(root, 'ffi/vendor/pdfium/lib', key);
  const lib = join(dir, a.lib);
  const stamp = join(dir, '.sha256');
  if (existsSync(lib) && existsSync(stamp) && readFileSync(stamp, 'utf8') === a.sha256) return lib;

  const url = assetUrl(lock, key);
  console.error(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  checkSha(bytes, a.sha256, a.asset);

  const tmp = mkdtempSync(join(tmpdir(), 'ora-pdfium-'));
  try {
    writeFileSync(join(tmp, a.asset), bytes);
    execFileSync('tar', ['xzf', join(tmp, a.asset), '-C', tmp, a.member], { stdio: 'inherit' });
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(tmp, a.member), lib);
    writeFileSync(stamp, a.sha256);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return lib;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensurePdfium().then(
    p => process.stdout.write(`${p}\n`),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
