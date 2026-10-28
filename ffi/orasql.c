// Strings arrive as (ptr, len) pairs and are not NUL-terminated; text leaves through caller buffers.
#include "vendor/sqlite3.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MAX_STMT 64

static sqlite3 *g_db;
static sqlite3_stmt *g_st[MAX_STMT];
static char g_err[512];

static void set_err(const char *m) {
  strncpy(g_err, m ? m : "", sizeof g_err - 1);
  g_err[sizeof g_err - 1] = 0;
}

static char *dup_z(const uint8_t *p, size_t n) {
  char *s = malloc(n + 1);
  if (!s) return NULL;
  if (n) memcpy(s, p, n);
  s[n] = 0;
  return s;
}

static sqlite3_stmt *stmt_at(int s) { return (s >= 0 && s < MAX_STMT) ? g_st[s] : NULL; }

int32_t ora_sql_open(const uint8_t *p, size_t n) {
  char *path = dup_z(p, n);
  if (!path) return SQLITE_NOMEM;
  int rc = sqlite3_open_v2(path, &g_db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, NULL);
  free(path);
  if (rc != SQLITE_OK) { set_err(g_db ? sqlite3_errmsg(g_db) : "open failed"); return rc; }
  sqlite3_busy_timeout(g_db, 5000);
  return 0;
}

int32_t ora_sql_close(void) {
  for (int i = 0; i < MAX_STMT; i++) if (g_st[i]) { sqlite3_finalize(g_st[i]); g_st[i] = NULL; }
  int rc = g_db ? sqlite3_close(g_db) : 0;
  g_db = NULL;
  return rc;
}

int32_t ora_sql_exec(const uint8_t *p, size_t n) {
  char *sql = dup_z(p, n);
  if (!sql) return SQLITE_NOMEM;
  char *msg = NULL;
  int rc = sqlite3_exec(g_db, sql, NULL, NULL, &msg);
  free(sql);
  if (rc != SQLITE_OK) { set_err(msg); sqlite3_free(msg); }
  return rc;
}

int32_t ora_sql_prepare(const uint8_t *p, size_t n) {
  int slot = -1;
  for (int i = 0; i < MAX_STMT; i++) if (!g_st[i]) { slot = i; break; }
  if (slot < 0) { set_err("too many prepared statements"); return -1; }
  sqlite3_stmt *st = NULL;
  if (sqlite3_prepare_v2(g_db, (const char *)p, (int)n, &st, NULL) != SQLITE_OK) { set_err(sqlite3_errmsg(g_db)); return -1; }
  g_st[slot] = st;
  return slot;
}

int32_t ora_sql_finalize(int32_t s) {
  sqlite3_stmt *st = stmt_at(s);
  if (!st) return -1;
  sqlite3_finalize(st);
  g_st[s] = NULL;
  return 0;
}

int32_t ora_sql_bind_text(int32_t s, int32_t i, const uint8_t *p, size_t n) {
  sqlite3_stmt *st = stmt_at(s);
  if (!st) return -1;
  return sqlite3_bind_text(st, i, p ? (const char *)p : "", (int)n, SQLITE_TRANSIENT);
}

int32_t ora_sql_bind_num(int32_t s, int32_t i, double v) {
  sqlite3_stmt *st = stmt_at(s);
  if (!st) return -1;
  if (v == (double)(int64_t)v) return sqlite3_bind_int64(st, i, (int64_t)v);
  return sqlite3_bind_double(st, i, v);
}

int32_t ora_sql_bind_null(int32_t s, int32_t i) {
  sqlite3_stmt *st = stmt_at(s);
  return st ? sqlite3_bind_null(st, i) : -1;
}

// 1 = row, 0 = done, -1 = error (see ora_sql_err)
int32_t ora_sql_step(int32_t s) {
  sqlite3_stmt *st = stmt_at(s);
  if (!st) return -1;
  int rc = sqlite3_step(st);
  if (rc == SQLITE_ROW) return 1;
  if (rc == SQLITE_DONE) return 0;
  set_err(sqlite3_errmsg(g_db));
  return -1;
}

int32_t ora_sql_col_count(int32_t s) {
  sqlite3_stmt *st = stmt_at(s);
  return st ? sqlite3_column_count(st) : 0;
}

int32_t ora_sql_col_type(int32_t s, int32_t c) {
  sqlite3_stmt *st = stmt_at(s);
  return st ? sqlite3_column_type(st, c) : 0;
}

double ora_sql_col_num(int32_t s, int32_t c) {
  sqlite3_stmt *st = stmt_at(s);
  return st ? sqlite3_column_double(st, c) : 0;
}

// Copies up to cap bytes; returns the full byte length so the caller can retry with a larger buffer.
int32_t ora_sql_col_text(int32_t s, int32_t c, uint8_t *buf, size_t cap) {
  sqlite3_stmt *st = stmt_at(s);
  if (!st) return -1;
  const unsigned char *t = sqlite3_column_text(st, c);
  int n = sqlite3_column_bytes(st, c);
  if (t && buf && cap) memcpy(buf, t, (size_t)n < cap ? (size_t)n : cap);
  return n;
}

double ora_sql_last_rowid(void) { return g_db ? (double)sqlite3_last_insert_rowid(g_db) : 0; }
int32_t ora_sql_changes(void) { return g_db ? sqlite3_changes(g_db) : 0; }

int32_t ora_sql_err(uint8_t *buf, size_t cap) {
  size_t n = strlen(g_err);
  if (buf && cap) memcpy(buf, g_err, n < cap ? n : cap);
  return (int32_t)n;
}
