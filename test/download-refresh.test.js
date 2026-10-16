import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowService } from '../src/service/workflow.js';
import { MediaLibraryService } from '../src/service/media-library.js';
import { JellyfinService } from '../src/service/jellyfin.js';

test('download refresh targets torrent libraries and waits ten seconds before reading every library', async t => {
  const requests = [], waits = [], queries = [];
  let release;
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms === 10000) { waits.push(ms); release = () => callback(...args); return; }
    return realSetTimeout(callback, ms, ...args);
  });
  const jellyfin = new JellyfinService({}, async (path, options) => {
    requests.push({ path, ...options });
    if (path === 'ScheduledTasks') return [{ Key: 'RefreshLibrary', State: 'Idle' }];
  });
  const config = { maxJobs: 10, maxQueue: 5, jobTtlMs: 60000 };
  const workflow = new WorkflowService(config, {
    jellyfin,
    qbittorrent: {
      torrent: async () => ({ progress: 1, save_path: '/media/movies' }),
      files: async () => [{ name: 'A.mkv', priority: 1 }]
    },
    mediaLibrary: {
      librariesForTorrent: async (torrent, files) => {
        assert.equal(torrent.save_path, '/media/movies'); assert.equal(files[0].name, 'A.mkv');
        return [{ ItemId: 'movies' }, { ItemId: 'series' }];
      },
      unidentified: async query => { queries.push(query); return { items: [], total: 0 }; }
    }
  });
  const job = workflow.enqueue({ hash: 'a'.repeat(40) });
  await new Promise(resolve => realSetTimeout(resolve, 5));
  assert.deepEqual(requests, ['movies', 'series'].map(id => ({ path: `Items/${id}/Refresh`, method: 'POST', query: {
    Recursive: true, MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', ReplaceAllMetadata: false, ReplaceAllImages: false
  } })));
  assert.deepEqual(waits, [10000]); assert.equal(queries.length, 0);
  release(); await workflow.close();
  assert.equal(workflow.get(job.id).status, 'completed');
  assert.equal(queries.length, 1); assert.equal(queries[0].libraryId, undefined); assert.equal(queries[0].type, undefined);
});

test('torrent library discovery maps selected videos without requiring existing Jellyfin items', async () => {
  const service = new MediaLibraryService({ pathMapping: { from: '/downloads', to: '/media' } }, {
    libraries: async () => [
      { ItemId: 'movies', CollectionType: 'movies', Locations: ['/media/movies'] },
      { ItemId: 'series', CollectionType: 'tvshows', Locations: ['/media/series', '/media/other-series'] },
      { ItemId: 'music', CollectionType: 'music', Locations: ['/media/music'] }
    ],
    items: async () => { throw new Error('new media need not exist yet'); }
  });
  const torrent = { save_path: '/downloads' };
  const libraries = await service.librariesForTorrent(torrent, [
    { name: 'movies/A.mkv', priority: 1 }, { name: 'movies/B.mp4', priority: 1 },
    { name: '/downloads/other-series/Show/E01.mkv', priority: 1 },
    { name: 'unselected/C.mkv', priority: 0 }, { name: 'readme.txt', priority: 1 }
  ]);
  assert.deepEqual(libraries.map(l => l.ItemId), ['movies', 'series']);
  await assert.rejects(service.librariesForTorrent(torrent, [{ name: 'movies-other/A.mkv', priority: 1 }]), /不属于.*媒体库/);
  await assert.rejects(service.librariesForTorrent(torrent, [{ name: 'movies/A.mkv', priority: 1 }, { name: 'missing/B.mkv', priority: 1 }]), /不属于.*媒体库/);
  await assert.rejects(service.librariesForTorrent(torrent, [{ name: 'readme.txt', priority: 1 }]), /没有.*视频/);
  assert.deepEqual((await service.librariesForTorrent({ content_path: '/downloads/movies/A.mkv' }, [])).map(l => l.ItemId), ['movies']);
});
