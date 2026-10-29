// scriptc rejects a manifest function the program never declares, so tests that touch only one native
// feature need a manifest with only that feature. Writes ffi/sqlite.gen.json and ffi/pdf.gen.json from ffi/ffi.json,
// plus ffi/all.gen.json: the whole manifest with the system libraries this OS needs (Windows has no libm or libdl).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Manifest {
  functions: { symbol: string }[];
  [k: string]: unknown;
}

const dir = fileURLToPath(new URL('../ffi/', import.meta.url));
const all = JSON.parse(readFileSync(`${dir}ffi.json`, 'utf8')) as Manifest;
const isPdf = (f: { symbol: string }): boolean => f.symbol.startsWith('ora_pdf_');

writeFileSync(`${dir}sqlite.gen.json`, JSON.stringify({ ...all, functions: all.functions.filter(f => !isPdf(f)) }, null, 2));
writeFileSync(`${dir}pdf.gen.json`, JSON.stringify({ ...all, functions: all.functions.filter(isPdf) }, null, 2));

const system = process.platform === 'win32' ? [] : ['m', 'dl'];
writeFileSync(`${dir}all.gen.json`, JSON.stringify({ ...all, system_libraries: system }, null, 2));
