import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from '../src/app.js';

test('curl config submits URL-encoded v1/v2 hashes with isolated webhook token', async t => {
  const webhookToken = 'curl-test-webhook-token-123456789';
  const inputs = [];
  const config = { workflowToken: webhookToken, adminToken: 'curl-test-admin-token-123456789', sessionMs: 60000 };
  const server = createApp({ config, services: { workflow: { enqueue: input => { inputs.push(input); return { id: 'curl-job' }; } } } }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r)); t.after(() => server.close());
  const template = await readFile('scripts/notify-completed.curl.example', 'utf8');
  await mkdir('.test-artifacts', { recursive: true });
  const path = resolve(`.test-artifacts/curl-notify-${process.pid}.config`);
  await writeFile(path, template.replace('http://172.29.0.1:30001/api/webhooks/qbittorrent/completed', `http://127.0.0.1:${server.address().port}/api/webhooks/qbittorrent/completed`).replace('replace-with-the-server-workflow-token', webhookToken));
  t.after(() => unlink(path));
  async function call(hash) {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-q', '--config', path, '--data-urlencode', `hash=${hash}`]);
    let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
    const code = await new Promise((r, reject) => { child.on('error', reject); child.on('close', r); });
    assert.equal(output.includes(webhookToken), false);
    return code;
  }
  assert.equal(await call('a'.repeat(40)), 0);
  assert.equal(await call('b'.repeat(64)), 0);
  assert.deepEqual(inputs.map(i => i.hash), ['a'.repeat(40), 'b'.repeat(64)]);
  assert.notEqual(await call('bad-hash'), 0);
  assert.equal(inputs.length, 2);
});
test('standalone notification submits hash and independent token without logging token', async t => {
  let received;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    received = { token: req.headers.authorization, method: req.method, body: JSON.parse(body) };
    res.setHeader('Content-Type', 'application/json'); res.statusCode = 202; res.end('{"data":{"id":"notify-job"}}');
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r)); t.after(() => server.close());
  const token = 'standalone-webhook-secret';
  const child = spawn(process.execPath, ['scripts/notify-completed.mjs', 'a'.repeat(40), 'Movie'], { env: { ...process.env, WORKFLOW_CALLBACK_URL: `http://127.0.0.1:${server.address().port}/callback`, WORKFLOW_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const code = await new Promise(r => child.on('close', r)); assert.equal(code, 0);
  assert.deepEqual(received, { token: `Bearer ${token}`, method: 'POST', body: { hash: 'a'.repeat(40), type: 'Movie' } });
  assert.match(output, /notify-job/); assert.equal(output.includes(token), false);
});
