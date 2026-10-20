import test from 'node:test';
import assert from 'node:assert/strict';
import { episodeFilename, renamedEpisodePath } from '../src/util/torrent-naming.js';
import { TorrentNamingService } from '../src/service/torrent-naming.js';
import { DeepseekService } from '../src/service/deepseek.js';
import { WorkflowService } from '../src/service/workflow.js';

const source = 'Journey.to.the.West.II.E01.1998.TVB.WEB-DL.1080p.H264.AAC.2Audio-HDCTV.mkv';
const target = 'Journey.to.the.West.S02E01.1998.TVB.WEB-DL.1080p.H264.AAC.2Audio-HDCTV.mkv';
const decision = { season: 2, removeTitleSuffix: 'II', confidence: 'high', reason: 'II 对应第二季' };
test('detects E/EP episode-only files and preserves parent folder and release suffix', () => {
  const file = episodeFilename(`folder/${source}`);
  assert.equal(file.episode, '01'); assert.equal(file.title, 'Journey.to.the.West.II');
  assert.equal(renamedEpisodePath(file, decision), `folder/${target}`);
  assert.equal(renamedEpisodePath(episodeFilename('Show.EP3.2026.mkv'), { ...decision, season: 1, removeTitleSuffix: null }), 'Show.S01E03.2026.mkv');
  for (const name of ['Show.S02E01.mkv', 'Show.S02EP01.mkv', 'Show.mkv', 'Show.E01.nfo', 'Episode01.mkv', 'E01.mkv']) assert.equal(episodeFilename(name), null);
});
test('AI may not remove arbitrary title text or inject a path into the rename', () => {
  const file = episodeFilename(source);
  for (const suffix of ['West.II', '../II', 'Unknown']) assert.throws(() => renamedEpisodePath(file, { ...decision, removeTitleSuffix: suffix }), /季号标记/);
  assert.throws(() => renamedEpisodePath(episodeFilename('The.Civil.E01.mkv'), { ...decision, removeTitleSuffix: 'Civil' }), /季号标记/);
  assert.throws(() => renamedEpisodePath(episodeFilename('Show.Season03.E01.mkv'), { ...decision, removeTitleSuffix: 'Season03' }), /季号标记/);
  assert.throws(() => renamedEpisodePath(file, { ...decision, season: 3 }), /季号标记/);
  assert.equal(renamedEpisodePath(episodeFilename('Show.第二季.E01.mkv'), { ...decision, removeTitleSuffix: '第二季' }), 'Show.S02E01.mkv');
});
test('season AI returns a validated decision and can decline uncertain seasons', async () => {
  const make = value => new DeepseekService({}, async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
  assert.deepEqual(await make(decision).identifySeason({ torrent: 'Journey to the West II', path: source }), decision);
  assert.equal((await make({ season: null, removeTitleSuffix: null, confidence: 'low', reason: '无法确定' }).identifySeason({ path: source })).season, null);
  for (const value of [{ ...decision, season: 0 }, { ...decision, season: 100 }, { ...decision, season: '2' }, { ...decision, confidence: 'maybe' }]) await assert.rejects(make(value).identifySeason({ path: source }), /季号/);
});
function fixture(overrides = {}) {
  let files = [{ index: 0, name: source }, { index: 1, name: 'Show.S01E02.mkv' }], calls = 0;
  const qbt = { torrent: async () => ({ name: 'Journey to the West II', category: 'series' }), files: async () => structuredClone(files), renameFile: async (hash, oldPath, newPath) => { calls++; files.find(f => f.name === oldPath).name = newPath; } };
  const ai = { identifySeason: async () => decision };
  const service = new TorrentNamingService({ seriesCategories: ['series', 'pure-series', 'super-series'], pollMs: 1, torrentFilesTimeoutMs: 50, requestTimeoutMs: 30 }, qbt, ai, []);
  Object.assign(qbt, overrides);
  const job = { input: { hash: 'a'.repeat(40), event: 'added' }, items: [] };
  return { service, job, qbt, ai, calls: () => calls, setFiles: value => { files = value; } };
}
test('added check renames via qBittorrent and repeated checks are idempotent', async () => {
  const f = fixture(); await f.service.run(f.job, () => {});
  assert.equal(f.calls(), 1); assert.equal(f.job.items[0].newPath, target); assert.equal(f.job.items[0].status, 'completed');
  f.job.items = []; await f.service.run(f.job, () => {}); assert.equal(f.calls(), 1);
});

test('rename intent is committed before the remote call and completed after readback', async () => {
  const f = fixture(), saved = [];
  const rename = f.qbt.renameFile;
  f.qbt.renameFile = async (...args) => {
    assert.equal(saved.at(-1).items[0].phase, 'prepared');
    assert.equal(saved.at(-1).items[0].intent.expected.newPath, target);
    await rename(...args); throw Error('response lost');
  };
  await f.service.run(f.job, () => {}, job => saved.push(structuredClone(job)));
  assert.equal(f.calls(), 1); assert.equal(saved.at(-1).items[0].phase, 'completed');
  assert.equal(saved.at(-1).items[0].status, 'completed');
});

test('retry skips previously completed file indexes even if an external actor reverted their names', async () => {
  const f = fixture();
  f.setFiles([{ index: 0, name: source }, { index: 1, name: 'Show.E02.mkv' }]);
  f.ai.identifySeason = async () => ({ season: 1, removeTitleSuffix: null, confidence: 'high', reason: 'season one' });
  const wf = new WorkflowService(f.service.config, { torrentNaming: f.service, qbittorrent: f.qbt });
  const repo = wf.repository;
  const parent = repo.accept({ input: f.job.input, sourceScope: wf.scope }), action = repo.claimNext();
  parent.status = 'failed'; parent.items = [
    { itemId: `${f.job.input.hash}:0`, type: 'File', status: 'completed' },
    { itemId: `${f.job.input.hash}:1`, type: 'File', status: 'failed', torrentHash: f.job.input.hash, path: 'Show.E02.mkv' }
  ];
  repo.save(parent, { actionId: action.id, actionStatus: 'failed' });
  const retry = wf.retry(parent.id); await wf.close();
  assert.equal(wf.get(retry.id).status, 'completed');
  assert.equal((await f.qbt.files()).find(i => i.index === 0).name, source);
  assert.equal((await f.qbt.files()).find(i => i.index === 1).name, 'Show.S01E02.mkv');
  wf.repository.database.close();
});

test('interrupted file without an intent can retry its season decision and rename', async () => {
  const f = fixture(), wf = new WorkflowService(f.service.config, { torrentNaming: f.service, qbittorrent: f.qbt });
  const repo = wf.repository, parent = repo.accept({ input: f.job.input, sourceScope: wf.scope }), action = repo.claimNext();
  parent.status = 'failed'; parent.items = [{ itemId: `${f.job.input.hash}:0`, type: 'File', path: source, status: 'failed', recoveryState: 'interrupted' }];
  repo.save(parent, { actionId: action.id, actionStatus: 'failed' });
  const retry = wf.retry(parent.id); await wf.close();
  assert.equal(wf.get(retry.id).status, 'completed'); assert.equal((await f.qbt.files())[0].name, target);
  repo.database.close();
});

test('successful batch preflight retires a prior torrent-level failure', async () => {
  const f = fixture(), files = f.qbt.files;
  f.job.input.checkExisting = true;
  f.qbt.torrents = async () => [{ hash: f.job.input.hash, name: 'Show', category: 'series' }];
  f.qbt.files = async () => { throw Error('temporary read error'); };
  await f.service.run(f.job, () => {}); assert.equal(f.job.items[0].status, 'failed');
  f.qbt.files = files; await f.service.run(f.job, () => {});
  assert.equal(f.job.items.some(i => i.status === 'failed'), false);
  assert.equal(f.job.items.some(i => i.itemId.endsWith(':torrent')), false);
});
test('configured series categories use exact case-insensitive names for checks and rename revalidation', async () => {
  const f = fixture({ torrent: async () => ({ name: 'Show', category: 'TV' }) });
  f.service.config.seriesCategories = ['tv', '电视剧'];
  await f.service.run(f.job, () => {}); assert.equal(f.calls(), 1);
  const excluded = fixture(); excluded.service.config.seriesCategories = ['电视剧'];
  await excluded.service.run(excluded.job, () => {}); assert.equal(excluded.calls(), 0);
  const substring = fixture({ torrent: async () => ({ category: 'not-series' }) });
  await substring.service.run(substring.job, () => {}); assert.equal(substring.calls(), 0);
  const empty = fixture(); empty.service.config.seriesCategories = [];
  await empty.service.run(empty.job, () => {}); assert.equal(empty.calls(), 0);
  let reads = 0;
  const changed = fixture({ torrent: async () => ({ category: ++reads === 1 ? 'TV' : 'series' }) });
  changed.service.config.seriesCategories = ['TV'];
  await changed.service.run(changed.job, () => {}); assert.equal(changed.calls(), 0); assert.equal(changed.job.items[0].status, 'skipped');
});
test('empty magnet file list waits for metadata rather than claiming completion', async () => {
  const f = fixture(); const files = f.qbt.files; let reads = 0;
  f.qbt.files = async () => ++reads < 3 ? [] : files();
  await f.service.run(f.job, () => {}); assert.equal(f.calls(), 1);
  f.qbt.files = async () => []; await assert.rejects(f.service.run(f.job, () => {}), /文件列表.*超时/);
});
test('uncertain AI defaults to S01 without removing any title suffix', async () => {
  for (const season of [null, 2]) {
    const f = fixture();
    const uncertain = { season, removeTitleSuffix: 'II', confidence: 'low', reason: '无法确定' };
    f.ai.identifySeason = async () => uncertain;
    await f.service.run(f.job, () => {});
    assert.equal(f.calls(), 1);
    assert.equal(f.job.items[0].status, 'completed');
    assert.equal(f.job.items[0].newPath, 'Journey.to.the.West.II.S01E01.1998.TVB.WEB-DL.1080p.H264.AAC.2Audio-HDCTV.mkv');
    assert.deepEqual(f.job.items[0].seasonDecision, uncertain);
    assert.match(f.job.items[0].message, /默认.*S01/);
    f.job.items = []; await f.service.run(f.job, () => {}); assert.equal(f.calls(), 1);
  }
});
test('target collisions prevent renaming even with the default season', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture();
    const newName = uncertain ? 'Journey.to.the.West.II.S01E01.1998.TVB.WEB-DL.1080p.H264.AAC.2Audio-HDCTV.mkv' : target;
    if (uncertain) f.ai.identifySeason = async () => ({ season: null, removeTitleSuffix: null, confidence: 'low', reason: '无法确定' });
    f.setFiles([{ index: 0, name: source }, { index: 1, name: newName }]);
    await f.service.run(f.job, () => {});
    assert.equal(f.calls(), 0); assert.equal(f.job.items[0].status, 'failed');
    assert.match(f.job.items[0].error, /目标文件名已存在/);
  }
});
test('lost rename response is confirmed from current file list, without a second write', async () => {
  const f = fixture(); const rename = f.qbt.renameFile;
  f.qbt.renameFile = async (...args) => { await rename(...args); throw new Error('response lost'); };
  await f.service.run(f.job, () => {}); assert.equal(f.calls(), 1); assert.equal(f.job.items[0].status, 'completed');
});
test('unconfirmed rename and upstream AI errors are reported as failures', async () => {
  const f = fixture({ renameFile: async () => {} }); await f.service.run(f.job, () => {});
  assert.equal(f.job.items[0].status, 'failed');
  f.ai.identifySeason = async () => { throw new Error('AI unavailable'); }; f.job.items = [];
  await f.service.run(f.job, () => {}); assert.equal(f.job.items[0].status, 'failed');
});
test('different filename years never share a season decision', async () => {
  const f = fixture(); const paths = ['Show.E01.2020.mkv', 'Show.E01.2021.mkv']; let calls = 0;
  f.setFiles(paths.map((name, index) => ({ name, index })));
  f.ai.identifySeason = async input => { calls++; return { ...decision, season: input.path.includes('2020') ? 1 : 2, removeTitleSuffix: null }; };
  await f.service.run(f.job, () => {});
  assert.equal(calls, 2); assert.equal(f.job.items[0].newPath, 'Show.S01E01.2020.mkv'); assert.equal(f.job.items[1].newPath, 'Show.S02E01.2021.mkv');
});

test('only categories containing series are checked, ignoring case', async () => {
  for (const category of ['', undefined, 'movies', 'tv', 'series', 'pure-series', 'SUPER-SERIES']) {
    const f = fixture(); f.qbt.torrent = async () => ({ name: 'Show', category });
    let reads = 0; const files = f.qbt.files; f.qbt.files = async () => { reads++; return files(); };
    await f.service.run(f.job, () => {});
    assert.equal(f.calls(), /series/i.test(category ?? '') ? 1 : 0);
    if (!/series/i.test(category ?? '')) { assert.equal(reads, 0); assert.match(f.job.message, /分类/); }
  }
});

test('existing torrent batch filters categories and continues after a failed torrent', async () => {
  const f = fixture(); const seen = [];
  f.job.input = { event: 'added', checkExisting: true };
  f.qbt.torrents = async () => [{ hash: 'bad', category: 'series' }, { hash: 'movie', category: 'movies' }, { hash: 'good', category: 'pure-series' }];
  f.qbt.torrent = async hash => { seen.push(hash); if (hash === 'bad') throw new Error('missing torrent'); return { name: 'Journey', category: 'pure-series' }; };
  await f.service.run(f.job, () => {});
  assert.deepEqual(seen, ['bad', 'good', 'good']);
  assert.equal(f.job.items[0].status, 'failed'); assert.equal(f.job.items[1].status, 'completed'); assert.equal(f.calls(), 1);
});

test('category change before rename prevents writes', async () => {
  const f = fixture(); let checks = 0;
  f.qbt.torrent = async () => ({ name: 'Show', category: ++checks === 1 ? 'series' : 'movies' });
  await f.service.run(f.job, () => {});
  assert.equal(f.calls(), 0); assert.equal(f.job.items[0].status, 'skipped');
});

test('known numbered subtitle uses the inferred season while preserving the subtitle', async () => {
  const f = fixture();
  const name = 'Initial.D.Fifth.Stage.EP13.2012.1080p.BluRay.DTS.x265-10bit-HDS.mkv';
  f.setFiles([{ index: 0, name: 'folder/' + name }]);
  f.ai.identifySeason = async () => ({ season: 5, removeTitleSuffix: null, confidence: 'high', reason: 'Fifth Stage 对应第五季' });
  await f.service.run(f.job, () => {});
  assert.equal(f.calls(), 1);
  assert.equal(f.job.items[0].newPath, 'folder/Initial.D.Fifth.Stage.S05E13.2012.1080p.BluRay.DTS.x265-10bit-HDS.mkv');
  assert.equal(f.job.items[0].status, 'completed');
});
