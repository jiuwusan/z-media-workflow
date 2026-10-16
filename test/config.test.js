import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, validateConfig } from '../src/config/index.js';
import { CleanupSettingsStore } from '../src/util/cleanup-settings.js';
const credentials = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password', QBT_API_KEY: 'test-qbt', JELLYFIN_API_KEY: 'test-jelly', DEEPSEEK_API_KEY: 'test-deep', WEBHOOK_AUTH_ENABLED: false };

test('library refresh wait defaults to ten seconds and accepts nonnegative integer milliseconds', () => {
  assert.equal(validateConfig(credentials).libraryRefreshWaitMs, 10000);
  for (const value of [0, 2500, 100000000]) assert.equal(validateConfig({ ...credentials, LIBRARY_REFRESH_WAIT_MS: value }).libraryRefreshWaitMs, value);
  for (const value of [-1, 1.5, '10000', null, 100000001]) assert.throws(() => validateConfig({ ...credentials, LIBRARY_REFRESH_WAIT_MS: value }), /LIBRARY_REFRESH_WAIT_MS/);
});
test('series categories are a validated JSON list with no preselected categories', () => {
  assert.deepEqual(validateConfig(credentials).seriesCategories, []);
  assert.deepEqual(validateConfig({ ...credentials, SERIES_CATEGORIES: ['电视剧', 'TV'] }).seriesCategories, ['电视剧', 'TV']);
  assert.deepEqual(validateConfig({ ...credentials, SERIES_CATEGORIES: [] }).seriesCategories, []);
  for (const value of ['series', null, [1], [''], [' TV ']]) assert.throws(() => validateConfig({ ...credentials, SERIES_CATEGORIES: value }), /SERIES_CATEGORIES/);
});
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'config.json');
}
test('missing config requests first-run setup without creating a file', t => {
  const file = fixture(t);
  assert.equal(loadConfig(file), null); assert.equal(existsSync(file), false);
});
test('JSON supplies native settings and environment variables are ignored', t => {
  const file = fixture(t);
  writeFileSync(file, JSON.stringify({ ...credentials, PORT: 3123, COOKIE_SECURE: true, MAX_QUEUE: 45, QBT_URL: 'http://qbt:8080', torrentCleanup: { deleteFiles: true } }));
  const previous = process.env.PORT; process.env.PORT = '9999';
  t.after(() => { if (previous === undefined) delete process.env.PORT; else process.env.PORT = previous; });
  const config = loadConfig(file);
  assert.equal(config.port, 3123); assert.equal(config.secureCookie, true); assert.equal(config.maxQueue, 45);
  assert.equal(config.qbtUrl, 'http://qbt:8080/'); assert.equal(config.qbtKey, 'test-qbt');
  assert.equal(new CleanupSettingsStore(config.configFile).get().deleteFiles, true);
});
test('invalid or incomplete existing config fails without resetting to setup or rewriting', t => {
  const file = fixture(t);
  for (const values of [{ PORT: '3000' }, { COOKIE_SECURE: 'false' }, { QBT_URL: 123 }, { MAX_QUEUE: 0 }, { torrentCleanup: null }]) {
    const raw = JSON.stringify({ ...credentials, ...values }); writeFileSync(file, raw);
    assert.throws(() => loadConfig(file)); assert.equal(readFileSync(file, 'utf8'), raw);
  }
  writeFileSync(file, '{}'); assert.throws(() => loadConfig(file), /ADMIN_USERNAME/);
  writeFileSync(file, '{broken'); assert.throws(() => loadConfig(file), /配置文件无效/);
});
test('saving the page switch preserves server settings and credentials', t => {
  const file = fixture(t);
  writeFileSync(file, JSON.stringify({ ...credentials, PORT: 3333 }));
  new CleanupSettingsStore(file).set({ deleteFiles: true });
  assert.equal(loadConfig(file).port, 3333);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).ADMIN_PASSWORD, 'test-password');
});
test('callback token is required only when JSON enables callback authentication', () => {
  assert.equal(validateConfig(credentials).webhookAuthRequired, false);
  assert.throws(() => validateConfig({ ...credentials, WEBHOOK_AUTH_ENABLED: true }), /WORKFLOW_API_TOKEN/);
});
