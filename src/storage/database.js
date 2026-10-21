import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function openWorkflowDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
  const connection = new DatabaseSync(filename);
  const transaction = fn => {
    if (connection.isTransaction) return fn();
    connection.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      if (value?.then) throw new Error('数据库事务不支持异步回调');
      connection.exec('COMMIT'); return value;
    } catch (error) { connection.exec('ROLLBACK'); throw error; }
  };
  try {
    const version = connection.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) throw new Error('工作流数据库版本高于当前程序支持版本');
    connection.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
    if (!version) transaction(() => connection.exec(`
      CREATE TABLE workflow_jobs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL, stage TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        source_scope TEXT NOT NULL, dedupe_key TEXT, item_count INTEGER NOT NULL DEFAULT 0,
        protected INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL
      );
      CREATE INDEX workflow_jobs_status ON workflow_jobs(status, updated_at);
      CREATE INDEX workflow_jobs_dedupe ON workflow_jobs(dedupe_key);
      CREATE TABLE workflow_items (
        job_id TEXT NOT NULL REFERENCES workflow_jobs(id) ON DELETE CASCADE,
        entry_key TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL, phase TEXT,
        payload TEXT NOT NULL, PRIMARY KEY(job_id, entry_key)
      );
      CREATE TABLE workflow_actions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        job_id TEXT NOT NULL REFERENCES workflow_jobs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
      );
      CREATE INDEX workflow_actions_queue ON workflow_actions(status, sequence);
      PRAGMA user_version=1;
    `));
    if (version < 2) transaction(() => connection.exec(`
      CREATE TABLE application_config(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE credentials(id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password TEXT NOT NULL, version INTEGER NOT NULL, passkey_digest TEXT NOT NULL);
      CREATE TABLE auth_attempts(namespace TEXT NOT NULL, ip TEXT NOT NULL, count INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(namespace,ip));
      CREATE TABLE recovery_tokens(digest TEXT PRIMARY KEY, version INTEGER NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE configuration_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, source TEXT NOT NULL, revision TEXT NOT NULL, changes TEXT NOT NULL);
      CREATE TABLE media_cursors(scope TEXT PRIMARY KEY, date TEXT);
      CREATE TABLE media_cursor_ids(scope TEXT NOT NULL REFERENCES media_cursors(scope) ON DELETE CASCADE, kind TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY(scope,kind,item_id));
      CREATE TABLE cleanup_runs(id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source_url TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX cleanup_runs_status ON cleanup_runs(status,updated_at);
      CREATE TABLE cleanup_items(run_id INTEGER NOT NULL REFERENCES cleanup_runs(id) ON DELETE CASCADE, hash TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id,hash));
      PRAGMA user_version=2;
    `));
    let closed = false;
    return { connection, transaction, close() { if (!closed) { connection.close(); closed = true; } } };
  } catch (error) { connection.close(); throw error; }
}
