// Builds ffi/build/liborasql.a: vendored sqlite3.c (FTS5, single-threaded), the orasql shim, and the orapdf shim
// with this machine's PDFium library embedded (downloaded and checksum-verified on first use). Then writes the
// manifests (see ffi-split.ts). Needs clang and ar (llvm-ar is tried too) on PATH; CC and AR override them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensurePdfium } from './fetch-pdfium.ts';

const ffi = fileURLToPath(new URL('../ffi/', import.meta.url));
const build = `${ffi}build/`;
const cc = process.env.CC ?? 'clang';

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

function archiver(): string {
  if (process.env.AR) return process.env.AR;
  for (const name of ['ar', 'llvm-ar']) {
    try {
      execFileSync(name, ['--version'], { stdio: 'ignore' });
      return name;
    } catch {}
  }
  throw new Error('neither ar nor llvm-ar found on PATH (set AR)');
}

mkdirSync(build, { recursive: true });
// Forward slashes: the path is spliced into a C string for .incbin, where backslashes would be escapes.
const pdfium = (await ensurePdfium()).replaceAll('\\', '/');
const sqlite = [
  '-O2',
  '-DSQLITE_THREADSAFE=0',
  '-DSQLITE_ENABLE_FTS5',
  '-DSQLITE_OMIT_LOAD_EXTENSION',
  '-DSQLITE_DQS=0',
  '-DSQLITE_DEFAULT_MEMSTATUS=0',
];

run(cc, [...sqlite, '-c', `${ffi}vendor/sqlite3.c`, '-o', `${build}sqlite3.o`]);
run(cc, ['-O2', '-c', `${ffi}orasql.c`, '-o', `${build}orasql.o`]);
run(cc, ['-O2', `-DORA_PDFIUM_LIB="${pdfium}"`, '-c', `${ffi}orapdf.c`, '-o', `${build}orapdf.o`]);
rmSync(`${build}liborasql.a`, { force: true });
run(archiver(), ['rcs', `${build}liborasql.a`, `${build}sqlite3.o`, `${build}orasql.o`, `${build}orapdf.o`]);
await import('./ffi-split.ts');
console.log(`${build}liborasql.a`);
