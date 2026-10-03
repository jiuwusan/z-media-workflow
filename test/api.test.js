import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
const admin = 'admin-token-at-least-24-characters', webhook = 'webhook-token-at-least-24-characters';
async function setup(t) {
  const config = { adminToken: admin, workflowToken: webhook, sessionMs: 60000, secureCookie: false, qbtKey: 'secret-qbt', jellyfinKey: 'secret-jelly', deepseekKey: 'secret-ds', publicUrl: '', trustProxy: false };
  const jobs = [];
  const services = {
    workflow: { enqueue: input => { const j = { id: 'job', input }; jobs.push(j); return j; }, list: () => ({ items: jobs, total: jobs.length }), summary: () => ({ counts: {} }) },
    qbittorrent: { rss: async () => ({}), rules: async () => ({}), setRule: async () => {} },
    mediaLibrary: { libraries: async () => [] }
  };
  const server = createApp({ config, services }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; config.publicUrl = base;
  const req = (path, options = {}) => fetch(`${base}${path}`, options);
  return { req, base, config, services };
}
test('admin cookie protects writes with Origin and CSRF; logout invalidates session', async t => {
  const { req, base } = await setup(t);
  let r = await req('/api/workflows'); assert.equal(r.status, 401);
  r = await req('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ token: admin }) }); assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0], csrf = (await r.json()).data.csrfToken;
  r = await req('/api/workflows', { headers: { Cookie: cookie } }); assert.equal(r.status, 200);
  r = await req('/api/workflows/scan', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(r.status, 403);
  r = await req('/api/workflows/scan', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example', 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(r.status, 403);
  const headers = { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  r = await req('/api/workflows/scan', { method: 'POST', headers, body: '{"dryRun":true}' }); assert.equal(r.status, 202);
  r = await req('/api/auth/logout', { method: 'POST', headers }); assert.equal(r.status, 200);
  assert.equal((await req('/api/workflows', { headers: { Cookie: cookie } })).status, 401);
});
test('webhook token cannot manage RSS; callbacks validate hash and do not accept admin token', async t => {
  const { req } = await setup(t);
  assert.equal((await req('/api/qbittorrent/rss', { headers: { Authorization: `Bearer ${webhook}` } })).status, 401);
  const call = (token, body) => req('/api/webhooks/qbittorrent/completed', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await call(admin, { hash: 'a'.repeat(40) })).status, 401);
  assert.equal((await call(webhook, { hash: 'bad' })).status, 400);
  assert.equal((await call(webhook, { hash: 'a'.repeat(40) })).status, 202);
});
test('unknown API returns JSON 404, secrets are never served, bad pagination rejected', async t => {
  const { req } = await setup(t);
  const headers = { Authorization: `Bearer ${admin}` };
  let r = await req('/api/unknown', { headers }); assert.equal(r.status, 404); assert.match(r.headers.get('content-type'), /json/);
  r = await req('/.env'); assert.equal(r.status, 404);
  assert.equal((await req('/api/workflows?page=-1', { headers })).status, 400);
  const body = await (await req('/api/dashboard', { headers })).text(); assert.equal(body.includes('secret-qbt'), false);
});
test('rule malformed fields rejected before reaching qBittorrent', async t => {
  const { req } = await setup(t);
  const r = await req('/api/qbittorrent/rss/rules/test', { method: 'PUT', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: '{"enabled":"yes","affectedFeeds":[]}' });
  assert.equal(r.status, 400);
});

test('native RSS default pause state null is accepted', async t => {
  const { req } = await setup(t);
  const r = await req('/api/qbittorrent/rss/rules/test', { method: 'PUT', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: '{"enabled":true,"addPaused":null,"affectedFeeds":[]}' });
  assert.equal(r.status, 200);
});

test('expired management session requires login again', async t => {
  const { req, base, config } = await setup(t); config.sessionMs = 5;
  const r = await req('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ token: admin }) });
  const cookie = r.headers.get('set-cookie').split(';')[0]; await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal((await req('/api/auth/session', { headers: { Cookie: cookie } })).status, 401);
});

test('completion settings require admin, validate input and reject unrelated preferences', async t => {
  const { req, services } = await setup(t);
  let state = { enabled: false, program: '' }, writes = 0;
  services.qbittorrent.completionNotification = async () => state;
  services.qbittorrent.setCompletionNotification = async input => { writes++; state = input; return state; };
  const route = '/api/qbittorrent/completion-notification';
  const headers = { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' };
  assert.equal((await req(route)).status, 401);
  assert.equal((await req(route, { headers: { Authorization: `Bearer ${webhook}` } })).status, 401);
  assert.equal((await req(route, { headers })).status, 200);
  for (const body of [{ enabled: 'yes', program: 'node x' }, { enabled: true, program: '' }, { enabled: true, program: 'node x\nother' }, { enabled: false, program: '', save_path: '/other' }]) {
    assert.equal((await req(route, { method: 'PUT', headers, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal(writes, 0);
  const r = await req(route, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, program: 'node /opt/notify.mjs "%I"' }) });
  assert.equal(r.status, 200); assert.equal((await r.json()).data.enabled, true); assert.equal(writes, 1);
});

test('internal webhook accepts tokenless curl forms while management APIs remain protected', async t => {
  const { req, config } = await setup(t); config.webhookAuthRequired = false;
  const route = '/api/webhooks/qbittorrent/completed';
  const r = await req(route, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `hash=${'a'.repeat(40)}` });
  assert.equal(r.status, 202);
  assert.equal((await req('/api/workflows')).status, 401);
  assert.equal((await req('/api/qbittorrent/completion-notification', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false,"program":""}' })).status, 401);
  assert.equal((await req(route, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'hash=bad' })).status, 400);
});

test('disabled webhook auth does not require a workflow token; enabled auth still does', () => {
  const env = { ADMIN_API_TOKEN: admin, QBT_API_KEY: 'mock-qbt', JELLYFIN_API_KEY: 'mock-jelly', DEEPSEEK_API_KEY: 'mock-ds', WEBHOOK_AUTH_ENABLED: 'false' };
  assert.equal(loadConfig(env).webhookAuthRequired, false);
  assert.throws(() => loadConfig({ ...env, WEBHOOK_AUTH_ENABLED: 'true' }), /WORKFLOW_API_TOKEN/);
});
