import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaLibraryService } from '../src/service/media-library.js';
import { MediaCursorStore } from '../src/util/media-cursor.js';
import { WorkflowService } from '../src/service/workflow.js';
import { createApp } from '../src/app.js';

const libraries = [
  { ItemId: 'movies', Name: '电影', CollectionType: 'movies', Locations: ['/media/movies'] },
  { ItemId: 'series', Name: '剧集', CollectionType: 'tvshows', Locations: ['/media/series'] }
];
const media = (Id, Type, Name, DateCreated, ProductionYear) => ({ Id, Type, Name, DateCreated, ProductionYear, LibraryId: Type === 'Movie' ? 'movies' : 'series', Path: `/media/${Type === 'Movie' ? 'movies' : 'series'}/${Id}`, ProviderIds: { Tmdb: 'old' } });
const all = [
  media('m-old', 'Movie', 'Zulu', '2020-01-01', 2000),
  media('m-new', 'Movie', 'Beta', '2026-01-01', 2024),
  media('m-tie-b', 'Movie', 'Alpha', '2026-01-01', 2024),
  media('a-series', 'Series', 'Gamma', '2026-01-01', 1990),
  media('z-undated', 'Series', 'Delta', undefined, undefined),
  media('x-invalid', 'Movie', 'Echo', 'invalid', undefined)
];
const candidate = { Name: 'Dune', ProductionYear: 2021, ProviderIds: { Tmdb: '438631' } };
function fixture() {
  const items = structuredClone(all), writes = [], cursors = new MediaCursorStore();
  const jellyfin = {
    libraries: async () => libraries,
    items: async query => items.filter(i => i.LibraryId === query.ParentId),
    search: async () => [candidate],
    apply: async (id, value) => { writes.push({ id, value }); Object.assign(items.find(i => i.Id === id), value); },
    refreshItem: async () => {},
    refreshAndWait: async () => { throw new Error('correction must not scan libraries'); }
  };
  const mediaLibrary = new MediaLibraryService({}, jellyfin, cursors);
  const config = { maxJobs: 20, maxQueue: 10, jobTtlMs: 60000, adminUsername: 'admin', adminPassword: 'test-password-12345', sessionMs: 60000 };
  const services = { jellyfin, mediaLibrary, deepseek: { identify: async () => { throw new Error('manual correction must not require AI'); } } };
  services.workflow = new WorkflowService(config, services);
  return { config, services, mediaLibrary, workflow: services.workflow, writes, items, cursors };
}
async function settled(workflow, job) {
  await workflow.close(); workflow.stopping = false;
  return workflow.get(job.id);
}

test('media list includes identified items, merges libraries before sorting and paginating, and puts missing dates last', async () => {
  const { mediaLibrary, cursors } = fixture();
  cursors.track(all); for (const item of all) cursors.confirm(item);
  assert.equal((await mediaLibrary.unidentified()).total, 0);
  assert.deepEqual((await mediaLibrary.list({ page: 1, pageSize: 2 })).items.map(i => i.Id), ['a-series', 'm-new']);
  assert.deepEqual((await mediaLibrary.list({ page: 2, pageSize: 2 })).items.map(i => i.Id), ['m-tie-b', 'm-old']);
  const last = await mediaLibrary.list({ page: 3, pageSize: 2 });
  assert.deepEqual(last.items.map(i => i.Id), ['x-invalid', 'z-undated']); assert.equal(last.total, 6);
  assert.deepEqual((await mediaLibrary.list({ sort: 'date_asc' })).items.map(i => i.Id), ['m-old', 'a-series', 'm-new', 'm-tie-b', 'x-invalid', 'z-undated']);
});

test('media list supports stable name/year sorting and library, type and name filters', async () => {
  const { mediaLibrary } = fixture();
  assert.deepEqual((await mediaLibrary.list({ sort: 'name_asc' })).items.map(i => i.Id), ['m-tie-b', 'm-new', 'z-undated', 'x-invalid', 'a-series', 'm-old']);
  assert.deepEqual((await mediaLibrary.list({ sort: 'year_desc' })).items.map(i => i.Id), ['m-new', 'm-tie-b', 'm-old', 'a-series', 'x-invalid', 'z-undated']);
  const filtered = await mediaLibrary.list({ libraryId: 'movies', type: 'Movie', search: ' ALP ' });
  assert.equal(filtered.total, 1); assert.equal(filtered.items[0].Id, 'm-tie-b');
  assert.equal((await mediaLibrary.list({ libraryId: 'movies', type: 'Series' })).total, 0);
  await assert.rejects(mediaLibrary.list({ sort: 'invalid' }), /排序/);
});

test('correction bypasses the cursor and only writes after explicit selection, including after re-search', async () => {
  const { workflow, writes, cursors, services } = fixture();
  cursors.track(all); for (const item of all) cursors.confirm(item);
  const before = structuredClone(cursors.state);
  const job = await settled(workflow, workflow.enqueue({ correction: true, dryRun: false, itemIds: ['m-new'], identity: { name: 'Dune', year: 2021 } }));
  assert.equal(job.status, 'needs_review'); assert.equal(job.items.length, 1); assert.deepEqual(writes, []);
  assert.deepEqual(cursors.state, before);
  assert.throws(() => workflow.confirm(job.id, 'm-new', 'not-returned'), /候选不存在/);
  services.jellyfin.search = async () => [{ ...candidate, ProductionYear: 1984, ProviderIds: { Tmdb: '841' } }];
  const searched = await settled(workflow, workflow.search(job.id, 'm-new', { name: 'Dune', year: 1984 }));
  assert.deepEqual(writes, []); assert.equal(searched.items[0].status, 'needs_review');
  const result = await settled(workflow, workflow.confirm(job.id, 'm-new', searched.items[0].candidates[0].candidateId));
  assert.equal(result.status, 'completed'); assert.equal(writes.length, 1); assert.equal(writes[0].value.ProviderIds.Tmdb, '841');
  assert.deepEqual(cursors.state, before);
});

test('failed correction retry searches again and requires a new manual confirmation', async () => {
  const { workflow, services, writes } = fixture();
  const job = await settled(workflow, workflow.enqueue({ correction: true, dryRun: true, itemIds: ['m-new'], identity: { name: 'Dune', year: 2021 } }));
  const apply = services.jellyfin.apply;
  services.jellyfin.apply = async () => { throw new Error('save failed'); };
  const failed = await settled(workflow, workflow.confirm(job.id, 'm-new', job.items[0].candidates[0].candidateId));
  assert.equal(failed.status, 'failed');
  services.jellyfin.apply = apply;
  const retry = await settled(workflow, workflow.retry(job.id));
  assert.equal(retry.status, 'needs_review'); assert.deepEqual(writes, []);
});

test('media library API requires admin and CSRF, validates filters, and cannot enable automatic correction', async t => {
  const { config, services, workflow, writes } = fixture();
  const server = createApp({ config, services }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => server.close());
  const req = (path, options) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`, options);
  assert.equal((await req('/media/items')).status, 401);
  const login = await req('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: config.adminUsername, password: config.adminPassword }) });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': (await login.json()).data.csrfToken, 'Content-Type': 'application/json' };
  assert.equal((await req('/media/libraries', { headers })).status, 200);
  const list = await req('/media/items?page=1&pageSize=2', { headers });
  assert.equal(list.status, 200); assert.deepEqual((await list.json()).data.items.map(i => i.Id), ['a-series', 'm-new']);
  for (const query of ['sort=bad', 'page=0', 'type=Episode', 'search=' + 'a'.repeat(301)]) assert.equal((await req(`/media/items?${query}`, { headers })).status, 400);
  const route = '/media/m-new/identify';
  assert.equal((await req(route, { method: 'POST' })).status, 401);
  assert.equal((await req(route, { method: 'POST', headers: { Cookie: headers.Cookie }, body: '{}' })).status, 403);
  for (const [body, status] of [[{}, 422], [{ name: '' }, 422], [{ name: 'Dune', year: '2021' }, 422], [{ name: 'Dune', dryRun: false }, 400], [{ name: 'Dune', itemIds: [] }, 400]]) assert.equal((await req(route, { method: 'POST', headers, body: JSON.stringify(body) })).status, status);
  const response = await req(route, { method: 'POST', headers, body: JSON.stringify({ name: 'Dune', year: 2021 }) });
  assert.equal(response.status, 202);
  const job = await settled(workflow, (await response.json()).data);
  assert.equal(job.status, 'needs_review'); assert.deepEqual(writes, []);
});
