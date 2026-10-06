import test from 'node:test';
import assert from 'node:assert/strict';
import { episodeFilename, renamedEpisodePath } from '../src/util/torrent-naming.js';
import { TorrentNamingService } from '../src/service/torrent-naming.js';
import { DeepseekService } from '../src/service/deepseek.js';

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
  const service = new TorrentNamingService({ pollMs: 1, torrentFilesTimeoutMs: 50, requestTimeoutMs: 30 }, qbt, ai, []);
  Object.assign(qbt, overrides);
  const job = { input: { hash: 'a'.repeat(40), event: 'added' }, items: [] };
  return { service, job, qbt, ai, calls: () => calls, setFiles: value => { files = value; } };
}
test('added check renames via qBittorrent and repeated checks are idempotent', async () => {
  const f = fixture(); await f.service.run(f.job, () => {});
  assert.equal(f.calls(), 1); assert.equal(f.job.items[0].newPath, target); assert.equal(f.job.items[0].status, 'completed');
  f.job.items = []; await f.service.run(f.job, () => {}); assert.equal(f.calls(), 1);
});
test('empty magnet file list waits for metadata rather than claiming completion', async () => {
  const f = fixture(); const files = f.qbt.files; let reads = 0;
  f.qbt.files = async () => ++reads < 3 ? [] : files();
  await f.service.run(f.job, () => {}); assert.equal(f.calls(), 1);
  f.qbt.files = async () => []; await assert.rejects(f.service.run(f.job, () => {}), /文件列表.*超时/);
});
test('uncertain AI and target collisions never rename files', async () => {
  const f = fixture(); f.ai.identifySeason = async () => ({ season: null, confidence: 'low', reason: '无法确定' });
  await f.service.run(f.job, () => {}); assert.equal(f.calls(), 0); assert.equal(f.job.items[0].status, 'skipped');
  f.ai.identifySeason = async () => decision;
  f.setFiles([{ index: 0, name: source }, { index: 1, name: target }]); f.job.items = [];
  await f.service.run(f.job, () => {}); assert.equal(f.calls(), 0); assert.equal(f.job.items[0].status, 'failed');
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
