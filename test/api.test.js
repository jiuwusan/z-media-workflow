import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
const admin = 'admin-token-at-least-24-characters', webhook = 'webhook-token-at-least-24-characters';

test('added callback validates hashes and uses webhook authentication', async t => {
  const { req, config } = await setup(t);
  const post = (hash, headers = {}) => req('/api/webhooks/qbittorrent/added', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ hash }) });
  assert.equal((await post('a'.repeat(40))).status, 401);
  assert.equal((await post('invalid', { Authorization: `Bearer ${webhook}` })).status, 400);
  const response = await post('A'.repeat(40), { Authorization: `Bearer ${webhook}` });
  assert.equal(response.status, 202); assert.deepEqual((await response.json()).data.input, { hash: 'a'.repeat(40), event: 'added' });
  config.webhookAuthRequired = false; assert.equal((await post('b'.repeat(64))).status, 202);
});

test('added notification settings require login, CSRF and strict fields', async t => {
  const { req, services, login } = await setup(t); let state = { enabled: false, program: '' };
  services.qbittorrent.addedNotification = async () => state;
  services.qbittorrent.setAddedNotification = async value => { state = value; return state; };
  const route = '/api/qbittorrent/added-notification', headers = await login();
  assert.equal((await req(route)).status, 401);
  assert.equal((await req(route, { headers })).status, 200);
  for (const body of [{ enabled: true, program: '' }, { enabled: true, program: 'curl\ncommand' }, { enabled: false, program: '', save_path: '/other' }]) assert.equal((await req(route, { method: 'PUT', headers, body: JSON.stringify(body) })).status, 400);
  const response = await req(route, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, program: 'curl added' }) });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, { enabled: true, program: 'curl added' });
});
test('username/password login issues a session and rejects old admin bearer and token login', async t => {
  const { req, base, config } = await setup(t);
  config.adminUsername = 'admin'; config.adminPassword = 'correct-test-password-123';
  const post = body => req('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
  assert.equal((await post({ username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await post({ username: 'wrong', password: config.adminPassword })).status, 401);
  assert.equal((await post({ token: admin })).status, 401);
  assert.equal((await req('/api/workflows', { headers: { Authorization: `Bearer ${admin}` } })).status, 401);
  const r = await post({ username: 'admin', password: config.adminPassword });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('/api/workflows', { headers: { Cookie: cookie } })).status, 200);
});
async function setup(t) {
  const config = { adminUsername: 'admin', adminPassword: 'correct-test-password-123', workflowToken: webhook, sessionMs: 60000, secureCookie: false, qbtKey: 'secret-qbt', jellyfinKey: 'secret-jelly', deepseekKey: 'secret-ds', publicUrl: '', trustProxy: false };
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
  const login = async () => {
    const r = await req('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: config.adminUsername, password: config.adminPassword }) });
    assert.equal(r.status, 200);
    return { Cookie: r.headers.get('set-cookie').split(';')[0], Origin: base, 'X-CSRF-Token': (await r.json()).data.csrfToken, 'Content-Type': 'application/json' };
  };
  return { req, base, config, services, login };
}
test('admin cookie protects writes with CSRF; logout invalidates session', async t => {
  const { req, base } = await setup(t);
  let r = await req('/api/workflows'); assert.equal(r.status, 401);
  r = await req('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: 'admin', password: 'correct-test-password-123' }) }); assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0], csrf = (await r.json()).data.csrfToken;
  r = await req('/api/workflows', { headers: { Cookie: cookie } }); assert.equal(r.status, 200);
  r = await req('/api/workflows/scan', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(r.status, 403);
  r = await req('/api/workflows/scan', { method: 'POST', headers: { Cookie: cookie, Origin: 'http://192.168.50.182:3000', 'X-CSRF-Token': 'wrong-csrf', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(r.status, 403);
  const headers = { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  r = await req('/api/workflows/scan', { method: 'POST', headers, body: '{"dryRun":true}' }); assert.equal(r.status, 202);
  r = await req('/api/auth/logout', { method: 'POST', headers }); assert.equal(r.status, 200);
  assert.equal((await req('/api/workflows', { headers: { Cookie: cookie } })).status, 401);
});

test('login and authenticated writes accept any Origin or no Origin while credentials and CSRF remain required', async t => {
  const { req, config } = await setup(t);
  for (const origin of ['http://192.168.50.182:3000', 'https://media.example.com', undefined]) {
    const headers = { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) };
    const login = password => req('/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ username: config.adminUsername, password }) });
    assert.equal((await login('wrong-password')).status, 401);
    const r = await login(config.adminPassword); assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0], csrf = (await r.json()).data.csrfToken;
    const write = extra => req('/api/workflows/scan', { method: 'POST', headers: { ...headers, ...extra }, body: '{"dryRun":true}' });
    assert.equal((await write({ 'X-CSRF-Token': csrf })).status, 401);
    assert.equal((await write({ Cookie: cookie })).status, 403);
    assert.equal((await write({ Cookie: cookie, 'X-CSRF-Token': 'wrong-csrf' })).status, 403);
    assert.equal((await write({ Cookie: cookie, 'X-CSRF-Token': csrf })).status, 202);
  }
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
  const { req, login } = await setup(t);
  const headers = await login();
  let r = await req('/api/unknown', { headers }); assert.equal(r.status, 404); assert.match(r.headers.get('content-type'), /json/);
  r = await req('/.env'); assert.equal(r.status, 404);
  assert.equal((await req('/api/workflows?page=-1', { headers })).status, 400);
  const body = await (await req('/api/dashboard', { headers })).text(); assert.equal(body.includes('secret-qbt'), false); assert.equal(body.includes('correct-test-password-123'), false);
});
test('rule malformed fields rejected before reaching qBittorrent', async t => {
  const { req, login } = await setup(t);
  const r = await req('/api/qbittorrent/rss/rules/test', { method: 'PUT', headers: await login(), body: '{"enabled":"yes","affectedFeeds":[]}' });
  assert.equal(r.status, 400);
});

test('native RSS default pause state null is accepted', async t => {
  const { req, login } = await setup(t);
  const r = await req('/api/qbittorrent/rss/rules/test', { method: 'PUT', headers: await login(), body: '{"enabled":true,"addPaused":null,"affectedFeeds":[]}' });
  assert.equal(r.status, 200);
});

test('expired management session requires login again', async t => {
  const { req, base, config } = await setup(t); config.sessionMs = 5;
  const r = await req('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: 'admin', password: 'correct-test-password-123' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0]; await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal((await req('/api/auth/session', { headers: { Cookie: cookie } })).status, 401);
});

test('completion settings require admin, validate input and reject unrelated preferences', async t => {
  const { req, services, login } = await setup(t);
  let state = { enabled: false, program: '' }, writes = 0;
  services.qbittorrent.completionNotification = async () => state;
  services.qbittorrent.setCompletionNotification = async input => { writes++; state = input; return state; };
  const route = '/api/qbittorrent/completion-notification';
  const headers = await login();
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
  const env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'correct-test-password-123', QBT_API_KEY: 'mock-qbt', JELLYFIN_API_KEY: 'mock-jelly', DEEPSEEK_API_KEY: 'mock-ds', WEBHOOK_AUTH_ENABLED: 'false' };
  assert.equal(loadConfig(env).webhookAuthRequired, false);
  assert.throws(() => loadConfig({ ...env, WEBHOOK_AUTH_ENABLED: 'true' }), /WORKFLOW_API_TOKEN/);
});

test('browser login origin and container callback address can differ', async t => {
  const { req, config, login } = await setup(t);
  config.callbackUrl = 'http://172.29.0.1:3000/api/webhooks/qbittorrent/completed';
  const r = await req('/api/dashboard', { headers: await login() });
  assert.equal((await r.json()).data.callbackUrl, config.callbackUrl);
});
