import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openWorkflowDatabase } from '../src/storage/database.js';
import { ApplicationRepository } from '../src/storage/application-repository.js';
import { digest, verifyPassword } from '../src/util/credentials.js';
const input = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'initial-password', QBT_API_KEY: 'sensitive' };

test('database restricts existing POSIX files before persisting secrets',{skip:process.platform==='win32'},()=>{
  const root=mkdtempSync(path.join(tmpdir(),'database-permissions-')),filename=path.join(root,'workflow.sqlite');
  let database=openWorkflowDatabase(filename);database.close();chmodSync(root,0o755);chmodSync(filename,0o644);
  database=openWorkflowDatabase(filename);
  try{
    new ApplicationRepository(database).initialize(input,digest('key'));
    assert.equal(statSync(root).mode&0o777,0o700);assert.equal(statSync(filename).mode&0o777,0o600);
    assert.equal(statSync(`${filename}-wal`).mode&0o077,0);assert.equal(statSync(`${filename}-shm`).mode&0o077,0);
  }finally{database.close();rmSync(root,{recursive:true,force:true});}
});
test('initialization hashes credentials and configuration revisions roll back with audit', () => {
  const db = openWorkflowDatabase(':memory:'), repo = new ApplicationRepository(db);
  assert.equal(repo.initialized, false);
  repo.initialize(input, digest('passkey'));
  assert.equal(repo.initialized, true); assert.equal(repo.readConfig().document.ADMIN_PASSWORD, undefined);
  assert.equal(verifyPassword('initial-password', repo.credential().password), true);
  assert.throws(() => repo.initialize(input, 'x'), e => e.status === 409);
  const before = repo.readConfig();
  assert.throws(() => repo.updateConfig({ PORT: 3001 }, { revision: 'stale' }), e => e.status === 409);
  db.connection.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON configuration_audit BEGIN SELECT RAISE(ABORT,'full'); END");
  assert.throws(() => repo.updateConfig({ PORT: 3001 }, { revision: before.revision }));
  assert.equal(repo.readConfig().document.PORT, undefined); db.close();
});
test('persistent attempt counters and recovery tokens expire and are consumed exactly once', () => {
  const db = openWorkflowDatabase(':memory:'), a = new ApplicationRepository(db); a.initialize(input, digest('passkey'));
  for (let i = 0; i < 10; i++) a.attempt('login', 'ip');
  const b = new ApplicationRepository(db);
  assert.throws(() => b.attempt('login', 'ip'), e => e.status === 429);
  b.attempt('recovery', 'ip'); b.clearAttempts('login', 'ip'); b.attempt('login', 'ip');
  const token = b.createRecovery(); b.consumeRecovery(token, 'new-password');
  assert.equal(verifyPassword('new-password', b.credential().password), true);
  assert.throws(() => b.consumeRecovery(token, 'another-password'), e => e.status === 401);
  const old = b.createRecovery(); b.replacePassword('changed-password');
  assert.throws(() => b.consumeRecovery(old, 'another-password'), e => e.status === 401);
  const expired = b.createRecovery(Date.now() - 300001);
  assert.throws(() => b.consumeRecovery(expired, 'another-password'), e => e.status === 401);
  const audit = JSON.stringify(b.audit.list());
  for (const secret of ['initial-password', 'new-password', 'sensitive', token, 'passkey']) assert.equal(audit.includes(secret), false);
  db.close();
});
