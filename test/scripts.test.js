import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
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
