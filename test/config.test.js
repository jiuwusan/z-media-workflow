import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { CleanupSettingsStore } from '../src/util/cleanup-settings.js';
const credentials = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password', QBT_API_KEY: 'test-qbt', JELLYFIN_API_KEY: 'test-jelly', DEEPSEEK_API_KEY: 'test-deep', WEBHOOK_AUTH_ENABLED: false };
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'config.json');
}
test('JSON supplies all application settings and environment cannot override saved values', t => {
  const file = fixture(t);
  writeFileSync(file, JSON.stringify({ ...credentials, PORT: 3123, COOKIE_SECURE: true, MAX_QUEUE: 45, QBT_URL: 'http://qbt:8080', torrentCleanup: { deleteFiles: true } }));
  const config = loadConfig({ CONFIG_FILE: file, PORT: '9999', QBT_API_KEY: 'wrong' });
  assert.equal(config.port, 3123); assert.equal(config.secureCookie, true); assert.equal(config.maxQueue, 45);
  assert.equal(config.qbtUrl, 'http://qbt:8080/'); assert.equal(config.qbtKey, 'test-qbt');
  assert.equal(new CleanupSettingsStore(config.configFile).get().deleteFiles, true);
});
test('legacy environment migrates once including defaults and existing cleanup settings', t => {
  const file = fixture(t), legacy = path.join(path.dirname(file), 'old-cleanup.json');
  writeFileSync(legacy, '{"deleteFiles":true}');
  const env = { ...credentials, WEBHOOK_AUTH_ENABLED: 'false', PORT: '3456', CONFIG_FILE: file, CLEANUP_SETTINGS_FILE: legacy };
  const config = loadConfig(env);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.PORT, 3456); assert.equal(saved.WEBHOOK_AUTH_ENABLED, false);
  assert.equal(saved.REQUEST_TIMEOUT_MS, 15000); assert.equal(saved.ADMIN_PASSWORD, 'test-password');
  assert.deepEqual(saved.torrentCleanup, { deleteFiles: true });
  assert.equal(config.port, 3456);
  assert.equal(loadConfig({ CONFIG_FILE: file, PORT: '1111' }).port, 3456);
});
test('a cleanup-only config is upgraded while preserving existing and unrelated values', t => {
  const file = fixture(t);
  writeFileSync(file, '{"torrentCleanup":{"deleteFiles":true},"future":{"enabled":true}}');
  loadConfig({ ...credentials, WEBHOOK_AUTH_ENABLED: 'false', CONFIG_FILE: file });
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.torrentCleanup, { deleteFiles: true }); assert.deepEqual(saved.future, { enabled: true });
  assert.equal(saved.ADMIN_USERNAME, 'admin');
});
test('invalid JSON values or incomplete migration never overwrite a config file', t => {
  const file = fixture(t);
  assert.throws(() => loadConfig({ CONFIG_FILE: file }), /ADMIN_USERNAME/);
  assert.equal(existsSync(file), false);
  for (const values of [{ PORT: '3000' }, { COOKIE_SECURE: 'false' }, { QBT_URL: 123 }, { MAX_QUEUE: 0 }]) {
    const raw = JSON.stringify({ ...credentials, ...values }); writeFileSync(file, raw);
    assert.throws(() => loadConfig({ CONFIG_FILE: file }));
    assert.equal(readFileSync(file, 'utf8'), raw);
  }
  writeFileSync(file, '{broken');
  assert.throws(() => loadConfig({ CONFIG_FILE: file }), /配置文件无效/);
});
test('saving the page switch retains credentials and server settings in the same JSON', t => {
  const file = fixture(t);
  writeFileSync(file, JSON.stringify({ ...credentials, PORT: 3333 }));
  const config = loadConfig({ CONFIG_FILE: file });
  new CleanupSettingsStore(config.configFile).set({ deleteFiles: true });
  assert.equal(loadConfig({ CONFIG_FILE: file }).port, 3333);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).ADMIN_PASSWORD, 'test-password');
});
test('existing application config imports an old cleanup switch only when the section is absent', t => {
  const file = fixture(t), legacy = path.join(path.dirname(file), 'old-cleanup.json');
  writeFileSync(file, JSON.stringify(credentials)); writeFileSync(legacy, '{"deleteFiles":true}');
  loadConfig({ CONFIG_FILE: file, CLEANUP_SETTINGS_FILE: legacy });
  assert.equal(new CleanupSettingsStore(file).get().deleteFiles, true);
});
