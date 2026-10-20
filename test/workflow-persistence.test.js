import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowService } from '../src/service/workflow.js';
import { persistenceFixture, scope } from './helpers/persistence.js';
const config = { ...scope, maxJobs: 10, maxQueue: 5, jobTtlMs: 60000 };
const item = { Id: 'm', Name: 'Original', Path: '/movies/Original.mkv', Type: 'Movie', LibraryId: 'lib' };
const candidate = { Name: 'Correct', ProductionYear: 2020, ProviderIds: { Tmdb: '1' } };
export function fakeServices() {
  const writes = [];
  return { writes, jellyfin: { search: async () => [candidate], apply: async () => writes.push('apply'), refreshItem: async () => {} }, mediaLibrary: { ensureItem: async () => item, unidentified: async () => ({ items: [item], total: 1 }), track: async () => {}, markIdentified: () => writes.push('cursor') }, deepseek: { identify: async () => ({ name: 'Correct', year: 2020 }) } };
}
export async function settled(workflow, id) {
  for (let n = 0; n < 200; n++) { const job = workflow.get(id); if (!['queued', 'running'].includes(job.status)) return job; await new Promise(r => setTimeout(r, 2)); }
  throw Error('workflow timeout');
}
test('queued correction and stored confirmation survive replacement of the workflow service', async t => {
  const { repository } = persistenceFixture(t), services = fakeServices();
  const a = new WorkflowService(config, services, { repository, autoStart: false });
  const job = a.enqueue({ correction: true, dryRun: true, itemIds: ['m'], identity: { name: 'Correct', year: 2020 } });
  assert.equal(a.get(job.id).status, 'queued');
  await a.close();
  const b = new WorkflowService(config, services, { repository });
  const preview = await settled(b, job.id); await b.close();
  assert.equal(preview.status, 'needs_review'); assert.deepEqual(services.writes, []);
  const c = new WorkflowService(config, services, { repository, autoStart: false });
  c.confirm(job.id, 'm', preview.items[0].candidates[0].candidateId); await c.close();
  const d = new WorkflowService(config, services, { repository });
  const result = await settled(d, job.id); await d.close();
  assert.equal(result.status, 'completed'); assert.deepEqual(services.writes, ['apply']);
  assert.equal(result.items[0].selectedCandidate.candidateId, preview.items[0].candidates[0].candidateId);
});
test('a failed checkpoint prevents subsequent remote writes and acceptance', async t => {
  const { repository } = persistenceFixture(t), services = fakeServices();
  const wf = new WorkflowService(config, services, { repository, autoStart: false });
  const job = wf.enqueue({ dryRun: true });
  repository.save = () => { throw Error('disk full'); };
  await wf.start();
  assert.ok(wf.storageError); assert.deepEqual(services.writes, []);
  assert.throws(() => wf.enqueue({}), e => e.status === 503); await wf.close();
  assert.ok(repository.get(job.id));
});

test('the complete discovered media plan is durable before the first external write', async t => {
  const { repository } = persistenceFixture(t), services = fakeServices();
  let reached, release;
  const reachedWrite = new Promise(r => { reached = r; }), blocked = new Promise(r => { release = r; });
  services.mediaLibrary.unidentified = async () => ({ items: [item, { ...item, Id: 'second', Path: '/second.mkv' }], total: 2 });
  services.mediaLibrary.ensureItem = async id => ({ ...item, Id: id, ...(id === 'second' ? { Path: '/second.mkv' } : {}) });
  services.jellyfin.apply = async () => { reached(); await blocked; };
  const wf = new WorkflowService(config, services, { repository });
  const job = wf.enqueue({}); await reachedWrite;
  const snapshot = repository.get(job.id);
  release(); await wf.close();
  assert.deepEqual(snapshot.items.map(i => i.itemId), ['m', 'second']);
});

test('redaction preserves structural candidate keys even when a password equals a field name', async t => {
  const { repository } = persistenceFixture(t), services = fakeServices();
  const wf = new WorkflowService({ ...config, adminPassword: 'ProviderIds' }, services, { repository });
  const job = wf.enqueue({ dryRun: true }); await wf.close();
  const saved = wf.get(job.id);
  assert.deepEqual(saved.items[0].candidates[0].ProviderIds, { Tmdb: '1' });
});

test('correction retry retains the original manual choice and candidate IDs without another search', async t => {
  const { repository } = persistenceFixture(t), services = fakeServices(); let searches = 0;
  services.jellyfin.search = async () => { searches++; return searches === 1 ? [candidate] : [{ ...candidate, ProviderIds: { Tmdb: '999' } }]; };
  services.jellyfin.apply = async () => { throw Error('save failed'); };
  const wf = new WorkflowService(config, services, { repository });
  const preview = await settled(wf, wf.enqueue({ correction: true, dryRun: true, itemIds: ['m'], identity: { name: 'Correct', year: 2020 } }).id);
  const chosen = preview.items[0].candidates[0];
  wf.confirm(preview.id, 'm', chosen.candidateId); await settled(wf, preview.id);
  const retry = wf.retry(preview.id); const result = await settled(wf, retry.id); await wf.close();
  assert.equal(result.status, 'needs_review'); assert.equal(searches, 1);
  assert.equal(result.items[0].selectedCandidate.candidateId, chosen.candidateId);
  assert.deepEqual(result.items[0].candidates, preview.items[0].candidates);
});

test('retry still completes when its expired unprotected parent is pruned at capacity', async t => {
  const { repository } = persistenceFixture(t), services = fakeServices(); let calls = 0;
  services.deepseek.identify = async () => { if (!calls++) throw Error('AI unavailable'); return { name: 'Correct', year: 2020 }; };
  const wf = new WorkflowService({ ...config, maxJobs: 1 }, services, { repository });
  const first = await settled(wf, wf.enqueue({}).id);
  const retry = wf.retry(first.id); const result = await settled(wf, retry.id); await wf.close();
  assert.equal(result.status, 'completed'); assert.deepEqual(services.writes, ['apply', 'cursor']);
});

test('duplicate callbacks return the accepted job even when the queue is full', async t => {
  const { repository } = persistenceFixture(t), wf = new WorkflowService({ ...config, maxQueue: 1 }, {}, { repository, autoStart: false });
  const input = { hash: 'a'.repeat(40) }, first = wf.enqueue(input);
  assert.equal(wf.enqueue(input).id, first.id); await wf.close();
});
