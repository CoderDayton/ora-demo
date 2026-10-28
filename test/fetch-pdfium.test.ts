import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assetUrl, checkSha, platformKey } from '../scripts/fetch-pdfium.ts';
import type { Lock } from '../scripts/fetch-pdfium.ts';

const lock = JSON.parse(readFileSync(new URL('../ffi/pdfium.lock.json', import.meta.url), 'utf8')) as Lock;

test('platformKey maps Node platform and arch to a lock entry', () => {
  assert.strictEqual(platformKey('linux', 'x64'), 'linux-x64');
  assert.strictEqual(platformKey('linux', 'arm64'), 'linux-arm64');
  assert.strictEqual(platformKey('darwin', 'arm64'), 'darwin-arm64');
  assert.strictEqual(platformKey('win32', 'x64'), 'win32-x64');
});

test('an unsupported platform is an error that names it', () => {
  assert.throws(() => platformKey('freebsd', 'x64'), /unsupported platform freebsd-x64/);
});

test('every locked asset has a pinned sha256 and a library name', () => {
  for (const [key, a] of Object.entries(lock.assets)) {
    assert.match(a.sha256, /^[0-9a-f]{64}$/, key);
    assert.match(a.asset, /^pdfium-.*\.tgz$/, key);
    assert.ok(a.member.endsWith(`/${a.lib}`), `${key}: member must end with the library name`);
  }
});

test('assetUrl encodes the release tag the way GitHub serves it', () => {
  assert.strictEqual(
    assetUrl(lock, 'linux-x64'),
    'https://github.com/bblanchon/pdfium-binaries/releases/download/chromium%2F8125/pdfium-linux-x64.tgz',
  );
});

test('checkSha accepts the right hash and rejects a changed file', () => {
  const bytes = new TextEncoder().encode('hello');
  const good = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  checkSha(bytes, good, 'x');
  assert.throws(() => checkSha(new TextEncoder().encode('hellO'), good, 'x'), /checksum mismatch for x/);
});

test('ORA_PDFIUM_LIB skips the download, and must point at a real file', async () => {
  const { ensurePdfium } = await import('../scripts/fetch-pdfium.ts');
  const real = new URL('../package.json', import.meta.url).pathname;
  process.env.ORA_PDFIUM_LIB = real;
  assert.strictEqual(await ensurePdfium(), real);
  process.env.ORA_PDFIUM_LIB = '/no/such/lib.so';
  await assert.rejects(ensurePdfium(), /does not exist/);
  delete process.env.ORA_PDFIUM_LIB;
});
