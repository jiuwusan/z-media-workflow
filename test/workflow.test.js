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
  const deps = { jellyfin, qbittorrent: { torrent: async () => ({ progress: 1 }), files: async () => [] }, deepseek: { identify: async () => ({ name: 'Dune', year: 2021 }) }, mediaLibrary: { track: () => {}, markIdentified: () => {}, forTorrent: async () => ({ items: [movie], missingPaths: [] }), unidentified: async () => ({ items: [movie], total: 1 }), ensureItem: async () => movie }, ...overrides };
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
test('failed application marks task failed and hash can be retried', async () => {
  const { workflow, deps } = fixture(); deps.jellyfin.apply = async () => { throw new Error('应用失败'); };
  const job = workflow.enqueue({ hash: 'b'.repeat(40) }); assert.equal((await done(workflow, job)).status, 'failed');
  deps.jellyfin.apply = async () => {};
  const next = workflow.retry(job.id); assert.equal((await done(workflow, next)).status, 'completed');
});
test('successful application completes and advances cursor without reading unfinished metadata', async () => {
  const { workflow, deps } = fixture(); let confirmed = 0;
  deps.jellyfin.verify = async () => { throw new Error('metadata is still loading'); };
  deps.jellyfin.item = async () => { throw new Error('metadata readback must not be called'); };
  deps.mediaLibrary.markIdentified = () => { confirmed++; };
  const result = await done(workflow, workflow.enqueue({}));
  assert.equal(result.status, 'completed'); assert.equal(confirmed, 1);
  assert.deepEqual(result.items[0].confirmed, candidate);
});
test('application failure keeps cursor pending and does not claim a confirmed result', async () => {
  const { workflow, deps } = fixture(); let confirmed = 0;
  deps.jellyfin.apply = async () => { throw new Error('apply rejected'); };
  deps.mediaLibrary.markIdentified = () => { confirmed++; };
  const result = await done(workflow, workflow.enqueue({}));
  assert.equal(result.status, 'failed'); assert.equal(confirmed, 0);
  assert.equal(result.items[0].confirmed, undefined);
});
test('series refresh request failure is a warning after successful identification', async () => {
  const { workflow, deps } = fixture(); let confirmed = 0;
  const series = { ...movie, Type: 'Series', Path: '/media/series/Dune.2021' };
  deps.mediaLibrary.unidentified = async () => ({ items: [series], total: 1 });
  deps.mediaLibrary.ensureItem = async () => series;
  deps.mediaLibrary.markIdentified = () => { confirmed++; };
  deps.jellyfin.verify = async () => { throw new Error('must not await metadata'); };
  deps.jellyfin.refreshItem = async () => { throw new Error('refresh request failed'); };
  const result = await done(workflow, workflow.enqueue({}));
  assert.equal(result.status, 'completed'); assert.equal(confirmed, 1);
  assert.match(result.items[0].refreshWarning, /refresh request failed/);
});
test('renamed media cannot apply a candidate from an old preview', async () => {
  const { workflow, deps, events } = fixture();
  const job = workflow.enqueue({ dryRun: true }), preview = await done(workflow, job);
  deps.mediaLibrary.ensureItem = async () => ({ ...movie, Path: '/media/movies/Other.2026.mkv' });
  workflow.confirm(job.id, movie.Id, preview.items[0].candidates[0].candidateId);
  const result = await done(workflow, job);
  assert.equal(result.status, 'failed'); assert.match(result.items[0].error, /路径已变化/);
  assert.deepEqual(events, ['scan']);
});
test('ambiguous candidates use the first result while partial errors remain visible', async () => {
  const { workflow, deps, events } = fixture();
  deps.mediaLibrary.unidentified = async () => ({ items: [movie, { ...movie, Id: 'bad', Path: '/media/movies/bad.mkv' }], total: 2 });
  deps.deepseek.identify = async source => { if (source === 'bad') throw new Error('识别失败'); return { name: 'Dune', year: null }; };
  deps.jellyfin.search = async () => [candidate, { ...candidate, ProductionYear: 1984, ProviderIds: { Tmdb: '841' } }];
  const result = await done(workflow, workflow.enqueue({})); assert.equal(result.status, 'failed'); assert.equal(result.items[1].status, 'failed'); assert.equal(result.items[0].candidates.length, 2); assert.deepEqual(events, ['scan', 'apply']);
  assert.equal(result.items[0].selectionMethod, 'fallback'); assert.equal(result.items[0].confirmed.ProviderIds.Tmdb, '438631');
});
test('AI resolves ambiguous candidates and successful application confirms the selected result', async () => {
  const { workflow, deps, events } = fixture(); let calls = 0;
  deps.deepseek.identify = async () => ({ name: 'Dune', year: null });
  deps.jellyfin.search = async () => [candidate, { ...candidate, ProductionYear: 1984, ProviderIds: { Tmdb: '841' } }];
  deps.deepseek.chooseCandidate = async (source, type, identity, candidates) => {
    calls++; assert.equal(source, 'Dune.2021'); assert.equal(type, 'Movie'); assert.equal(identity.year, null);
    return { candidateId: candidates[0].candidateId, confidence: 'high', reason: '原始文件名明确为2021年版本' };
  };
  const result = await done(workflow, workflow.enqueue({}));
  assert.equal(calls, 1); assert.equal(result.status, 'completed');
  assert.equal(result.items[0].selectionMethod, 'ai'); assert.match(result.items[0].aiDecision.reason, /2021/);
  assert.deepEqual(events, ['scan', 'apply']);
});
test('unique rule matches do not require a second AI request', async () => {
  const { workflow, deps } = fixture();
  deps.deepseek.chooseCandidate = async () => { throw new Error('must not call AI'); };
  const result = await done(workflow, workflow.enqueue({}));
  assert.equal(result.status, 'completed'); assert.equal(result.items[0].selectionMethod, 'rules');
});

test('English rule match prefers Chinese candidate with shared provider ID in either order', async () => {
  for (const reverse of [false, true]) {
    const { workflow, deps } = fixture();
    const chinese = { ...candidate, Name: '沙丘', ProviderIds: { Tmdb: '438631', Imdb: 'tt1160419' } };
    const candidates = [candidate, chinese];
    deps.jellyfin.search = async () => reverse ? candidates.toReversed() : candidates;
    deps.deepseek.chooseCandidate = async () => { throw new Error('shared ID should not require AI'); };
    const result = await done(workflow, workflow.enqueue({}));
    assert.equal(result.status, 'completed'); assert.equal(result.items[0].confirmed.Name, '沙丘');
    assert.equal(result.items[0].selectionMethod, 'rules');
  }
});

test('The Fixers English rule match can use AI to prefer its Chinese alias', async () => {
  const { workflow, deps } = fixture(); let calls = 0;
  const series = { ...movie, Type: 'Series', Path: '/media/series/The.Fixers.S01.2026.2160p.NF.WEB-DL' };
  deps.mediaLibrary.unidentified = async () => ({ items: [series], total: 1 });
  deps.mediaLibrary.ensureItem = async () => series;
  deps.deepseek.identify = async () => ({ name: 'The Fixers', year: 2026 });
  deps.jellyfin.search = async () => [
    { Name: 'The Fixers', ProductionYear: 2026, ProviderIds: { Imdb: 'tt39495239' } },
    { Name: '黑白清道夫', ProductionYear: 2026, ProviderIds: { Tmdb: 'example' } },
    { Name: '黑白清道夫', ProductionYear: 2025, ProviderIds: { Tmdb: 'old' } }
  ];
  deps.deepseek.chooseCandidate = async (source, type, identity, candidates) => {
    calls++; assert.equal(type, 'Series'); assert.equal(identity.year, 2026);
    assert.equal(candidates.length, 2); assert.ok(candidates.every(c => c.ProductionYear === 2026));
    return { candidateId: candidates.find(c => c.Name === '黑白清道夫').candidateId, confidence: 'high', reason: '中文译名对应原名和年份' };
  };
  const result = await done(workflow, workflow.enqueue({}));
  assert.equal(calls, 1); assert.equal(result.status, 'completed');
  assert.equal(result.items[0].confirmed.Name, '黑白清道夫'); assert.equal(result.items[0].selectionMethod, 'ai');
});

test('Chinese preference preserves English rule result on AI uncertainty or invalid choice', async () => {
  for (const mode of ['low', 'error', 'forged', 'wrong-year']) {
    const { workflow, deps } = fixture(); let calls = 0;
    deps.jellyfin.search = async () => [candidate, { Name: '沙丘', ProductionYear: 2021, ProviderIds: { Imdb: 'tt1160419' } }, { Name: '沙丘', ProductionYear: 1984, ProviderIds: { Tmdb: '841' } }];
    deps.deepseek.chooseCandidate = async (source, type, identity, candidates) => {
      calls++; if (mode === 'error') throw new Error('AI unavailable');
      return { candidateId: mode === 'wrong-year' ? candidates.find(c => c.ProductionYear === 1984)?.candidateId : mode === 'forged' ? 'forged' : candidates.find(c => c.Name === '沙丘').candidateId, confidence: mode === 'low' ? 'low' : 'high', reason: mode };
    };
    const result = await done(workflow, workflow.enqueue({}));
    assert.equal(calls, 1); assert.equal(result.status, 'completed');
    assert.equal(result.items[0].confirmed.Name, 'Dune'); assert.equal(result.items[0].selectionMethod, 'rules');
  }
});

test('Chinese preference excludes conflicting provider IDs and different years', async () => {
  const { workflow, deps } = fixture();
  deps.jellyfin.search = async () => [candidate,
    { Name: '沙丘', ProductionYear: 2021, ProviderIds: { Tmdb: 'different' } },
    { Name: '沙丘', ProductionYear: 1984, ProviderIds: { Tmdb: '438631' } }
  ];
  deps.deepseek.chooseCandidate = async () => { throw new Error('incompatible candidates must not reach AI'); };
  const result = await done(workflow, workflow.enqueue({}));
  assert.equal(result.status, 'completed'); assert.equal(result.items[0].confirmed.Name, 'Dune');
  assert.equal(result.items[0].aiDecisionError, undefined);
});

test('shared IMDb does not override conflicting TMDB IDs', async () => {
  const { workflow, deps } = fixture();
  deps.jellyfin.search = async () => [
    { ...candidate, ProviderIds: { Tmdb: '438631', Imdb: 'tt1160419' } },
    { Name: '其他电影', ProductionYear: 2021, ProviderIds: { tmdb: 'other', imdb: 'tt1160419' } }
  ];
  deps.deepseek.chooseCandidate = async () => { throw new Error('known ID conflict must not reach AI'); };
  const result = await done(workflow, workflow.enqueue({}));
  assert.equal(result.items[0].confirmed.Name, 'Dune'); assert.equal(result.items[0].aiDecisionError, undefined);
});

test('already matched Chinese title needs no extra AI request', async () => {
  const { workflow, deps } = fixture();
  deps.deepseek.identify = async () => ({ name: '沙丘', year: 2021 });
  deps.jellyfin.search = async () => [candidate, { ...candidate, Name: '沙丘' }];
  deps.deepseek.chooseCandidate = async () => { throw new Error('Chinese match should not require AI'); };
  const result = await done(workflow, workflow.enqueue({}));
  assert.equal(result.status, 'completed'); assert.equal(result.items[0].confirmed.Name, '沙丘');
  assert.equal(result.items[0].aiDecisionError, undefined);
});

test('Chinese preference in preview does not apply metadata or advance cursor', async () => {
  const { workflow, deps, events } = fixture(); let confirmed = 0;
  deps.jellyfin.search = async () => [candidate, { ...candidate, Name: '沙丘' }];
  deps.mediaLibrary.markIdentified = () => { confirmed++; };
  const result = await done(workflow, workflow.enqueue({ dryRun: true }));
  assert.equal(result.status, 'needs_review'); assert.equal(confirmed, 0); assert.deepEqual(events, ['scan']);
  assert.equal(result.items[0].selectionMethod, 'rules');
  assert.equal(result.items[0].aiDecisionError, undefined);
  workflow.confirm(result.id, 'm', result.items[0].candidates.find(c => c.Name === '沙丘').candidateId);
  assert.equal((await done(workflow, result)).items[0].confirmed.Name, '沙丘');
});
test('AI uncertainty, invalid IDs, year conflicts and upstream errors use the first eligible result', async () => {
  for (const response of ['uncertain', 'forged', 'year-conflict', 'error']) {
    const { workflow, deps, events } = fixture();
    deps.jellyfin.search = async () => [{ ...candidate, Name: '沙丘' }, { ...candidate, Name: '沙丘', ProductionYear: 1984, ProviderIds: { Tmdb: '841' } }];
    deps.deepseek.chooseCandidate = async (source, type, identity, candidates) => {
      if (response === 'error') throw new Error('AI unavailable');
      return { candidateId: response === 'forged' ? 'forged' : candidates[response === 'year-conflict' ? 1 : 0].candidateId, confidence: response === 'uncertain' ? 'low' : 'high', reason: response };
    };
    const result = await done(workflow, workflow.enqueue({}));
    assert.equal(result.status, 'completed'); assert.deepEqual(events, ['scan', 'apply']);
    assert.equal(result.items[0].selectionMethod, 'fallback'); assert.match(result.items[0].selectionWarning, /临时/);
    assert.equal(result.items[0].confirmed.ProviderIds.Tmdb, '438631');
  }
});

test('fallback skips candidates with missing IDs or conflicting years', async () => {
  const { workflow, deps } = fixture();
  deps.jellyfin.search = async () => [
    { Name: '无 ID', ProductionYear: 2021 },
    { ...candidate, Name: '沙丘', ProductionYear: 1984, ProviderIds: { Tmdb: '841' } },
    { ...candidate, Name: '沙丘' },
    { ...candidate, Name: '另一候选', ProviderIds: { Tmdb: 'other' } }
  ];
  deps.deepseek.chooseCandidate = async () => ({ candidateId: null, confidence: 'low', reason: '无法确定' });
  const result = await done(workflow, workflow.enqueue({}));
  assert.equal(result.status, 'completed'); assert.equal(result.items[0].confirmed.ProviderIds.Tmdb, '438631');
  assert.equal(result.items[0].selectionMethod, 'fallback');
});

test('no valid year-compatible candidates still require review', async () => {
  for (const candidates of [[], [{ Name: '无 ID', ProductionYear: 2021 }], [{ ...candidate, ProductionYear: 1984 }]]) {
    const { workflow, deps, events } = fixture(); let confirmed = 0;
    deps.jellyfin.search = async () => candidates;
    deps.deepseek.chooseCandidate = async () => ({ candidateId: null, confidence: 'low', reason: '无匹配年份' });
    deps.mediaLibrary.markIdentified = () => { confirmed++; };
    const result = await done(workflow, workflow.enqueue({}));
    assert.equal(result.status, 'needs_review'); assert.equal(confirmed, 0); assert.deepEqual(events, ['scan']);
  }
});

test('fallback preview remains read-only and manual choice can override the first candidate', async () => {
  const { workflow, deps, events } = fixture(); let confirmed = 0;
  deps.jellyfin.search = async () => [{ ...candidate, Name: '沙丘' }, { ...candidate, Name: '其他标题', ProviderIds: { Tmdb: 'other' } }];
  deps.deepseek.chooseCandidate = async () => ({ candidateId: null, confidence: 'low', reason: '无法确定' });
  deps.mediaLibrary.markIdentified = () => { confirmed++; };
  const preview = await done(workflow, workflow.enqueue({ dryRun: true }));
  assert.equal(preview.status, 'needs_review'); assert.equal(preview.items[0].selectionMethod, 'fallback');
  assert.equal(confirmed, 0); assert.deepEqual(events, ['scan']);
  workflow.confirm(preview.id, 'm', preview.items[0].candidates[1].candidateId);
  const result = await done(workflow, preview);
  assert.equal(result.items[0].confirmed.ProviderIds.Tmdb, 'other'); assert.equal(result.items[0].selectionMethod, 'manual');
  assert.equal(result.items[0].selectionWarning, undefined);
});
test('AI recommendation in preview does not apply metadata or advance the cursor', async () => {
  const { workflow, deps, events } = fixture(); let confirmed = 0;
  deps.jellyfin.search = async () => [{ ...candidate, Name: '沙丘' }];
  deps.mediaLibrary.markIdentified = () => { confirmed++; };
  deps.deepseek.chooseCandidate = async (source, type, identity, candidates) => ({ candidateId: candidates[0].candidateId, confidence: 'high', reason: '对应英文原名' });
  const result = await done(workflow, workflow.enqueue({ dryRun: true }));
  assert.equal(result.status, 'needs_review'); assert.equal(result.items[0].selectionMethod, 'ai');
  assert.equal(confirmed, 0); assert.deepEqual(events, ['scan']);
});
test('media scope locates Series for downloaded season episode and rejects unknown libraries', async () => {
  const jelly = { libraries: async () => [{ ItemId: 's', CollectionType: 'tvshows', Locations: ['/media/series'] }, { ItemId: 'l', CollectionType: 'movies', Locations: ['/media/movies'] }], items: async query => query.ParentId === 's' ? [{ Id: 'series', Type: 'Series', Path: '/media/series/三体', ProviderIds: {} }] : [movie] };
  const lib = new MediaLibraryService({ ...config, pathMapping: { from: '/downloads', to: '/media' } }, jelly);
  const matches = await lib.forTorrent({ save_path: '/downloads/series' }, [{ name: '三体/Season 01/S01E01.mkv' }]);
  assert.equal(matches.items.length, 1); assert.equal(matches.items[0].Id, 'series'); assert.deepEqual(matches.missingPaths, []);
  assert.deepEqual((await lib.unidentified({ libraryId: 's' })).items.map(i => i.Id), ['series']);
  await assert.rejects(lib.unidentified({ libraryId: 'unknown' }), /媒体库/);
});

test('library discovery follows additions and deletions and ignores legacy fixed library IDs', async () => {
  const original = { ItemId: 's', CollectionType: 'tvshows', Locations: ['/media/series'] };
  const addedSeries = { ItemId: 'new-series', CollectionType: 'tvshows', Locations: ['/media/pure-series'] };
  const addedMovie = { ItemId: 'new-movies', CollectionType: 'movies', Locations: ['/media/new-movies'] };
  const unsupported = [{ ItemId: 'music', CollectionType: 'music' }, { ItemId: 'mixed' }];
  let libraries = [original, ...unsupported];
  const queries = [];
  const jellyfin = {
    libraries: async () => libraries,
    items: async query => {
      queries.push(query);
      return [{ Id: query.ParentId, Type: query.IncludeItemTypes, Path: `${libraries.find(l => l.ItemId === query.ParentId).Locations[0]}/media.mkv`, ProviderIds: {} }];
    }
  };
  const service = new MediaLibraryService(config, jellyfin);
  assert.deepEqual((await service.libraries()).map(l => l.ItemId), ['s']);
  libraries = [original, addedSeries, addedMovie, ...unsupported];
  assert.deepEqual((await service.libraries()).map(l => l.ItemId), ['s', 'new-series', 'new-movies']);
  assert.equal((await service.unidentified()).total, 3);
  const matches = await service.forTorrent({ save_path: '/media/pure-series' }, [{ name: 'media.mkv' }]);
  assert.deepEqual(matches.items.map(i => i.Id), ['new-series']); assert.deepEqual(matches.missingPaths, []);
  assert.deepEqual((await service.unidentified({ type: 'Movie' })).items.map(i => i.Id), ['new-movies']);
  libraries = [addedMovie, ...unsupported]; queries.length = 0;
  assert.deepEqual((await service.unidentified()).items.map(i => i.Id), ['new-movies']);
  assert.deepEqual(queries.map(q => q.ParentId), ['new-movies']);
  await assert.rejects(service.unidentified({ libraryId: 'new-series' }), /媒体库/);
  await assert.rejects(service.unidentified({ libraryId: 'music' }), /媒体库/);
});

test('retry resubmits the selected candidate after uncertain application despite existing provider IDs', async () => {
  let applied = false, attempts = 0;
  const { workflow, deps } = fixture();
  deps.mediaLibrary.unidentified = async () => ({ items: applied ? [] : [movie], total: applied ? 0 : 1 });
  deps.jellyfin.apply = async () => { applied = true; if (++attempts === 1) throw new Error('apply response lost despite provider IDs'); };
  const original = workflow.enqueue({ hash: 'c'.repeat(40) }); assert.equal((await done(workflow, original)).status, 'failed');
  const retried = await done(workflow, workflow.retry(original.id));
  assert.equal(attempts, 2); assert.equal(retried.items[0].confirmed.Name, 'Dune'); assert.equal(retried.status, 'completed');
});

test('download callback waits for refresh then identifies library media without torrent path filtering', async () => {
  const { workflow, deps } = fixture();
  let release, listed = false;
  const refreshed = new Promise(resolve => { release = resolve; });
  deps.jellyfin.refreshAndWait = () => refreshed;
  deps.qbittorrent.torrent = async () => ({ progress: 1, save_path: '/unrelated/downloads' });
  deps.qbittorrent.files = async () => { throw new Error('torrent files must not be requested'); };
  deps.mediaLibrary.forTorrent = async () => { throw new Error('torrent paths must not filter library media'); };
  deps.mediaLibrary.unidentified = async () => { listed = true; return { items: [movie], total: 1 }; };
  const job = workflow.enqueue({ hash: 'd'.repeat(40) });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(listed, false); assert.equal(workflow.get(job.id).stage, '扫描媒体库');
  release();
  const result = await done(workflow, job);
  assert.equal(listed, true); assert.equal(result.status, 'completed'); assert.equal(result.items[0].itemId, movie.Id);
});

test('download callback reads every page of unidentified movies and series', async () => {
  const { workflow, deps } = fixture();
  const series = { Id: 'series', Type: 'Series', Path: '/media/series/Dune', Name: 'Dune', ProviderIds: {} };
  const movies = Array.from({ length: 200 }, (_, index) => ({ ...movie, Id: `movie-${index}` }));
  const pages = [], applied = [];
  deps.qbittorrent.files = async () => { throw new Error('torrent files must not be requested'); };
  deps.mediaLibrary.unidentified = async ({ page, pageSize }) => {
    pages.push(page); assert.equal(pageSize, 200);
    return { items: page === 1 ? movies : [series], total: 201 };
  };
  deps.mediaLibrary.ensureItem = async id => id === series.Id ? series : movies.find(item => item.Id === id);
  deps.jellyfin.apply = async id => { applied.push(id); };
  deps.jellyfin.verify = async id => ({ ...(id === series.Id ? series : movie), ...candidate });
  let refreshedSeries;
  deps.jellyfin.refreshItem = async id => { refreshedSeries = id; };
  const result = await done(workflow, workflow.enqueue({ hash: 'f'.repeat(40) }));
  assert.equal(result.status, 'completed'); assert.deepEqual(pages, [1, 2]);
  assert.equal(result.items.length, 201); assert.equal(applied.length, 201); assert.equal(refreshedSeries, series.Id);
});

test('download callback completes with a message when no unidentified media remain', async () => {
  const { workflow, deps, events } = fixture();
  deps.mediaLibrary.unidentified = async () => ({ items: [], total: 0 });
  const result = await done(workflow, workflow.enqueue({ hash: '1'.repeat(40) }));
  assert.equal(result.status, 'completed'); assert.equal(result.items.length, 0);
  assert.equal(result.message, '目标范围内没有未识别媒体'); assert.deepEqual(events, ['scan']);
});

test('incomplete download does not refresh or identify library media', async () => {
  const { workflow, deps, events } = fixture();
  deps.qbittorrent.torrent = async () => ({ progress: 0.5, amount_left: 100 });
  const result = await done(workflow, workflow.enqueue({ hash: '2'.repeat(40) }));
  assert.equal(result.status, 'failed'); assert.match(result.error, /尚未下载完成/); assert.deepEqual(events, []);
});

test('manual scan preserves selected library, media type and item IDs', async () => {
  const { workflow, deps } = fixture();
  const input = { libraryId: 'l', type: 'Movie', itemIds: ['m'], dryRun: true };
  deps.mediaLibrary.unidentified = async query => {
    assert.deepEqual(query, { ...input, page: 1, pageSize: 200 });
    return { items: [movie], total: 1 };
  };
  assert.equal((await done(workflow, workflow.enqueue(input))).status, 'needs_review');
});

test('recovery survives a second retry failing before items are discovered', async () => {
  let applied = false, attempts = 0, scans = 0;
  const { workflow, deps } = fixture();
  deps.mediaLibrary.unidentified = async () => ({ items: applied ? [] : [movie], total: applied ? 0 : 1 });
  deps.jellyfin.refreshAndWait = async () => { if (++scans === 2) throw new Error('scan failed'); };
  deps.jellyfin.apply = async () => { applied = true; if (++attempts === 1) throw new Error('apply response lost'); };
  const first = workflow.enqueue({ hash: 'e'.repeat(40) }); await done(workflow, first);
  const second = workflow.retry(first.id); assert.equal((await done(workflow, second)).status, 'failed');
  const third = await done(workflow, workflow.retry(second.id)); assert.equal(third.status, 'completed'); assert.equal(attempts, 2); assert.equal(third.items[0].confirmed.Name, 'Dune');
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
