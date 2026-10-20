import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function openWorkflowDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
  const connection = new DatabaseSync(filename);
  const transaction = fn => {
    connection.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      if (value?.then) throw new Error('数据库事务不支持异步回调');
      connection.exec('COMMIT'); return value;
    } catch (error) { connection.exec('ROLLBACK'); throw error; }
  };
  try {
    const version = connection.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('工作流数据库版本高于当前程序支持版本');
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
    let closed = false;
    return { connection, transaction, close() { if (!closed) { connection.close(); closed = true; } } };
  } catch (error) { connection.close(); throw error; }
}
