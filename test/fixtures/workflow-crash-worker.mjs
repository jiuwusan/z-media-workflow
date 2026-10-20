import { openWorkflowDatabase } from '../../src/storage/database.js';
import { WorkflowRepository } from '../../src/storage/workflow-repository.js';
import { WorkflowService } from '../../src/service/workflow.js';
import { writeFileSync } from 'node:fs';
const [filename, base, point, correction] = process.argv.slice(2);
const config = { jellyfinUrl: `${base}/`, qbtUrl: 'http://qbt/', maxJobs: 10, maxQueue: 5, jobTtlMs: 60000 };
function pause(at) {
  if (point === at) { process.send({ at }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
}
const services = {
  mediaLibrary: {
    ensureItem: async () => (await fetch(base)).json(),
    unidentified: async () => ({ items: [await (await fetch(base)).json()], total: 1 }), track: async () => {},
    markIdentified: () => { writeFileSync(`${filename}.cursor`, 'confirmed'); pause('cursor'); }
  },
  deepseek: { identify: async () => ({ name: 'After', year: 2020 }) },
  jellyfin: {
    search: async () => [{ Name: 'After', ProductionYear: 2020, ProviderIds: { Tmdb: '1' } }],
    apply: async (_id, candidate) => { await fetch(base, { method: 'POST', body: JSON.stringify(candidate) }); pause('http'); },
    refreshItem: async () => {}
  }
};
const database = openWorkflowDatabase(filename), repository = new WorkflowRepository(database, config);
const wf = new WorkflowService(config, services, { repository, autoStart: false });
const checkpoint = wf.checkpoint.bind(wf);
wf.checkpoint = job => { checkpoint(job); const phase = job.items[0]?.phase; if (phase === 'prepared') pause('prepared'); if (phase === 'verified') pause('verified'); };
let job;
if (correction === 'true') {
  job = repository.accept({ input: { correction: true, dryRun: true }, sourceScope: wf.scope });
  const action = repository.claimNext();
  job.items = [{ itemId: 'm', path: '/movies/a.mkv', type: 'Movie', libraryId: 'lib', status: 'needs_review', candidates: [{ candidateId: 'chosen', Name: 'After', ProductionYear: 2020, ProviderIds: { Tmdb: '1' } }] }];
  job.status = 'needs_review'; repository.save(job, { actionId: action.id, actionStatus: 'completed' });
  wf.confirm(job.id, 'm', 'chosen');
} else job = wf.enqueue({});
process.send({ jobId: job.id });
await wf.start();
