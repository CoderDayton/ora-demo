// Bindings to ffi/orasql.c (vendored sqlite3.c). Bodyless declarations become native calls under scriptc --ffi.
declare function oraSqlOpen(path: string): number;
declare function oraSqlClose(): number;
declare function oraSqlExec(sql: string): number;
declare function oraSqlPrepare(sql: string): number;
declare function oraSqlFinalize(stmt: number): number;
declare function oraSqlBindText(stmt: number, idx: number, text: string): number;
declare function oraSqlBindNum(stmt: number, idx: number, v: number): number;
declare function oraSqlBindNull(stmt: number, idx: number): number;
declare function oraSqlStep(stmt: number): number;
declare function oraSqlColCount(stmt: number): number;
declare function oraSqlColType(stmt: number, col: number): number;
declare function oraSqlColNum(stmt: number, col: number): number;
declare function oraSqlColText(stmt: number, col: number, buf: Uint8Array): number;
declare function oraSqlLastRowid(): number;
declare function oraSqlErr(buf: Uint8Array): number;

export type Val = string | number | null;

const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_TEXT = 3;

function lastError(): string {
  const buf = new Uint8Array(512);
  const n = oraSqlErr(buf);
  return Buffer.from(buf.subarray(0, Math.min(n, 512))).toString('utf8');
}

function readText(stmt: number, col: number): string {
  let buf = new Uint8Array(1024);
  const n = oraSqlColText(stmt, col, buf);
  if (n > buf.length) {
    buf = new Uint8Array(n);
    oraSqlColText(stmt, col, buf);
  }
  return Buffer.from(buf.subarray(0, n)).toString('utf8');
}

export class Sql {
  open(path: string): void {
    if (oraSqlOpen(path) !== 0) throw new Error(`sqlite open: ${lastError()}`);
  }

  close(): void {
    oraSqlClose();
  }

  exec(sql: string): void {
    if (oraSqlExec(sql) !== 0) throw new Error(`sqlite exec: ${lastError()}`);
  }

  // Runs a statement and returns every row as an array of column values.
  query(sql: string, params: Val[]): Val[][] {
    const st = oraSqlPrepare(sql);
    if (st < 0) throw new Error(`sqlite prepare: ${lastError()}`);
    const rows: Val[][] = [];
    try {
      for (let i = 0; i < params.length; i++) {
        const p = params[i];
        let rc = 0;
        if (p === null || p === undefined) rc = oraSqlBindNull(st, i + 1);
        else if (typeof p === 'number') rc = oraSqlBindNum(st, i + 1, p);
        else rc = oraSqlBindText(st, i + 1, p);
        if (rc !== 0) throw new Error(`sqlite bind ${i + 1}: ${lastError()}`);
      }
      for (;;) {
        const r = oraSqlStep(st);
        if (r < 0) throw new Error(`sqlite step: ${lastError()}`);
        if (r === 0) break;
        const row: Val[] = [];
        const ncol = oraSqlColCount(st);
        for (let c = 0; c < ncol; c++) {
          const t = oraSqlColType(st, c);
          if (t === SQLITE_INTEGER || t === SQLITE_FLOAT) row.push(oraSqlColNum(st, c));
          else if (t === SQLITE_TEXT) row.push(readText(st, c));
          else row.push(null);
        }
        rows.push(row);
      }
    } finally {
      oraSqlFinalize(st);
    }
    return rows;
  }

  // Returns the last inserted rowid.
  run(sql: string, params: Val[]): number {
    this.query(sql, params);
    return oraSqlLastRowid();
  }

  transaction(fn: () => void): void {
    this.exec('begin');
    try {
      fn();
      this.exec('commit');
    } catch (e) {
      this.exec('rollback');
      throw e;
    }
  }
}
