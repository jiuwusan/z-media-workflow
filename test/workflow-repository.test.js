import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorkflowDatabase } from '../src/storage/database.js';
import { WorkflowRepository } from '../src/storage/workflow-repository.js';
import { persistenceFixture, scope } from './helpers/persistence.js';

test('accepted tasks, stable candidates and FIFO actions survive reopening', t => {
  const { repository: repo, filename } = persistenceFixture(t);
  const input = { hash: 'a'.repeat(40) };
  const a = repo.accept({ input, sourceScope: scope });
  assert.equal(repo.accept({ input, sourceScope: scope }).id, a.id);
  const b = repo.accept({ input, sourceScope: { ...scope, qbtUrl: 'http://other/' } });
  assert.notEqual(b.id, a.id);
  const action = repo.claimNext(); assert.equal(action.jobId, a.id);
  a.status = 'needs_review'; a.items = [{ itemId: 'm', status: 'needs_review', candidates: [{ candidateId: 'stable', Name: '电影' }] }];
  repo.save(a, { actionId: action.id, actionStatus: 'completed' });
  const db = openWorkflowDatabase(filename); t.after(() => db.close());
  const reopened = new WorkflowRepository(db, { maxJobs: 10, maxQueue: 5, jobTtlMs: 60000 });
  assert.equal(reopened.get(a.id).items[0].candidates[0].candidateId, 'stable');
  assert.equal(reopened.claimNext().jobId, b.id);
  assert.equal(reopened.claimNext(), null);
  const list = reopened.list({ page: 1, pageSize: 1 });
  assert.equal(list.total, 2); assert.equal(list.items[0].id, b.id); assert.equal(list.items[0].items, undefined); db.close();
});

test('capacity and TTL protect reviews and unresolved writes; pruning cascades', t => {
  const { repository: repo, database } = persistenceFixture(t, { maxJobs: 3, maxQueue: 2 });
  const a = repo.accept({ input: {}, sourceScope: scope });
  const b = repo.accept({ input: {}, sourceScope: scope });
  assert.throws(() => repo.accept({ input: {}, sourceScope: scope }), e => e.status === 429);
  for (const j of [a, b]) { const action = repo.claimNext(); j.status = 'failed'; j.updatedAt = '2000-01-01T00:00:00.000Z'; j.items = [{ itemId: j.id, status: 'failed', intent: { kind: 'jellyfin.apply' }, phase: 'prepared' }]; repo.save(j, { actionId: action.id, actionStatus: 'failed' }); }
  repo.prune(); assert.equal(repo.list().total, 2);
  a.items = []; repo.save(a); repo.prune();
  assert.equal(repo.list().total, 1);
  assert.equal(database.connection.prepare('SELECT count(*) AS n FROM workflow_actions WHERE job_id=?').get(a.id).n, 0);
});

test('action failure rolls back acceptance; confirm is atomic and preserves selected snapshot', t => {
  const { repository: repo, database } = persistenceFixture(t);
  database.connection.exec("CREATE TRIGGER reject_action BEFORE INSERT ON workflow_actions BEGIN SELECT RAISE(ABORT,'no disk'); END");
  assert.throws(() => repo.accept({ input: {}, sourceScope: scope }));
  assert.equal(repo.list().total, 0);
  database.connection.exec('DROP TRIGGER reject_action');
  const j = repo.accept({ input: {}, sourceScope: scope }), action = repo.claimNext();
  j.status = 'needs_review'; j.items = [{ itemId: 'm', status: 'needs_review', candidates: [{ candidateId: 'c', Name: 'chosen' }] }];
  repo.save(j, { actionId: action.id, actionStatus: 'completed' });
  repo.enqueueAction(j.id, { kind: 'confirm', payload: { itemId: 'm', candidateId: 'c' } });
  assert.throws(() => repo.enqueueAction(j.id, { kind: 'confirm', payload: { itemId: 'm', candidateId: 'c' } }), e => e.status === 409);
  assert.equal(repo.claimNext().payload.candidate.Name, 'chosen');
});

test('list summaries never expose recovery candidate payloads', t => {
  const { repository: repo } = persistenceFixture(t);
  const job = repo.accept({ input: {}, sourceScope: scope });
  job.recovery = [{ itemId: 'large', candidates: [{ candidateId: 'private-detail' }] }]; repo.save(job);
  assert.equal(repo.list().items[0].recovery, undefined);
  assert.equal(repo.get(job.id).recovery[0].itemId, 'large');
});

