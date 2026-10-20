import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openWorkflowDatabase } from '../src/storage/database.js';

test('file database commits durably, rolls back failed transactions and rejects unsupported versions', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'workflow-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'workflow.sqlite');
  let db = openWorkflowDatabase(filename);
  assert.equal(db.connection.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.connection.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.connection.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(db.connection.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  db.connection.exec('CREATE TABLE probe(value TEXT)');
  assert.throws(() => db.transaction(() => { db.connection.exec("INSERT INTO probe VALUES ('rollback')"); throw Error('abort'); }));
  assert.equal(db.connection.prepare('SELECT count(*) AS n FROM probe').get().n, 0);
  db.transaction(() => db.connection.exec("INSERT INTO probe VALUES ('kept')"));
  db.close(); db = openWorkflowDatabase(filename);
  assert.equal(db.connection.prepare('SELECT value FROM probe').get().value, 'kept');
  db.connection.exec('PRAGMA user_version=999'); db.close();
  assert.throws(() => openWorkflowDatabase(filename), /版本/);
  const corrupt = path.join(dir, 'corrupt.sqlite'); writeFileSync(corrupt, 'broken');
  assert.throws(() => openWorkflowDatabase(corrupt));
  assert.equal(readFileSync(corrupt, 'utf8'), 'broken');
});

test('locked database cannot accept a write or destroy committed data', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'workflow-lock-'));
  const file = path.join(dir, 'db.sqlite');
  const a = openWorkflowDatabase(file), b = openWorkflowDatabase(file);
  t.after(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); });
  a.connection.exec('CREATE TABLE probe(value TEXT); BEGIN IMMEDIATE');
  b.connection.exec('PRAGMA busy_timeout=1');
  assert.throws(() => b.transaction(() => b.connection.exec("INSERT INTO probe VALUES ('bad')")), /locked/);
  a.connection.exec('ROLLBACK');
  assert.equal(b.connection.prepare('SELECT count(*) AS n FROM probe').get().n, 0);
});
