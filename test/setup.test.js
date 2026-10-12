import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SetupService } from '../src/service/setup.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
const input = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'setup-test-password-123', QBT_URL: 'http://qbt:8080', QBT_API_KEY: 'private-qbt', JELLYFIN_URL: 'http://jelly:8096', JELLYFIN_API_KEY: 'private-jelly', DEEPSEEK_API_KEY: 'private-deep', WEBHOOK_AUTH_ENABLED: false };
async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-setup-'));
  const file = path.join(root, 'config.json'), setup = new SetupService(file);
  const servicesFactory = () => ({ workflow: { summary: () => ({}) }, qbittorrent: {}, mediaLibrary: {} });
  const app = createApp({ config: setup.config ?? setup.bootstrap, setup, servicesFactory });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });
  const request = (route, options) => fetch(`http://127.0.0.1:${server.address().port}${route}`, options);
  const status = await request('/api/setup/status');
  const state = (await status.json()).data;
  const headers = { 'Content-Type': 'application/json', Cookie: status.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': state.csrfToken };
  return { file, app, setup, request, headers, state };
}
test('first-run status exposes no secrets and blocks normal APIs while health works', async t => {
  const { state, request, file } = await fixture(t);
  assert.equal(state.initialized, false); assert.ok(state.csrfToken);
  assert.equal(state.ADMIN_PASSWORD, undefined);
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/api/workflows')).status, 503);
  assert.equal(existsSync(file), false);
});
test('setup requires CSRF, validates configuration and never writes rejected submissions', async t => {
  const { request, headers, file } = await fixture(t);
  assert.equal((await request('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 403);
  for (const body of [{ ...input, QBT_URL: 'invalid' }, { ...input, ADMIN_PASSWORD: 'short' }, { ...input, PORT: 9999 }, { ...input, unknown: true }, { ...input, WORKFLOW_API_TOKEN: 0 }]) {
    const r = await request('/api/setup', { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(r.status, 400); assert.equal(existsSync(file), false);
  }
});
test('services that cannot initialize leave setup available without persisting credentials', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-setup-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json'), setup = new SetupService(file);
  const ctx = { request: { body: input }, cookies: { get: () => setup.nonce }, get: () => setup.nonce };
  assert.throws(() => setup.complete(ctx, () => { throw new Error('cannot initialize'); }), /cannot initialize/);
  assert.equal(existsSync(file), false); assert.equal(setup.initialized, false);
});
test('setup persists defaults once, activates login immediately and disables further setup', async t => {
  const { request, headers, file } = await fixture(t);
  const account = { ...input, ADMIN_USERNAME: '管理员'.repeat(100) };
  const response = await request('/api/setup', { method: 'POST', headers, body: JSON.stringify(account) });
  assert.equal(response.status, 201); assert.deepEqual((await response.json()).data, { initialized: true });
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.ADMIN_PASSWORD, input.ADMIN_PASSWORD); assert.equal(saved.REQUEST_TIMEOUT_MS, 15000);
  assert.ok(saved.WORKFLOW_API_TOKEN.length >= 24); assert.deepEqual(saved.torrentCleanup, { deleteFiles: false });
  assert.equal(loadConfig(file).qbtKey, input.QBT_API_KEY);
  assert.equal(loadConfig(file).adminUsername, account.ADMIN_USERNAME);
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: account.ADMIN_USERNAME, password: account.ADMIN_PASSWORD }) });
  assert.equal(login.status, 200);
  const before = readFileSync(file, 'utf8');
  assert.equal((await request('/api/setup', { method: 'POST', headers, body: JSON.stringify(input) })).status, 409);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual((await (await request('/api/setup/status')).json()).data, { initialized: true });
  assert.equal(new SetupService(file).initialized, true);
});
test('setup never overwrites a config created by another process', async t => {
  const { request, headers, file } = await fixture(t);
  writeFileSync(file, '{"external":true}');
  assert.equal((await request('/api/setup', { method: 'POST', headers, body: JSON.stringify(input) })).status, 409);
  assert.equal(readFileSync(file, 'utf8'), '{"external":true}');
});
