import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { JellyfinService } from '../src/service/jellyfin.js';

const id = '1'.repeat(32);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
async function fixture(t, upstreamResponse) {
  const requests = [];
  const upstream = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(url);
    assert.equal(url.pathname, `/Items/${id}/Images/Primary`);
    assert.equal(url.searchParams.get('maxWidth'), '400');
    assert.equal(req.headers['x-emby-token'], 'private-jellyfin-key');
    upstreamResponse(res);
  }).listen(0, '127.0.0.1');
  await new Promise(r => upstream.once('listening', r)); t.after(() => upstream.close());
  const config = { jellyfinUrl: `http://127.0.0.1:${upstream.address().port}/`, jellyfinKey: 'private-jellyfin-key', adminUsername: 'admin', adminPassword: 'poster-test-password', sessionMs: 60000 };
  const jellyfin = new JellyfinService(config);
  const app = createApp({ config, services: { jellyfin } }).listen(0, '127.0.0.1');
  await new Promise(r => app.once('listening', r)); t.after(() => app.close());
  const request = (path, options) => fetch(`http://127.0.0.1:${app.address().port}/api${path}`, options);
  const login = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: config.adminUsername, password: config.adminPassword }) });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  return { request, headers, requests };
}

test('poster proxy requires login and returns image bytes without exposing the Jellyfin token', async t => {
  const { request, headers, requests } = await fixture(t, res => { res.setHeader('Content-Type', 'image/png'); res.end(png); });
  assert.equal((await request(`/media/${id}/poster`)).status, 401); assert.equal(requests.length, 0);
  const response = await request(`/media/${id}/poster`, { headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(requests[0].search.includes('private-jellyfin-key'), false);
  assert.equal((await request('/media/invalid/poster', { headers })).status, 400);
  assert.equal(requests.length, 1);
});

test('missing posters return 404 so the wall can display a placeholder', async t => {
  const { request, headers, requests } = await fixture(t, res => { res.statusCode = 404; res.end('No image'); });
  const response = await request(`/media/${id}/poster`, { headers });
  assert.equal(response.status, 404); assert.equal(requests.length, 1);
});

test('poster proxy rejects non-image upstream responses', async t => {
  const { request, headers } = await fixture(t, res => { res.setHeader('Content-Type', 'text/html'); res.end('<h1>Unexpected response</h1>'); });
  const response = await request(`/media/${id}/poster`, { headers });
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes('<h1>'), false);
});
