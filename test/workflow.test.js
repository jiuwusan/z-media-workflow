import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowService } from '../src/service/workflow.js';
import { MediaLibraryService } from '../src/service/media-library.js';
const movie = { Id: 'm', Type: 'Movie', Path: '/media/movies/Dune.2021.mkv', Name: 'Dune.2021', ProviderIds: {} };
const candidate = { Name: 'Dune', ProductionYear: 2021, ProviderIds: { Tmdb: '438631' } };
const config = { pollMs: 1, maxJobs: 10, maxQueue: 5, jobTtlMs: 60000, ingestRetries: 0, pathMapping: {}, seriesLibraryId: 's', movieLibraryId: 'l' };
const fixture = (overrides = {}) => {
  const events = [];
  const jellyfin = { refreshAndWait: async () => events.push('scan'), search: async () => [candidate], apply: async () => events.push('apply'), verify: async () => ({ ...movie, ...candidate }), item: async () => movie, refreshItem: async () => {} };
  const deps = { jellyfin, qbittorrent: { torrent: async () => ({ progress: 1 }), files: async () => [] }, deepseek: { identify: async () => ({ name: 'Dune', year: 2021 }) }, mediaLibrary: { forTorrent: async () => ({ items: [movie], missingPaths: [] }), unidentified: async () => ({ items: [movie], total: 1 }), ensureItem: async () => movie }, ...overrides };
  return { workflow: new WorkflowService(config, deps), events, deps };
};
async function done(workflow, job) {
  for (let i = 0; i < 100; i++) { const result = workflow.get(job.id); if (!['queued', 'running'].includes(result.status)) return result; await new Promise(r => setTimeout(r, 2)); }
  throw new Error('job did not finish');
}
test('serial workflow deduplicates hash and confirms applied metadata', async () => {
  const { workflow, events } = fixture(); const a = workflow.enqueue({ hash: 'a'.repeat(40) });
  assert.equal(workflow.enqueue({ hash: 'a'.repeat(40) }).id, a.id);
  const result = await done(workflow, a); assert.equal(result.status, 'completed'); assert.deepEqual(events, ['scan', 'apply']); assert.equal(result.items[0].confirmed.ProviderIds.Tmdb, '438631');
});
test('dry run does not write metadata and can later confirm stored candidate', async () => {
  const { workflow, events } = fixture(); const job = workflow.enqueue({ dryRun: true });
  let result = await done(workflow, job); assert.equal(result.status, 'needs_review'); assert.deepEqual(events, ['scan']);
  assert.throws(() => workflow.confirm(job.id, 'm', 'forged'), /候选/);
  workflow.confirm(job.id, 'm', result.items[0].candidates[0].candidateId);
  result = await done(workflow, job); assert.equal(result.status, 'completed'); assert.deepEqual(events, ['scan', 'apply']);
});
test('failed verification marks task failed and hash can be retried', async () => {
  const { workflow, deps } = fixture(); deps.jellyfin.verify = async () => { throw new Error('回读不匹配'); };
  const job = workflow.enqueue({ hash: 'b'.repeat(40) }); assert.equal((await done(workflow, job)).status, 'failed');
  deps.jellyfin.verify = async () => ({ ...movie, ...candidate });
  const next = workflow.retry(job.id); assert.equal((await done(workflow, next)).status, 'completed');
});
test('ambiguous candidates are preserved without auto apply and partial errors remain visible', async () => {
  const { workflow, deps, events } = fixture();
  deps.mediaLibrary.unidentified = async () => ({ items: [movie, { ...movie, Id: 'bad', Path: '/media/movies/bad.mkv' }], total: 2 });
  deps.deepseek.identify = async source => { if (source === 'bad') throw new Error('识别失败'); return { name: 'Dune', year: null }; };
  deps.jellyfin.search = async () => [candidate, { ...candidate, ProductionYear: 1984, ProviderIds: { Tmdb: '841' } }];
  const result = await done(workflow, workflow.enqueue({})); assert.equal(result.status, 'needs_review'); assert.equal(result.items[1].status, 'failed'); assert.equal(result.items[0].candidates.length, 2); assert.deepEqual(events, ['scan']);
});
test('media scope excludes other libraries and locates Series for downloaded season episode', async () => {
  const jelly = { libraries: async () => [{ ItemId: 's', CollectionType: 'tvshows', Locations: ['/media/series'] }, { ItemId: 'l', CollectionType: 'movies', Locations: ['/media/movies'] }], items: async query => query.ParentId === 's' ? [{ Id: 'series', Type: 'Series', Path: '/media/series/三体', ProviderIds: {} }] : [movie] };
  const lib = new MediaLibraryService({ ...config, pathMapping: { from: '/downloads', to: '/media' } }, jelly);
  const matches = await lib.forTorrent({ save_path: '/downloads/series' }, [{ name: '三体/Season 01/S01E01.mkv' }]);
  assert.equal(matches.items.length, 1); assert.equal(matches.items[0].Id, 'series'); assert.deepEqual(matches.missingPaths, []);
  assert.deepEqual((await lib.unidentified({ libraryId: 's' })).items.map(i => i.Id), ['series']);
  await assert.rejects(lib.unidentified({ libraryId: 'unknown' }), /媒体库/);
});

test('retry re-verifies failed applied candidate even when provider IDs already exist', async () => {
  let applied = false, attempts = 0;
  const { workflow, deps } = fixture();
  deps.mediaLibrary.forTorrent = async () => ({ items: [{ ...movie, ProviderIds: applied ? candidate.ProviderIds : {} }], missingPaths: [] });
  deps.jellyfin.apply = async () => { applied = true; };
  deps.jellyfin.verify = async () => { attempts++; if (attempts === 1) throw new Error('wrong title despite provider IDs'); return { ...movie, ...candidate }; };
  const original = workflow.enqueue({ hash: 'c'.repeat(40) }); assert.equal((await done(workflow, original)).status, 'failed');
  const retried = await done(workflow, workflow.retry(original.id));
  assert.equal(attempts, 2); assert.equal(retried.items[0].confirmed.Name, 'Dune'); assert.equal(retried.status, 'completed');
});

test('partially ingested multi-movie torrent retains missing file and fails instead of deduplicating success', async () => {
  const { workflow, deps } = fixture();
  deps.mediaLibrary.forTorrent = async () => ({ items: [movie], missingPaths: ['/media/movies/Other.mkv'] });
  const result = await done(workflow, workflow.enqueue({ hash: 'd'.repeat(40) }));
  assert.equal(result.status, 'failed'); assert.equal(result.items.find(i => i.path.endsWith('Other.mkv')).status, 'failed');
});

test('recovery survives a second retry failing before items are discovered', async () => {
  let applied = false, verifies = 0, scans = 0;
  const { workflow, deps } = fixture();
  deps.mediaLibrary.forTorrent = async () => ({ items: [{ ...movie, ProviderIds: applied ? candidate.ProviderIds : {} }], missingPaths: [] });
  deps.jellyfin.refreshAndWait = async () => { if (++scans === 2) throw new Error('scan failed'); };
  deps.jellyfin.apply = async () => { applied = true; };
  deps.jellyfin.verify = async () => { if (++verifies === 1) throw new Error('bad title'); return { ...movie, ...candidate }; };
  const first = workflow.enqueue({ hash: 'e'.repeat(40) }); await done(workflow, first);
  const second = workflow.retry(first.id); assert.equal((await done(workflow, second)).status, 'failed');
  const third = await done(workflow, workflow.retry(second.id)); assert.equal(third.status, 'completed'); assert.equal(verifies, 2); assert.equal(third.items[0].confirmed.Name, 'Dune');
});

test('selective download ignores priority zero videos when checking missing paths', async () => {
  const jelly = { libraries: async () => [{ ItemId: 'l', CollectionType: 'movies', Locations: ['/media/movies'] }], items: async () => [movie] };
  const lib = new MediaLibraryService(config, jelly);
  const result = await lib.forTorrent({ save_path: '/media/movies' }, [{ name: 'Dune.2021.mkv', priority: 1 }, { name: 'Skipped.mkv', priority: 0 }]);
  assert.deepEqual(result.missingPaths, []); assert.equal(result.items.length, 1);
});

test('bounded queue rejects additional work while preserving accepted tasks', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const { workflow, deps } = fixture(); workflow.config = { ...config, maxQueue: 1 };
  deps.jellyfin.refreshAndWait = () => blocked;
  const first = workflow.enqueue({}), second = workflow.enqueue({});
  assert.throws(() => workflow.enqueue({}), /队列已满/);
  release(); assert.equal((await done(workflow, first)).status, 'completed'); assert.equal((await done(workflow, second)).status, 'completed');
});
