import test from 'node:test';
import assert from 'node:assert/strict';
import { JellyfinService } from '../src/service/jellyfin.js';

const current = { Id: 'series', Type: 'Series', Path: '/media/series/Dune', Name: 'old', ProductionYear: 1984, ProviderIds: { Tmdb: 'wrong' }, LockData: true, LockedFields: ['Overview'], ForcedSortName: 'custom sort', DisplayOrder: 'aired', OriginalTitle: 'original', Overview: 'keep overview', Genres: ['Science Fiction'], Tags: ['keep tag'], CustomRating: 'custom', OfficialRating: 'PG', People: [{ Name: 'Actor', Type: 'Actor' }], Studios: [{ Name: 'Studio' }], DateCreated: '2020-01-01T00:00:00Z', PreferredMetadataLanguage: 'zh', PreferredMetadataCountryCode: 'CN', AirTime: '20:00', Status: 'Ended', RunTimeTicks: 1000 };
const candidate = { Name: 'Dune', ProductionYear: 2021, ProviderIds: { Tmdb: '438631' } };
test('identification saves a complete metadata snapshot without calling synchronous RemoteSearch/Apply', async () => {
  const requests = [];
  const jellyfin = new JellyfinService({}, async (route, options) => {
    requests.push(route);
    if (route === 'Items') {
      if (options.query.ParentId) return { Items: [], TotalRecordCount: 0 };
      assert.equal(options.query.Ids, current.Id);
      for (const field of ['Settings', 'Tags', 'CustomRating', 'AirTime', 'People']) assert.ok(options.query.Fields.split(',').includes(field));
      return { Items: [structuredClone(current)] };
    }
    assert.equal(route, 'Items/series'); assert.equal(options.method, 'POST');
    assert.deepEqual(options.json, { ...current, Name: candidate.Name, ProductionYear: candidate.ProductionYear, ProviderIds: candidate.ProviderIds });
  });
  await jellyfin.apply(current.Id, candidate, current);
  assert.deepEqual(requests, ['Items', 'Items', 'Items/series']); assert.equal(current.Name, 'old');
});
test('full refresh only queues metadata work with the selected external IDs already saved', async () => {
  const jellyfin = new JellyfinService({}, async (route, options) => {
    assert.equal(route, 'Items/series/Refresh'); assert.equal(options.method, 'POST');
    assert.equal(options.query.MetadataRefreshMode, 'FullRefresh'); assert.equal(options.query.ImageRefreshMode, 'FullRefresh');
    assert.equal(options.query.ReplaceAllMetadata, true); assert.equal(options.query.ReplaceAllImages, false); assert.equal(options.query.Recursive, true);
  });
  await jellyfin.refreshItem('series', { full: true });
});
test('missing settings or a changed path prevents destructive partial metadata updates', async () => {
  for (const item of [{ ...current, LockData: undefined }, { ...current, Path: '/other/series' }]) {
    let writes = 0;
    const jellyfin = new JellyfinService({}, async route => { if (route === 'Items') return { Items: [item] }; writes++; });
    await assert.rejects(jellyfin.apply(current.Id, candidate, current)); assert.equal(writes, 0);
  }
});
test('candidate without a year preserves the existing year and unrelated metadata', async () => {
  const jellyfin = new JellyfinService({}, async (route, options) => {
    if (route === 'Items' && options.query.ParentId) return { Items: [], TotalRecordCount: 0 };
    if (route === 'Items') return { Items: [structuredClone(current)] };
    assert.equal(options.json.ProductionYear, current.ProductionYear);
    assert.deepEqual(options.json.Tags, current.Tags); assert.equal(options.json.LockData, true);
  });
  await jellyfin.apply(current.Id, { ...candidate, ProductionYear: undefined }, current);
});
test('series updates cannot overwrite independent child ratings through Jellyfin propagation', async () => {
  for (const child of [{ CustomRating: 'independent', OfficialRating: 'PG' }, { CustomRating: 'custom', OfficialRating: 'R', LockedFields: [] }]) {
    let writes = 0;
    const jellyfin = new JellyfinService({}, async (route, options) => {
      if (route === 'Items' && options.query.ParentId) return { Items: [child], TotalRecordCount: 1 };
      if (route === 'Items') return { Items: [structuredClone(current)] };
      writes++;
    });
    await assert.rejects(jellyfin.apply(current.Id, candidate, current), /独立评级/);
    assert.equal(writes, 0);
  }
});
