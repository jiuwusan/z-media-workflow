import test from 'node:test';
import assert from 'node:assert/strict';
import { JellyfinService } from '../src/service/jellyfin.js';
import { DeepseekService } from '../src/service/deepseek.js';
import { QbittorrentService } from '../src/service/qbittorrent.js';

const task = (state, end, status = 'Completed') => ({ Id: 'scan', Key: 'RefreshLibrary', State: state, LastExecutionResult: end ? { EndTimeUtc: end, Status: status } : null });
test('completion notification exposes only its settings and updates only native completion fields', async () => {
  const prefs = { autorun_enabled: false, autorun_program: '', mail_notification_password: 'private', autorun_on_torrent_added_enabled: true, save_path: '/media' };
  const qbt = new QbittorrentService({}, async (path, options) => {
    if (path === 'app/preferences') return prefs;
    assert.equal(path, 'app/setPreferences'); assert.equal(options.method, 'POST');
    const update = JSON.parse(options.form.json);
    assert.deepEqual(Object.keys(update).sort(), ['autorun_enabled', 'autorun_program']);
    Object.assign(prefs, update);
  });
  assert.deepEqual(await qbt.completionNotification(), { enabled: false, program: '' });
  assert.deepEqual(await qbt.setCompletionNotification({ enabled: true, program: 'node /opt/notify.mjs "%I"' }), { enabled: true, program: 'node /opt/notify.mjs "%I"' });
  assert.equal(prefs.autorun_on_torrent_added_enabled, true); assert.equal(prefs.save_path, '/media');
});

test('completion notification reports upstream readback mismatch instead of claiming saved', async () => {
  const qbt = new QbittorrentService({}, async path => path === 'app/preferences' ? { autorun_enabled: false, autorun_program: '' } : undefined);
  await assert.rejects(qbt.setCompletionNotification({ enabled: true, program: 'node /opt/notify.mjs "%I"' }), /回读不一致/);
});

test('refresh waits through an existing scan and requires new execution after POST', async () => {
  let reads = 0, posts = 0;
  const states = [task('Running', 'old'), task('Idle', 'old'), task('Idle', 'old'), task('Idle', 'new')];
  const jelly = new JellyfinService({ pollMs: 1, scanTimeoutMs: 1000 }, async (path, options) => {
    if (path === 'Library/Refresh') { assert.equal(options.method, 'POST'); posts++; return; }
    assert.equal(path, 'ScheduledTasks'); return [states[Math.min(reads++, 3)]];
  });
  await jelly.refreshAndWait(); assert.equal(posts, 1); assert.equal(reads, 4);
});
test('refresh fails on failed execution and times out when never starts', async () => {
  let reads = 0;
  const jelly = new JellyfinService({ pollMs: 1, scanTimeoutMs: 50 }, async path => path === 'Library/Refresh' ? undefined : [task('Idle', reads++ ? 'new' : 'old', reads > 1 ? 'Failed' : 'Completed')]);
  await assert.rejects(jelly.refreshAndWait(), /扫描失败/);
  const idle = new JellyfinService({ pollMs: 1, scanTimeoutMs: 10 }, async path => path === 'Library/Refresh' ? undefined : [task('Idle', 'old')]);
  await assert.rejects(idle.refreshAndWait(), /超时/);
});
test('Jellyfin paginates all results and verifies provider IDs after apply', async () => {
  const jelly = new JellyfinService({ pollMs: 1, verifyTimeoutMs: 10 }, async (path, options) => {
    if (path === 'Items' && options.query.Ids) return { Items: [{ Name: 'Dune', ProductionYear: 2021, ProviderIds: { Tmdb: 'wrong' } }], TotalRecordCount: 1 };
    if (path === 'Items') return { Items: [{ Id: String(options.query.StartIndex) }], TotalRecordCount: 2 };
    return { Name: 'Dune', ProductionYear: 2021, ProviderIds: { Tmdb: 'wrong' } };
  });
  assert.deepEqual(await jelly.items({ ParentId: 'lib', pageSize: 1 }), [{ Id: '0' }, { Id: '1' }]);
  await assert.rejects(jelly.verify('id', { Name: 'Dune', ProductionYear: 2021, ProviderIds: { Tmdb: '2' } }), /确认超时/);
});
test('DeepSeek validates JSON including truncated outputs', async () => {
  const ds = new DeepseekService({ deepseekModel: 'model' }, async (path, options) => {
    assert.equal(options.json.response_format.type, 'json_object');
    assert.equal(options.json.thinking?.type, 'disabled');
    return { choices: [{ finish_reason: 'stop', message: { content: '{"name":"三体","year":2023}' } }] };
  });
  assert.deepEqual(await ds.identify('三体.1080p', 'Series'), { name: '三体', year: 2023 });
  const truncated = new DeepseekService({}, async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }));
  await assert.rejects(truncated.identify('x', 'Movie'));
});
test('RSS native rule uses form ruleDef, preserving regex', async () => {
  const qbt = new QbittorrentService({}, async (path, options) => {
    if (path === 'rss/rules') return {};
    assert.equal(path, 'rss/setRule'); assert.equal(options.method, 'POST');
    assert.equal(options.form.ruleName, '三体'); assert.equal(JSON.parse(options.form.ruleDef).mustContain, '三体.*1080p');
  });
  await qbt.setRule('三体', { enabled: true, useRegex: true, mustContain: '三体.*1080p', affectedFeeds: ['https://example.com/rss'] });
});

test('updating RSS rule preserves native history and advanced torrent parameters', async () => {
  const existing = { enabled: true, addPaused: null, lastMatch: '2026-09-01', previouslyMatchedEpisodes: ['1x1'], priority: 5, torrentParams: { content_layout: 'Subfolder' }, mustContain: 'old' };
  const qbt = new QbittorrentService({}, async (path, options) => {
    if (path === 'rss/rules') return { rule: existing };
    const rule = JSON.parse(options.form.ruleDef);
    assert.deepEqual(rule.previouslyMatchedEpisodes, ['1x1']); assert.equal(rule.lastMatch, '2026-09-01'); assert.equal(rule.addPaused, null); assert.equal(rule.priority, 5); assert.equal(rule.torrentParams.content_layout, 'Subfolder'); assert.equal(rule.mustContain, 'new');
  });
  await qbt.setRule('rule', { mustContain: 'new' });
});

test('RSS settings patch also updates native torrentParams precedence fields', async () => {
  const qbt = new QbittorrentService({}, async (path, options) => {
    if (path === 'rss/rules') return { rule: { torrentParams: { save_path: '/old', category: 'old', stopped: null, use_auto_tmm: true, content_layout: 'Subfolder' } } };
    const rule = JSON.parse(options.form.ruleDef);
    assert.deepEqual(rule.torrentParams, { save_path: '/new', category: 'movies', stopped: false, use_auto_tmm: false, content_layout: 'Subfolder' });
  });
  await qbt.setRule('rule', { savePath: '/new', assignedCategory: 'movies', addPaused: false });
});

test('API-key-only item readback uses global Items query instead of user-dependent route', async () => {
  const jelly = new JellyfinService({}, async (path, options) => {
    assert.equal(path, 'Items'); assert.equal(options.query.Ids, 'movie-id');
    return { Items: [{ Id: 'movie-id', Name: 'Dune', ProviderIds: { Tmdb: '438631' } }], TotalRecordCount: 1 };
  });
  assert.equal((await jelly.item('movie-id')).ProviderIds.Tmdb, '438631');
});

test('Series candidates derive missing ProductionYear from PremiereDate', async () => {
  const jelly = new JellyfinService({}, async () => [
    { Name: '与晋长安', PremiereDate: '2025-08-23T16:00:00.0000000Z', ProviderIds: { Tmdb: '253093' } },
    { Name: '与晋长安', PremiereDate: '2026-02-07T16:00:00.0000000Z', ProviderIds: { Tmdb: '336490' } },
    { Name: '无年份', PremiereDate: '0001-01-01T00:00:00Z', ProviderIds: { Tmdb: 'unknown' } }
  ]);
  const candidates = await jelly.search({ Id: 'series', Type: 'Series' }, { name: '与晋长安', year: 2025 });
  assert.equal(candidates[0].ProductionYear, 2025); assert.equal(candidates[1].ProductionYear, 2026); assert.equal(candidates[2].ProductionYear, undefined);
});

test('Series readback verifies missing ProductionYear against PremiereDate', async () => {
  const item = { Id: 'series', Type: 'Series', Name: '余红旧事', PremiereDate: '2026-09-28T16:00:00Z', ProviderIds: { Tmdb: '301494' } };
  const jelly = new JellyfinService({ pollMs: 1, verifyTimeoutMs: 20 }, async () => ({ Items: [item] }));
  const confirmed = await jelly.verify('series', { Name: '余红旧事', ProductionYear: 2026, ProviderIds: { Tmdb: '301494' } });
  assert.equal(confirmed.ProductionYear, 2026);
  assert.equal(item.ProductionYear, undefined, 'readback normalization does not mutate upstream data');
});

test('Series date fallback rejects year conflicts, absent dates and mismatched identity', async () => {
  const candidate = { Name: '余红旧事', ProductionYear: 2026, ProviderIds: { Tmdb: '301494' } };
  const base = { Type: 'Series', Name: candidate.Name, PremiereDate: '2026-09-28T16:00:00Z', ProviderIds: candidate.ProviderIds };
  for (const overrides of [
    { ProductionYear: 2025 },
    { PremiereDate: '2025-09-28T16:00:00Z' },
    { PremiereDate: undefined },
    { PremiereDate: 'invalid-date' },
    { PremiereDate: '0001-01-01T00:00:00Z' },
    { ProviderIds: { Tmdb: 'wrong' } },
    { Name: '其他剧集' },
    { Type: 'Movie' }
  ]) {
    const jelly = new JellyfinService({ pollMs: 1, verifyTimeoutMs: 10 }, async () => ({ Items: [{ ...base, ...overrides }] }));
    await assert.rejects(jelly.verify('series', candidate), /确认超时/);
  }
});
