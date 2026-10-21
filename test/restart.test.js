import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { DEFAULT_CONFIG } from '../src/config/index.js';
import { ConfigurationService } from '../src/service/configuration.js';
import { writeTestConfig as writeConfigFile, readTestConfig, loadTestConfig as loadConfig, closeTestDatabases } from './helpers/application.js';
import { LifecycleService } from '../src/service/lifecycle.js';

function fixture(t, { managed = true, shutdown = async () => {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-restart-'));
  t.after(() => (closeTestDatabases(root), rmSync(root, { recursive: true, force: true })));
  const file = path.join(root, 'config.json');
  writeConfigFile(file, { ...DEFAULT_CONFIG, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'restart-test-password', QBT_API_KEY: 'qbt-secret', JELLYFIN_API_KEY: 'jelly-secret', DEEPSEEK_API_KEY: 'deep-secret' });
  const config = loadConfig(file), configuration = new ConfigurationService(config);
  const lifecycle = new LifecycleService({ managed, shutdown });
  const state = { counts: {}, queued: 0, running: false };
  const workflow = { stopping: false, summary: () => state };
  const services = { configuration, workflow, qbittorrent: { cleanupRunning: false } };
  return { config, configuration, lifecycle, services, state, input: () => ({ revision: configuration.get().revision }) };
}

test('restart checks saved revision and rejects outstanding work without stopping the workflow', t => {
  const { lifecycle, services, input, state } = fixture(t);
  for (const status of ['queued', 'running']) {
    state.counts = { [status]: 1, needs_review: 1 };
    assert.throws(() => lifecycle.prepare(input(), services), e => e.status === 409 && e.message === '存在排队或执行中任务，请处理完任务后再重启');
    assert.equal(services.workflow.stopping, false); assert.equal(lifecycle.pending, false);
  }
  state.counts = {}; state.running = true;
  assert.throws(() => lifecycle.prepare(input(), services), /任务/);
  state.running = false; services.qbittorrent.cleanupRunning = true;
  assert.throws(() => lifecycle.prepare(input(), services), /清理/);
  services.qbittorrent.cleanupRunning = false;
  assert.throws(() => lifecycle.prepare({ revision: 'stale' }, services), e => e.status === 409);
  assert.equal(services.workflow.stopping, false);
});

test('pending manual reviews allow restart and remain available for later confirmation', async t => {
  let calls = 0;
  const { lifecycle, services, input, state } = fixture(t, { shutdown: async () => { calls++; } });
  state.counts = { needs_review: 2 };
  assert.equal(lifecycle.prepare(input(), services).pending, true);
  await lifecycle.launch();
  assert.equal(calls, 1); assert.equal(state.counts.needs_review, 2);
});

test('restart is unavailable without PM2 and cannot silently stop a standalone server', t => {
  const { lifecycle, services, input } = fixture(t, { managed: false });
  assert.equal(lifecycle.status().supported, false);
  assert.throws(() => lifecycle.prepare(input(), services), /PM2/);
  assert.equal(services.workflow.stopping, false);
});

test('restart locks new workflow submissions and launches shutdown only once', async t => {
  let calls = 0;
  const { lifecycle, services, input } = fixture(t, { shutdown: async () => { calls++; } });
  lifecycle.prepare(input(), services);
  assert.equal(calls, 0); assert.equal(services.workflow.stopping, true);
  assert.throws(() => lifecycle.prepare(input(), services), e => e.status === 409);
  await lifecycle.launch(); await lifecycle.launch();
  assert.equal(calls, 1);
});

test('a failed shutdown unlocks the service so the administrator can retry', async t => {
  const { lifecycle, services, input } = fixture(t, { shutdown: async () => { throw new Error('shutdown failed'); } });
  lifecycle.prepare(input(), services);
  await assert.rejects(lifecycle.launch(), /shutdown failed/);
  assert.equal(lifecycle.pending, false); assert.equal(services.workflow.stopping, false);
});

test('restart endpoint authenticates, validates saved revision and responds before shutdown', async t => {
  let delivered = false, shutdownCalls = 0;
  const { config, lifecycle, services, input } = fixture(t, { shutdown: async () => { assert.equal(delivered, true); shutdownCalls++; } });
  const app = createApp({ config, services, lifecycle });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const request = (route, options) => fetch(`http://127.0.0.1:${server.address().port}${route}`, options);
  server.on('request', (req, res) => { if (req.url === '/api/service/restart') res.on('finish', () => { if (res.statusCode === 202) delivered = true; }); });
  assert.equal((await request('/api/service/status')).status, 401);
  assert.equal((await request('/api/service/restart', { method: 'POST' })).status, 401);
  const login = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: config.adminUsername, password: 'restart-test-password' }) });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'X-CSRF-Token': (await login.json()).data.csrfToken };
  const status = (await (await request('/api/service/status', { headers })).json()).data;
  assert.equal(status.supported, true); assert.equal(typeof status.instanceId, 'string');
  assert.equal((await request('/api/service/restart', { method: 'POST', headers: { Cookie: headers.Cookie }, body: '{}' })).status, 403);
  for (const body of [{}, { revision: 'stale' }, { ...input(), force: true }]) assert.ok([400, 409].includes((await request('/api/service/restart', { method: 'POST', headers, body: JSON.stringify(body) })).status));
  const response = await request('/api/service/restart', { method: 'POST', headers, body: JSON.stringify(input()) });
  assert.equal(response.status, 202); assert.equal((await response.json()).data.instanceId, status.instanceId);
  await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(shutdownCalls, 1);
  assert.equal((await request('/api/config', { method: 'PUT', headers, body: '{}' })).status, 503);
  assert.equal((await (await request('/health')).json()).data.instanceId, status.instanceId);
});
