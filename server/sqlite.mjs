import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Same SQL and guarded transactions as D1; no second collaboration engine.
export function openDatabase(filename, migrations) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
  if (migrations) for (const file of fs.readdirSync(migrations).filter(x => x.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
  }
  const value = v => v instanceof ArrayBuffer ? new Uint8Array(v) : typeof v === 'boolean' ? Number(v) : v;
  function execute(sql, params) {
    const stmt = db.prepare(sql);
    const results = stmt.columns().length ? stmt.all(...params.map(value)) : [];
    const meta = stmt.columns().length ? { changes: 0 } : stmt.run(...params.map(value));
    return { success: true, results, meta: { changes: Number(meta.changes), last_row_id: Number(meta.lastInsertRowid || 0) } };
  }
  const prepare = (sql, params = []) => ({
    sql, params,
    bind(...args) { return prepare(sql, args); },
    async first(column) { const row = db.prepare(sql).get(...params.map(value)); return row ? (column ? row[column] : row) : null; },
    async all() { return execute(sql, params); },
    async run() { return execute(sql, params); },
  });
  return {
    prepare,
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = statements.map(s => execute(s.sql, s.params)); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    exec(sql) { db.exec(sql); },
    close() { db.close(); },
  };
}
