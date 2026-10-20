import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_CONFIG } from '../src/config/index.js';

test('PM2 keeps its runtime alive while the page restart loads saved config into a new worker', { timeout: 90000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'media-pm2-'));
  const pm2Home = path.join(root, 'pm2');
  const env = { ...process.env, PM2_HOME: pm2Home, PM2_SILENT: 'true' };
  const runtimePath = path.resolve('node_modules/pm2/bin/pm2-runtime');
  const pm2Path = path.resolve('node_modules/pm2/bin/pm2');
  const reserve = createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const document = { ...DEFAULT_CONFIG, HOST: '127.0.0.1', PORT: port, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'pm2-restart-test-password', QBT_API_KEY: 'mock-qbt', JELLYFIN_API_KEY: 'mock-jelly', DEEPSEEK_API_KEY: 'mock-deep' };
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'data/config.json'), JSON.stringify(document));
  const ecosystem = createRequire(import.meta.url)('../ecosystem.config.cjs');
  const app = { ...ecosystem.apps[0], cwd: root, script: path.resolve('src/server.js'), out_file: path.join(root, 'stdout.log'), error_file: path.join(root, 'stderr.log') };
  assert.equal(app.instances, 1); assert.equal(app.exec_mode, 'fork'); assert.equal(app.autorestart, true);
  const ecosystemFile = path.join(root, 'ecosystem.config.json');
  await writeFile(ecosystemFile, JSON.stringify({ apps: [app] }));
  const runtime = spawn(process.execPath, [runtimePath, ecosystemFile], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; runtime.stdout.on('data', data => { logs += data; }); runtime.stderr.on('data', data => { logs += data; });
  t.after(async () => {
    const kill = spawn(process.execPath, [pm2Path, 'kill'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
    await once(kill, 'exit');
    if (runtime.exitCode === null) { runtime.kill(); await once(runtime, 'exit'); }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const base = `http://127.0.0.1:${port}`;
  async function waitReady(previous) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { const { data } = await response.json(); if (data.status === 'ok' && data.instanceId && data.instanceId !== previous) return data; }
      } catch {}
      if (runtime.exitCode !== null) throw new Error(`PM2 runtime stopped: ${logs}`);
      await delay(150);
    }
    throw new Error(`PM2 service did not become ready: ${logs}`);
  }
  async function login() {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.ADMIN_USERNAME, password: document.ADMIN_PASSWORD }) });
    assert.equal(response.status, 200);
    return { 'Content-Type': 'application/json', Cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': (await response.json()).data.csrfToken };
  }
  const before = await waitReady();
  const headers = await login();
  const status = (await (await fetch(`${base}/api/service/status`, { headers })).json()).data;
  assert.equal(status.supported, true);
  const config = (await (await fetch(`${base}/api/config`, { headers })).json()).data;
  const save = await fetch(`${base}/api/config`, { method: 'PUT', headers, body: JSON.stringify({ revision: config.revision, values: { DEEPSEEK_MODEL: 'restarted-model' } }) });
  assert.equal(save.status, 200); const saved = (await save.json()).data; assert.equal(saved.restartRequired, true);
  const restart = await fetch(`${base}/api/service/restart`, { method: 'POST', headers, body: JSON.stringify({ revision: saved.revision }) });
  assert.equal(restart.status, 202);
  assert.equal((await restart.json()).data.instanceId, before.instanceId);
  const after = await waitReady(before.instanceId);
  assert.notEqual(after.instanceId, before.instanceId); assert.equal(runtime.exitCode, null);
  assert.equal((await fetch(`${base}/api/auth/session`, { headers })).status, 401);
  const newHeaders = await login();
  const loaded = (await (await fetch(`${base}/api/config`, { headers: newHeaders })).json()).data;
  assert.equal(loaded.values.DEEPSEEK_MODEL, 'restarted-model'); assert.equal(loaded.restartRequired, false);
});
