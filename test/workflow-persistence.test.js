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
