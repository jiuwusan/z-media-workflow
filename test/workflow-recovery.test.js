import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileIntent, recoverRunningActions } from '../src/service/workflow-recovery.js';
import { WorkflowService } from '../src/service/workflow.js';
import { persistenceFixture, scope } from './helpers/persistence.js';
const original = { Id: 'm', Name: 'Before', Type: 'Movie', LibraryId: 'lib', Path: '/movies/a.mkv', ProviderIds: {} };
const candidate = { Name: 'After', ProductionYear: 2020, ProviderIds: { Tmdb: '1' } };
const intent = { kind: 'jellyfin.apply', sourceScope: scope, target: { itemId: 'm', type: 'Movie', libraryId: 'lib', path: original.Path, before: original }, expected: candidate };
function servicesFor(item) { return { mediaLibrary: { ensureItem: async () => item, markIdentified: () => {} } }; }
test('media reconciliation requires full identity and expected metadata, without remote writes', async () => {
  assert.equal((await reconcileIntent(intent, servicesFor({ ...original, ...candidate }))).state, 'matched');
  assert.equal((await reconcileIntent(intent, servicesFor(original))).state, 'unchanged');
  assert.equal((await reconcileIntent(intent, servicesFor({ ...original, ProviderIds: candidate.ProviderIds }))).state, 'conflict');
  assert.equal((await reconcileIntent(intent, servicesFor({ ...original, ...candidate, Path: '/changed' }))).state, 'conflict');
  assert.equal((await reconcileIntent(intent, servicesFor({ ...original, ...candidate, LibraryId: 'other' }))).state, 'conflict');
  assert.equal((await reconcileIntent(intent, { mediaLibrary: { ensureItem: async () => { throw Error('offline'); } } })).state, 'unknown');
});
test('running media intent reconciles and repeats local cursor completion safely', async t => {
  const { repository } = persistenceFixture(t); let cursor = 0;
  const job = repository.accept({ input: {}, sourceScope: scope }), action = repository.claimNext();
  job.items = [{ itemId: 'm', type: 'Movie', path: original.Path, libraryId: 'lib', status: 'running', phase: 'prepared', intent, candidates: [candidate] }];
  repository.save(job);
  const services = servicesFor({ ...original, ...candidate }); services.mediaLibrary.markIdentified = () => { cursor++; };
  await recoverRunningActions({ repository, services, sourceScope: scope });
  assert.equal(repository.get(job.id).items[0].status, 'completed'); assert.equal(cursor, 1);
  assert.equal(repository.get(job.id).status, 'completed'); assert.equal(repository.runningActions().length, 0);
  assert.equal(action.kind, 'run');
});
test('lost apply response is reconciled on retry and never writes a second time', async t => {
  const { repository } = persistenceFixture(t); let current = structuredClone(original), writes = 0, cursor = 0;
  const services = { mediaLibrary: { ensureItem: async () => current, unidentified: async () => ({ items: [current], total: 1 }), track: async () => {}, markIdentified: () => { cursor++; } }, deepseek: { identify: async () => ({ name: 'After', year: 2020 }) }, jellyfin: { search: async () => [candidate], apply: async () => { writes++; current = { ...current, ...candidate }; throw Error('response lost'); }, refreshItem: async () => {} } };
  const wf = new WorkflowService({ ...scope }, services, { repository });
  const first = wf.enqueue({}); await wf.close(); wf.stopping = false;
  assert.equal(wf.get(first.id).status, 'failed');
  const retry = wf.retry(first.id); await wf.close();
  assert.equal(wf.get(retry.id).status, 'completed'); assert.equal(writes, 1); assert.equal(cursor, 1);
  assert.equal(wf.get(first.id).items[0].phase, 'completed');
});
test('source changes and offline recovery preserve unresolved writes for human handling', async t => {
  const { repository } = persistenceFixture(t);
  const job = repository.accept({ input: { correction: true }, sourceScope: scope }); repository.claimNext();
  job.items = [{ itemId: 'm', status: 'running', intent, phase: 'prepared' }]; repository.save(job);
  await recoverRunningActions({ repository, services: servicesFor({ ...original, ...candidate }), sourceScope: { ...scope, jellyfinUrl: 'http://changed/' } });
  const restored = repository.get(job.id);
  assert.equal(restored.status, 'failed'); assert.equal(restored.items[0].recoveryState, 'interrupted');
  assert.equal(restored.items[0].phase, 'prepared');
});

test('cursor failure retains an unresolved intent and correction recovery never changes cursors', async t => {
  const { repository } = persistenceFixture(t); let calls = 0;
  const services = servicesFor({ ...original, ...candidate });
  services.mediaLibrary.markIdentified = () => { calls++; throw Error('cursor disk full'); };
  for (const correction of [false, true]) {
    const job = repository.accept({ input: { correction }, sourceScope: scope }); repository.claimNext();
    job.items = [{ itemId: 'm', status: 'running', intent, phase: 'prepared' }]; repository.save(job);
    await recoverRunningActions({ repository, services, sourceScope: scope });
    const saved = repository.get(job.id);
    assert.equal(saved.status, correction ? 'completed' : 'failed');
    assert.equal(saved.items[0].phase, correction ? 'completed' : 'verified');
  }
  assert.equal(calls, 1);
});
