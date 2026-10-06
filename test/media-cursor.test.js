import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MediaCursorStore } from '../src/util/media-cursor.js';
import { MediaLibraryService } from '../src/service/media-library.js';
import { WorkflowService } from '../src/service/workflow.js';

const media = (id, date = '2026-10-05T12:00:00Z', library = 'movies') => ({ Id: id, DateCreated: date, LibraryId: library, Type: 'Movie', Path: `/media/${id}.mkv`, ProviderIds: { Tmdb: '123' } });
function file(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'media-cursor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'cursors.json');
}
test('first scan includes existing self-identified media; successful cursor survives restart', t => {
  const filename = file(t), store = new MediaCursorStore(filename, 'server');
  const old = media('old', '2020-01-01T00:00:00Z'), recent = media('recent');
  assert.equal(store.needsIdentification(old), true);
  store.track([old, recent]); store.confirm(recent);
  const reopened = new MediaCursorStore(filename, 'server');
  assert.equal(reopened.needsIdentification(recent), false);
  assert.equal(reopened.needsIdentification(old), true);
  reopened.confirm(old);
  assert.equal(new MediaCursorStore(filename, 'server').needsIdentification(old), false);
  assert.equal(new MediaCursorStore(filename, 'another-server').needsIdentification(old), true);
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).version, 1);
});
test('failed synchronous save does not advance the in-memory cursor or overwrite saved state', t => {
  const filename = file(t), store = new MediaCursorStore(filename), item = media('failed-save');
  store.track([item]);
  store.filename = path.join(filename, 'blocked.json');
  assert.throws(() => store.confirm(item));
  assert.equal(store.needsIdentification(item), true);
  assert.equal(new MediaCursorStore(filename).needsIdentification(item), true);
});
test('workflow confirms after successful application; failed and preview media survive service restart', async t => {
  const filename = file(t), items = [media('preview'), media('failed')];
  const candidate = { Name: 'Dune', ProductionYear: 2021, ProviderIds: { Tmdb: '438631' } };
  const jellyfin = {
    libraries: async () => [{ ItemId: 'movies', CollectionType: 'movies', Locations: ['/media'] }],
    items: async () => items, refreshAndWait: async () => {}, search: async () => [candidate], apply: async () => { throw new Error('apply failed'); },
    verify: async () => { throw new Error('metadata is still loading'); }
  };
  const config = { mediaCursorFile: filename, jellyfinUrl: 'http://mock/', maxJobs: 10, maxQueue: 5, jobTtlMs: 60000 };
  const service = new MediaLibraryService(config, jellyfin);
  const workflow = new WorkflowService(config, { jellyfin, mediaLibrary: service, deepseek: { identify: async () => ({ name: 'Dune', year: 2021 }) } });
  async function finish(input) {
    const job = workflow.enqueue(input);
    await workflow.close(); workflow.stopping = false;
    return workflow.get(job.id);
  }
  assert.equal((await finish({ itemIds: ['preview'], dryRun: true })).status, 'needs_review');
  assert.equal((await finish({ itemIds: ['failed'] })).status, 'failed');
  const reopened = new MediaLibraryService(config, jellyfin);
  assert.deepEqual((await reopened.unidentified()).items.map(i => i.Id), ['preview', 'failed']);
  jellyfin.apply = async () => {};
  assert.equal((await finish({ itemIds: ['failed'] })).status, 'completed');
  assert.deepEqual((await new MediaLibraryService(config, jellyfin).unidentified()).items.map(i => i.Id), ['preview']);
});
test('equal dates, pending holes, new libraries and new servers cannot be skipped', () => {
  const store = new MediaCursorStore(undefined, 'server');
  const a = media('a'), b = media('b'), old = media('failed', '2020-01-01T00:00:00Z');
  store.track([a, b, old]); store.confirm(a);
  assert.equal(store.needsIdentification(b), true);
  assert.equal(store.needsIdentification(old), true);
  store.confirm(b);
  assert.equal(store.needsIdentification(b), false);
  assert.equal(store.needsIdentification(media('new', '2026-10-06T00:00:00Z')), true);
  assert.equal(store.needsIdentification(media('new-library', '2020-01-01T00:00:00Z', 'another')), true);
});
test('missing dates are identified once and malformed state fails explicitly', t => {
  const store = new MediaCursorStore(); const item = media('no-date', null);
  store.track([item]); store.confirm(item);
  assert.equal(store.needsIdentification(item), false);
  const filename = file(t); writeFileSync(filename, '{invalid');
  assert.throws(() => new MediaCursorStore(filename), /游标/);
});
test('confirmation cannot create a cursor for an untracked library', () => {
  const store = new MediaCursorStore();
  assert.throws(() => store.confirm(media('untracked')), /尚未登记/);
  assert.equal(store.needsIdentification(media('older', '2020-01-01T00:00:00Z')), true);
});
test('confirming an old preview after moving to another library cannot write or advance its cursor', async () => {
  let moved = false, writes = 0;
  const target = media('target'), old = media('old', '2020-01-01T00:00:00Z', 'other');
  const candidate = { Name: 'Dune', ProductionYear: 2021, ProviderIds: { Tmdb: '438631' } };
  const jellyfin = {
    libraries: async () => ['movies', 'other'].map(id => ({ ItemId: id, CollectionType: 'movies', Locations: ['/media'] })),
    items: async query => query.ParentId === 'movies' ? (moved ? [] : [target]) : (moved ? [{ ...target, LibraryId: 'other' }, old] : [old]),
    refreshAndWait: async () => {}, search: async () => [candidate], apply: async () => { writes++; }, verify: async () => candidate
  };
  const config = { maxJobs: 10, maxQueue: 5, jobTtlMs: 60000 }, mediaLibrary = new MediaLibraryService(config, jellyfin);
  const workflow = new WorkflowService(config, { jellyfin, mediaLibrary, deepseek: { identify: async () => ({ name: 'Dune', year: 2021 }) } });
  const job = workflow.enqueue({ libraryId: 'movies', itemIds: ['target'], dryRun: true });
  await workflow.close(); workflow.stopping = false;
  const preview = workflow.get(job.id); moved = true;
  workflow.confirm(job.id, 'target', preview.items[0].candidates[0].candidateId);
  await workflow.close();
  assert.equal(workflow.get(job.id).status, 'failed'); assert.equal(writes, 0);
  assert.deepEqual((await mediaLibrary.unidentified({ libraryId: 'other' })).items.map(i => i.Id), ['target', 'old']);
});
test('library lists use show/movie added dates descending and cursor instead of external IDs', async () => {
  const queries = [], store = new MediaCursorStore();
  const jellyfin = {
    libraries: async () => ['movies', 'tvshows'].map(type => ({ ItemId: type, CollectionType: type, Locations: ['/media'] })),
    items: async query => { queries.push(query); return [{ ...media(query.ParentId), LibraryId: query.ParentId, Type: query.IncludeItemTypes }]; }
  };
  const service = new MediaLibraryService({}, jellyfin, store);
  const first = await service.unidentified(); assert.equal(first.total, 2);
  assert.ok(queries.every(q => q.SortBy === 'DateCreated' && q.SortOrder === 'Descending'));
  await service.track(first.items); service.markIdentified(first.items[0]);
  assert.equal((await service.unidentified()).total, 1);
});
test('initial selective scan preserves unselected older media for the next scan', async () => {
  const items = [media('new'), media('old', '2020-01-01T00:00:00Z')];
  const jellyfin = { libraries: async () => [{ ItemId: 'movies', CollectionType: 'movies', Locations: ['/media'] }], items: async () => items };
  const service = new MediaLibraryService({}, jellyfin);
  const selected = (await service.unidentified({ itemIds: ['new'] })).items;
  await service.track(selected, { itemIds: ['new'] }); service.markIdentified(selected[0]);
  assert.deepEqual((await service.unidentified()).items.map(i => i.Id), ['old']);
});
