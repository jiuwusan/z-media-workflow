import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config/index.js';
import { createServices } from '../src/service/index.js';
import { createApp } from '../src/app.js';
import { CleanupSettingsStore } from '../src/util/cleanup-settings.js';
test('panel login, RSS rules, preview, manual confirmation, responsive navigation and logout', { timeout: 90000 }, async t => {
  const libId = '1'.repeat(32), itemId = '2'.repeat(32), changes = [], errors = [];
  const libraryList = [{ Name: 'movie', ItemId: libId, CollectionType: 'movies', Locations: ['/media/movies'] }];
  let scan = 0, readbacks = 0, applied = null, rules = {}, notification = { autorun_enabled: false, autorun_program: '', autorun_on_torrent_added_enabled: false, autorun_on_torrent_added_program: '' };
  let torrentFilename = 'Journey.to.the.West.II.E01.1998.TVB.WEB-DL.1080p.H264.AAC.2Audio-HDCTV.mkv';
  const cleanupCalls = [];
  let missingSeed = { hash: 'b'.repeat(40), name: 'Missing movie', category: 'movies', state: 'missingFiles' };
  // Simulate metadata that remains unchanged after Jellyfin accepts the chosen candidate.
  const item = () => ({ Id: itemId, Type: 'Movie', DateCreated: '2026-10-05T00:00:00Z', Name: 'Dune.2021.1080p', Path: '/media/movies/Dune.2021.1080p.mkv', ProviderIds: { Tmdb: 'wrong-self-identification' }, LockData: false, LockedFields: [], Tags: [], Genres: [] });
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const d of req) raw += d;
    const url = new URL(req.url, 'http://mock'), route = url.pathname;
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (route === '/qbt/api/v2/app/version') { res.end('v5.2.3'); return; }
    if (route === '/qbt/api/v2/app/preferences') return json({ ...notification, mail_notification_password: 'secret-mail' });
    if (route === '/qbt/api/v2/app/setPreferences') { const update = JSON.parse(new URLSearchParams(raw).get('json')); const added = Object.hasOwn(update, 'autorun_on_torrent_added_enabled'); assert.deepEqual(Object.keys(update).sort(), added ? ['autorun_on_torrent_added_enabled', 'autorun_on_torrent_added_program'] : ['autorun_enabled', 'autorun_program']); Object.assign(notification, update); changes.push(added ? 'added-notification' : 'notification'); res.end(''); return; }
    if (route === '/qbt/api/v2/torrents/info') {
      const torrents = [{ hash: 'a'.repeat(40), name: 'Journey to the West II', category: 'series', state: 'downloading', progress: 0.1 }, ...(missingSeed ? [missingSeed] : [])];
      return json(url.searchParams.has('hashes') ? torrents.filter(t => t.hash === url.searchParams.get('hashes')) : torrents);
    }
    if (route === '/qbt/api/v2/torrents/delete') { const fields = new URLSearchParams(raw); assert.equal(fields.get('hashes'), missingSeed.hash); cleanupCalls.push(fields.get('deleteFiles')); missingSeed = null; res.end(''); return; }
    if (route === '/qbt/api/v2/torrents/files') return json([{ index: 0, name: torrentFilename }]);
    if (route === '/qbt/api/v2/torrents/renameFile') { const form = new URLSearchParams(raw); assert.equal(form.get('oldPath'), torrentFilename); torrentFilename = form.get('newPath'); changes.push('rename'); res.end(''); return; }
    if (route === '/qbt/api/v2/rss/items') return json({ 剧集: { 测试订阅: { url: 'https://example.com/rss', articles: [{ title: 'Dune 2021', date: '2026-10-02T12:00:00Z', link: 'https://example.com/article' }] } } });
    if (route === '/qbt/api/v2/rss/rules') return json(rules);
    if (route === '/qbt/api/v2/torrents/categories') return json({ movies: { name: 'movies', savePath: '/media/movies' }, series: { name: 'series', savePath: '/media/series' } });
    if (route === '/qbt/api/v2/rss/removeRule') { delete rules[new URLSearchParams(raw).get('ruleName')]; changes.push('remove-rule'); res.end(''); return; }
    if (route === '/qbt/api/v2/rss/setRule') { const form = new URLSearchParams(raw); rules[form.get('ruleName')] = JSON.parse(form.get('ruleDef')); changes.push('rule'); res.end(''); return; }
    if (route === '/jelly/Library/VirtualFolders') return json(libraryList);
    if (route === '/jelly/System/Info') return json({ Version: '10.11.11' });
    if (route === '/jelly/ScheduledTasks') return json([{ Id: 'scan-task', Key: 'RefreshLibrary', State: 'Idle', LastExecutionResult: { EndTimeUtc: `end-${scan}`, Status: 'Completed' } }]);
    if (route === '/jelly/Library/Refresh') { scan++; res.end(''); return; }
    if (route === '/jelly/Items') { if (url.searchParams.has('Ids') && applied) readbacks++; return json(url.searchParams.get('ParentId') === '3'.repeat(32) ? { Items: [], TotalRecordCount: 0 } : { Items: [item()], TotalRecordCount: 1 }); }
    if (route === '/jelly/Items/RemoteSearch/Movie') return json([{ Name: 'Dune', ProductionYear: 2021, ProviderIds: { Tmdb: '438631' } }, { Name: 'Dune', ProductionYear: 1984, ProviderIds: { Tmdb: '841' } }]);
    if (route === `/jelly/Items/${itemId}` && req.method === 'POST') { applied = JSON.parse(raw); changes.push('apply'); res.end(''); return; }
    if (route === `/jelly/Items/${itemId}/Refresh`) { res.end(''); return; }
    if (route === '/deep/models') return json({ data: [{ id: 'deepseek-flash' }] });
    if (route === '/deep/chat/completions') {
      const input = JSON.parse(raw), content = input.messages[1].content;
      const data = content.startsWith('{') ? JSON.parse(content) : null;
      const result = data?.path ? { season: 2, removeTitleSuffix: 'II', confidence: 'high', reason: '1998年第二部' } : data?.candidates ? { candidateId: data.candidates.find(c => c.ProductionYear === 2021).candidateId, confidence: 'high', reason: '原始文件名明确标注2021年，可区分1984年版本' } : { name: 'Dune', year: null };
      return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] });
    }
    res.statusCode = 404; res.end('missing');
  }).listen(0, '127.0.0.1');
  await new Promise(r => upstream.once('listening', r)); t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const config = loadConfig({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'browser-test-password-123456', WEBHOOK_AUTH_ENABLED: 'false', QBT_URL: `${base}/qbt/`, QBT_API_KEY: 'mock-qbt', JELLYFIN_URL: `${base}/jelly/`, JELLYFIN_API_KEY: 'mock-jelly', DEEPSEEK_URL: `${base}/deep/`, DEEPSEEK_API_KEY: 'mock-deep', POLL_INTERVAL_MS: '5', SCAN_TIMEOUT_MS: '1000', VERIFY_TIMEOUT_MS: '1000', JELLYFIN_MOVIE_LIBRARY_ID: libId });
  const cursorDir = await mkdtemp(path.join(tmpdir(), 'workflow-ui-'));
  config.mediaCursorFile = path.join(cursorDir, 'cursors.json');
  config.cleanupSettingsFile = path.join(cursorDir, 'cleanup.json');
  t.after(() => rm(cursorDir, { recursive: true, force: true }));
  const services = createServices(config), server = createApp({ config, services }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r)); t.after(() => server.close()); config.publicUrl = `http://127.0.0.1:${server.address().port}/`;
  let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (!executablePath && process.platform === 'win32') { const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'; try { await access(edge); executablePath = edge; } catch {} }
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(config.publicUrl); await page.getByRole('textbox', { name: '用户名', exact: true }).fill(config.adminUsername); await page.getByRole('textbox', { name: '密码', exact: true }).fill(config.adminPassword);
  await page.getByRole('button', { name: '进入管理面板' }).click(); await page.getByRole('heading', { name: '工作流概览', exact: true }).waitFor();
  await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText('在线', { exact: true }).first().waitFor();
  await mkdir('.test-artifacts', { recursive: true }); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: '.test-artifacts/dashboard-desktop.png', fullPage: true });
  await page.getByRole('link', { name: 'RSS 订阅', exact: true }).click(); await page.getByText('Dune 2021', { exact: true }).waitFor();
  await page.getByRole('button', { name: '新建规则' }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('规则名称').fill('电影规则'); await dialog.getByLabel('包含条件').fill('Dune.*1080p');
  assert.equal(await dialog.getByLabel('保存目录（qBittorrent 服务器路径）').count(), 0);
  assert.equal(await dialog.getByLabel('剧集筛选').count(), 0);
  await dialog.getByRole('checkbox', { name: '使用正则表达式', exact: true }).locator('..').click();
  await dialog.getByLabel('排除条件').fill('(Pure|HDR)');
  await dialog.getByLabel('指定分类').click(); await page.getByRole('option', { name: 'movies', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '剧集\\测试订阅', exact: true }).locator('..').click();
  await dialog.getByRole('button', { name: '保存规则' }).click(); await page.getByText('电影规则', { exact: true }).waitFor();
  assert.deepEqual(rules['电影规则'], { enabled: true, useRegex: true, mustContain: 'Dune.*1080p', mustNotContain: '(Pure|HDR)', assignedCategory: 'movies', affectedFeeds: ['https://example.com/rss'] });
  Object.assign(rules['电影规则'], { ignoreDays: 7, smartFilter: true, lastMatch: 'old-match', torrentParams: { category: 'series', save_path: '/custom', content_layout: 'Subfolder', stopped: true } });
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/qbittorrent/rss/rules')), page.getByRole('button', { name: '重新读取', exact: true }).click()]);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await dialog.waitFor(); await dialog.locator('.el-select__selected-item').getByText('series', { exact: true }).waitFor();
  await dialog.getByLabel('包含条件').fill('Dune.*2160p');
  await dialog.getByRole('button', { name: '保存规则' }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(rules['电影规则'].mustContain, 'Dune.*2160p');
  assert.equal(rules['电影规则'].ignoreDays, 7); assert.equal(rules['电影规则'].smartFilter, true); assert.equal(rules['电影规则'].lastMatch, 'old-match');
  assert.deepEqual(rules['电影规则'].torrentParams, { category: 'series', save_path: '/custom', content_layout: 'Subfolder', stopped: true });
  await page.getByRole('button', { name: '停用', exact: true }).click();
  await page.getByRole('button', { name: '启用', exact: true }).waitFor(); assert.equal(rules['电影规则'].enabled, false);
  await page.getByRole('button', { name: '删除', exact: true }).click(); await page.getByRole('button', { name: '删除', exact: true }).last().click();
  await page.getByText('下载规则已删除', { exact: true }).waitFor(); assert.deepEqual(rules, {});
  await page.getByRole('link', { name: '媒体识别', exact: true }).click(); await page.getByText('Dune.2021.1080p', { exact: true }).waitFor();
  libraryList.push({ Name: 'pure', ItemId: '3'.repeat(32), CollectionType: 'tvshows', Locations: ['/media/pure'] });
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await page.getByRole('combobox', { name: '目标媒体库' }).locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]').click(); await page.getByRole('option', { name: 'pure', exact: true }).click();
  await page.getByText('当前没有未识别媒体。新下载入库后可再次检查。', { exact: true }).waitFor();
  libraryList.pop(); await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await page.getByText('Dune.2021.1080p', { exact: true }).waitFor();
  assert.equal(await page.locator('.el-select__selected-item').getByText('全部目标库', { exact: true }).count(), 1);
  await page.getByRole('button', { name: '预览候选', exact: true }).click(); await page.getByRole('button', { name: '确认此候选' }).first().waitFor();
  await page.getByText('AI 推荐', { exact: true }).waitFor(); await page.getByText('原始文件名明确标注2021年，可区分1984年版本', { exact: false }).waitFor();
  assert.equal(applied, null); await page.getByRole('textbox', { name: '搜索媒体名称' }).fill('Dune');
  await page.getByRole('button', { name: '重新搜索' }).click(); await page.getByRole('button', { name: '确认此候选' }).first().waitFor();
  await page.getByRole('button', { name: '确认此候选' }).first().click(); await page.getByRole('button', { name: '确认并应用', exact: true }).click();
  await page.getByText('已确认：Dune', { exact: false }).waitFor(); assert.equal(applied.ProviderIds.Tmdb, '438631');
  assert.equal(readbacks, 0, 'metadata readback is not required to complete identification');
  await page.getByRole('link', { name: '媒体识别', exact: true }).click();
  await page.getByText('当前没有未识别媒体。新下载入库后可再次检查。', { exact: true }).waitFor();
  await page.getByRole('link', { name: '连接与通知', exact: true }).click(); await page.getByRole('heading', { name: '下载完成通知' }).waitFor();
  await page.getByRole('button', { name: '生成通知命令', exact: true }).click();
  const completionCommand = await page.getByRole('textbox', { name: '完成通知命令', exact: true }).inputValue();
  assert.match(completionCommand, /^curl -q --fail/);
  assert.ok(completionCommand.includes(`--data-urlencode "hash=%I" "${config.publicUrl}api/webhooks/qbittorrent/completed"`));
  assert.equal(completionCommand.includes('--config'), false);
  assert.equal(await page.getByRole('textbox', { name: '通知文件路径' }).count(), 0);
  assert.equal(notification.autorun_enabled, false, 'template generation does not save automatically');
  await page.getByRole('switch', { name: '启用下载完成通知' }).locator('..').click();
  await page.getByRole('button', { name: '保存通知配置', exact: true }).click();
  await page.getByText('已保存到 qBittorrent，并回读确认', { exact: true }).waitFor();
  assert.equal(notification.autorun_enabled, true);
  await page.getByRole('button', { name: '读取 qBittorrent 配置', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="启用下载完成通知"]').getAttribute('aria-checked') === 'true');
  await page.getByRole('button', { name: '生成新增通知命令', exact: true }).click();
  const addedCommand = await page.getByRole('textbox', { name: '新增种子通知命令', exact: true }).inputValue();
  assert.ok(addedCommand.includes(`${config.publicUrl}api/webhooks/qbittorrent/added`)); assert.equal(addedCommand.includes('--config'), false);
  await page.getByRole('switch', { name: '启用新增种子通知', exact: true }).locator('..').click();
  await page.getByRole('button', { name: '保存新增通知配置', exact: true }).click();
  await page.getByText('新增种子通知已保存，并回读确认', { exact: true }).waitFor();
  assert.equal(notification.autorun_on_torrent_added_enabled, true); assert.equal(notification.autorun_enabled, true);
  const previousScans = scan;
  const addedResponse = await fetch(`${config.publicUrl}api/webhooks/qbittorrent/added`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash: 'a'.repeat(40) }) });
  assert.equal(addedResponse.status, 202); const addedJob = (await addedResponse.json()).data;
  await page.goto(`${config.publicUrl}jobs/${addedJob.id}`);
  await page.getByRole('heading', { name: '新增种子文件检查', exact: true }).waitFor();
  await page.getByText('目标名称：Journey.to.the.West.S02E01.1998.TVB.WEB-DL.1080p.H264.AAC.2Audio-HDCTV.mkv', { exact: true }).waitFor();
  await page.getByText('已完成', { exact: true }).first().waitFor(); assert.equal(scan, previousScans);
  await page.getByRole('link', { name: '连接与通知', exact: true }).click();
  const cleanupPanel = page.locator('section').filter({ has: page.getByRole('heading', { name: '文件丢失种子清理', exact: true }) });
  const cleanupSwitch = cleanupPanel.getByRole('switch', { name: '同时删除下载文件', exact: true });
  await cleanupSwitch.waitFor({ state: 'attached' }); assert.equal(await cleanupSwitch.getAttribute('aria-checked'), 'false');
  await cleanupSwitch.locator('..').click(); assert.equal(await cleanupPanel.getByRole('button', { name: '预览清理', exact: true }).isDisabled(), true);
  await cleanupPanel.getByRole('button', { name: '保存清理设置', exact: true }).click();
  await page.getByText('清理设置已保存', { exact: true }).waitFor();
  await page.reload(); await cleanupSwitch.waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('[aria-label="同时删除下载文件"]')?.getAttribute('aria-checked') === 'true');
  assert.equal(new CleanupSettingsStore(config.cleanupSettingsFile).get().deleteFiles, true);
  await cleanupPanel.getByRole('button', { name: '预览清理', exact: true }).click();
  await cleanupPanel.getByText('Missing movie', { exact: true }).waitFor(); assert.deepEqual(cleanupCalls, []);
  await cleanupPanel.getByRole('button', { name: '清理文件丢失种子', exact: true }).click();
  await page.getByText('将清理所有 missingFiles 种子，同时删除其下载文件。继续？', { exact: true }).waitFor();
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/qbittorrent/cleanup-missing-files') && response.request().postData()?.includes('false')), page.getByRole('button', { name: '执行清理', exact: true }).click()]);
  assert.deepEqual(cleanupCalls, ['true']);
  missingSeed = { hash: 'b'.repeat(40), name: 'Missing movie', category: 'movies', state: 'missingFiles' };
  await cleanupSwitch.locator('..').click();
  await cleanupPanel.getByRole('button', { name: '保存清理设置', exact: true }).click();
  await cleanupPanel.getByRole('button', { name: '清理文件丢失种子', exact: true }).click();
  await page.getByText('将清理所有 missingFiles 种子任务，保留下载文件。继续？', { exact: true }).waitFor();
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/qbittorrent/cleanup-missing-files') && response.request().postData()?.includes('false')), page.getByRole('button', { name: '执行清理', exact: true }).click()]);
  assert.deepEqual(cleanupCalls, ['true', 'false']);
  await page.getByRole('button', { name: '检查已有种子', exact: true }).click();
  await page.getByRole('heading', { name: '已有种子文件检查', exact: true }).waitFor();
  await page.getByText('已检查 1 个分类包含 series 的种子', { exact: true }).waitFor();
  assert.equal(scan, previousScans); assert.equal(changes.filter(c => c === 'rename').length, 1);
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '展开导航' }).click(); await page.getByRole('link', { name: '概览', exact: true }).click();
  await page.getByRole('heading', { name: '目标媒体库' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
  await page.waitForFunction(() => document.querySelectorAll('.el-message').length === 0);
  await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: '.test-artifacts/dashboard-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '展开导航' }).click(); await page.getByRole('button', { name: '退出登录' }).click(); await page.getByRole('heading', { name: '登录工作空间' }).waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(changes, ['rule', 'rule', 'rule', 'remove-rule', 'apply', 'notification', 'added-notification', 'rename']);
});
