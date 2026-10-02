import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, access } from 'node:fs/promises';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config/index.js';
import { createServices } from '../src/service/index.js';
import { createApp } from '../src/app.js';
test('panel login, RSS rules, preview, manual confirmation, responsive navigation and logout', { timeout: 90000 }, async t => {
  const libId = '1'.repeat(32), itemId = '2'.repeat(32), changes = [], errors = [];
  let scan = 0, applied = null, rules = {};
  const item = () => ({ Id: itemId, Type: 'Movie', Name: applied?.Name ?? 'Dune.2021.1080p', ProductionYear: applied?.ProductionYear, Path: '/media/movies/Dune.2021.1080p.mkv', ProviderIds: applied?.ProviderIds ?? {} });
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const d of req) raw += d;
    const url = new URL(req.url, 'http://mock'), route = url.pathname;
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (route === '/qbt/api/v2/app/version') { res.end('v5.2.3'); return; }
    if (route === '/qbt/api/v2/rss/items') return json({ 剧集: { 测试订阅: { url: 'https://example.com/rss', articles: [{ title: 'Dune 2021', date: '2026-10-02T12:00:00Z', link: 'https://example.com/article' }] } } });
    if (route === '/qbt/api/v2/rss/rules') return json(rules);
    if (route === '/qbt/api/v2/rss/setRule') { const form = new URLSearchParams(raw); rules[form.get('ruleName')] = JSON.parse(form.get('ruleDef')); changes.push('rule'); res.end(''); return; }
    if (route === '/jelly/Library/VirtualFolders') return json([{ Name: 'movie', ItemId: libId, CollectionType: 'movies', Locations: ['/media/movies'] }]);
    if (route === '/jelly/System/Info') return json({ Version: '10.11.11' });
    if (route === '/jelly/ScheduledTasks') return json([{ Id: 'scan-task', Key: 'RefreshLibrary', State: 'Idle', LastExecutionResult: { EndTimeUtc: `end-${scan}`, Status: 'Completed' } }]);
    if (route === '/jelly/Library/Refresh') { scan++; res.end(''); return; }
    if (route === '/jelly/Items') return json({ Items: [item()], TotalRecordCount: 1 });
    if (route === '/jelly/Items/RemoteSearch/Movie') return json([{ Name: 'Dune', ProductionYear: 2021, ProviderIds: { Tmdb: '438631' } }]);
    if (route === `/jelly/Items/RemoteSearch/Apply/${itemId}`) { applied = JSON.parse(raw); changes.push('apply'); res.end(''); return; }
    if (route === '/deep/models') return json({ data: [{ id: 'deepseek-flash' }] });
    if (route === '/deep/chat/completions') return json({ choices: [{ finish_reason: 'stop', message: { content: '{"name":"Dune","year":2021}' } }] });
    res.statusCode = 404; res.end('missing');
  }).listen(0, '127.0.0.1');
  await new Promise(r => upstream.once('listening', r)); t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const config = loadConfig({ ADMIN_API_TOKEN: 'admin-browser-test-token-123456', WORKFLOW_API_TOKEN: 'webhook-browser-test-token-123456', QBT_URL: `${base}/qbt/`, QBT_API_KEY: 'mock-qbt', JELLYFIN_URL: `${base}/jelly/`, JELLYFIN_API_KEY: 'mock-jelly', DEEPSEEK_URL: `${base}/deep/`, DEEPSEEK_API_KEY: 'mock-deep', POLL_INTERVAL_MS: '5', SCAN_TIMEOUT_MS: '1000', VERIFY_TIMEOUT_MS: '1000', JELLYFIN_MOVIE_LIBRARY_ID: libId });
  const services = createServices(config), server = createApp({ config, services }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r)); t.after(() => server.close()); config.publicUrl = `http://127.0.0.1:${server.address().port}/`;
  let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (!executablePath && process.platform === 'win32') { const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'; try { await access(edge); executablePath = edge; } catch {} }
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(config.publicUrl); await page.getByRole('textbox', { name: '管理令牌', exact: true }).fill(config.adminToken);
  await page.getByRole('button', { name: '进入管理面板' }).click(); await page.getByRole('heading', { name: '工作流概览', exact: true }).waitFor();
  await page.getByRole('button', { name: '检查连接' }).click(); await page.getByText('在线', { exact: true }).first().waitFor();
  await mkdir('.test-artifacts', { recursive: true }); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: '.test-artifacts/dashboard-desktop.png', fullPage: true });
  await page.getByRole('link', { name: 'RSS 订阅', exact: true }).click(); await page.getByText('Dune 2021', { exact: true }).waitFor();
  await page.getByRole('button', { name: '新建规则' }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('规则名称').fill('电影规则'); await dialog.getByLabel('包含条件').fill('Dune.*1080p'); await dialog.getByLabel('保存目录（qBittorrent 服务器路径）').fill('/media/movies');
  await dialog.getByRole('button', { name: '保存规则' }).click(); await page.getByText('电影规则', { exact: true }).waitFor();
  assert.equal(rules['电影规则'].savePath, '/media/movies');
  await page.getByRole('link', { name: '媒体识别', exact: true }).click(); await page.getByText('Dune.2021.1080p', { exact: true }).waitFor();
  await page.getByRole('button', { name: '预览候选', exact: true }).click(); await page.getByRole('button', { name: '确认此候选' }).waitFor();
  assert.equal(applied, null); await page.getByRole('textbox', { name: '搜索媒体名称' }).fill('Dune');
  await page.getByRole('button', { name: '重新搜索' }).click(); await page.getByRole('button', { name: '确认此候选' }).waitFor();
  await page.getByRole('button', { name: '确认此候选' }).click(); await page.getByRole('button', { name: '确认并应用', exact: true }).click();
  await page.getByText('已确认：Dune', { exact: false }).waitFor(); assert.equal(applied.ProviderIds.Tmdb, '438631');
  await page.getByRole('link', { name: '连接与通知', exact: true }).click(); await page.getByRole('heading', { name: '下载完成通知' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '展开导航' }).click(); await page.getByRole('link', { name: '概览', exact: true }).click();
  await page.getByRole('heading', { name: '目标媒体库' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 1);
  await page.waitForFunction(() => document.querySelectorAll('.el-message').length === 0);
  await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: '.test-artifacts/dashboard-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '展开导航' }).click(); await page.getByRole('button', { name: '退出登录' }).click(); await page.getByRole('heading', { name: '登录工作空间' }).waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(changes, ['rule', 'apply']);
});
