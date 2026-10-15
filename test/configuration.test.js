import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigurationService } from '../src/service/configuration.js';
import { loadConfig, DEFAULT_CONFIG } from '../src/config/index.js';
import { writeConfigFile } from '../src/util/config-file.js';
import { CleanupSettingsStore } from '../src/util/cleanup-settings.js';
import { createApp } from '../src/app.js';
const initial = { ...DEFAULT_CONFIG, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'private-password-123456', QBT_API_KEY: 'private-qbt', JELLYFIN_API_KEY: 'private-jelly', DEEPSEEK_API_KEY: 'private-deep', WORKFLOW_API_TOKEN: 'private-workflow-token-123456789', future: { enabled: true } };
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-config-edit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json'); writeConfigFile(file, initial);
  const config = loadConfig(file), service = new ConfigurationService(config);
  return { file, config, service };
}
test('global configuration excludes naming settings and preserves them when saving other fields', t => {
  const { service, file } = fixture(t);
  assert.equal(service.get().values.SERIES_CATEGORIES, undefined);
  assert.throws(() => service.save({ values: { SERIES_CATEGORIES: ['tv'] }, revision: service.get().revision }), /不支持/);
  writeConfigFile(file, { ...initial, SERIES_CATEGORIES: ['电视剧'] });
  service.save({ values: { DEEPSEEK_MODEL: 'new-model' }, revision: service.get().revision });
  assert.deepEqual(loadConfig(file).seriesCategories, ['电视剧']);
});
test('configuration reads mask secrets and report pending restart without exposing values', t => {
  const { service, file } = fixture(t);
  const view = service.get();
  assert.equal(view.restartRequired, false); assert.equal(view.values.ADMIN_USERNAME, 'admin');
  for (const key of ['ADMIN_PASSWORD', 'QBT_API_KEY', 'JELLYFIN_API_KEY', 'DEEPSEEK_API_KEY', 'WORKFLOW_API_TOKEN']) {
    assert.equal(view.values[key], undefined); assert.equal(view.secretFields[key], true);
    assert.equal(JSON.stringify(view).includes(initial[key]), false);
  }
  writeConfigFile(file, { ...initial, DEEPSEEK_MODEL: 'new-model' });
  assert.equal(service.get().restartRequired, true);
});
test('configuration patches persist, retain blank secrets and preserve cleanup and unknown fields', t => {
  const { service, file, config } = fixture(t);
  const saved = service.save({ values: { QBT_URL: 'http://new-qbt:8080/', ADMIN_PASSWORD: '', QBT_API_KEY: '', DEEPSEEK_API_KEY: 'new-deep-secret' }, revision: service.get().revision });
  assert.equal(saved.restartRequired, true); assert.equal(config.qbtUrl, initial.QBT_URL);
  const document = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(document.QBT_URL, 'http://new-qbt:8080/'); assert.equal(document.ADMIN_PASSWORD, initial.ADMIN_PASSWORD);
  assert.equal(document.QBT_API_KEY, initial.QBT_API_KEY); assert.equal(document.DEEPSEEK_API_KEY, 'new-deep-secret');
  assert.deepEqual(document.torrentCleanup, initial.torrentCleanup); assert.deepEqual(document.future, initial.future);
  assert.equal(JSON.stringify(saved).includes('new-deep-secret'), false);
  assert.equal(new ConfigurationService(loadConfig(file)).get().restartRequired, false);
});
test('stale edits and invalid settings never overwrite the configuration', t => {
  const { service, file } = fixture(t), revision = service.get().revision;
  new CleanupSettingsStore(file).set({ deleteFiles: true });
  const before = readFileSync(file, 'utf8');
  assert.throws(() => service.save({ values: { ADMIN_USERNAME: 'other' }, revision }), e => e.status === 409);
  for (const values of [{ PORT: 0 }, { COOKIE_SECURE: 'true' }, { unknown: true }, { torrentCleanup: { deleteFiles: false } }, { ADMIN_PASSWORD: 'short' }, { QBT_API_KEY: null }]) {
    assert.throws(() => service.save({ values, revision: service.get().revision }));
    assert.equal(readFileSync(file, 'utf8'), before);
  }
});
test('configuration API requires an administrator session and CSRF for saving', async t => {
  const { config, service } = fixture(t);
  const app = createApp({ config, services: { configuration: service } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); t.after(() => server.close());
  const request = (route, options) => fetch(`http://127.0.0.1:${server.address().port}/api${route}`, options);
  assert.equal((await request('/config')).status, 401);
  assert.equal((await request('/config', { headers: { Authorization: `Bearer ${initial.WORKFLOW_API_TOKEN}` } })).status, 401);
  const login = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: initial.ADMIN_USERNAME, password: initial.ADMIN_PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).data.csrfToken;
  const response = await request('/config', { headers: { Cookie: cookie } }); assert.equal(response.status, 200);
  const view = (await response.json()).data;
  const body = JSON.stringify({ values: { ADMIN_USERNAME: 'new-admin' }, revision: view.revision });
  assert.equal((await request('/config', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body })).status, 403);
  const saved = await request('/config', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).data.restartRequired, true);
});
