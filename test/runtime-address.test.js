import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveRuntimeAddress, runtimeHealthUrl } from '../src/util/runtime-address.js';
import { writeConfigFile } from '../src/util/config-file.js';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
test('health checks keep using the live listener when a new port is saved for restart', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-runtime-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.json');
  saveRuntimeAddress({ address: '0.0.0.0', port: 3123 }, file);
  writeConfigFile(path.join(root, 'config.json'), { PORT: 9999 });
  assert.equal(runtimeHealthUrl(file), 'http://127.0.0.1:3123/health');
  saveRuntimeAddress({ address: '::1', port: 9999 }, file);
  assert.equal(runtimeHealthUrl(file), 'http://[::1]:9999/health');
  saveRuntimeAddress({ address: '::', port: 3000 }, file);
  assert.equal(runtimeHealthUrl(file), 'http://127.0.0.1:3000/health');
});
test('invalid runtime metadata is not used to contact a health endpoint', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-runtime-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime.json');
  for (const data of [{}, { host: '127.0.0.1', port: 0 }, { host: 'http://bad', port: 3000 }, { host: '127.0.0.1', port: '3000' }]) {
    writeConfigFile(file, data); assert.throws(() => runtimeHealthUrl(file));
  }
});
test('Docker health script succeeds against the running listener despite a pending port change', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-health-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = createServer((req, res) => { assert.equal(req.url, '/health'); res.end('ok'); }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); t.after(() => server.close());
  saveRuntimeAddress(server.address(), path.join(root, 'data/runtime.json'));
  writeConfigFile(path.join(root, 'data/config.json'), { PORT: 1 });
  const child = spawn(process.execPath, [path.resolve('scripts/health-check.mjs')], { cwd: root });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0);
});
