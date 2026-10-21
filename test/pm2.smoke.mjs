import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_CONFIG } from '../src/config/index.js';
import { createServer as createHttpServer } from 'node:http';
import { openWorkflowDatabase } from '../src/storage/database.js';
import { WorkflowRepository, sourceScope } from '../src/storage/workflow-repository.js';
import { digest } from '../src/util/credentials.js';

test('PM2 keeps its runtime alive while the page restart loads saved config into a new worker', { timeout: 90000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'media-pm2-'));
  const pm2Home = path.join(root, 'pm2');
  const env = { ...process.env, PM2_HOME: pm2Home, PM2_SILENT: 'true' };
  const runtimePath = path.resolve('node_modules/pm2/bin/pm2-runtime');
  const pm2Path = path.resolve('node_modules/pm2/bin/pm2');
  const reserve = createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  let torrentReads = 0;
  const upstream = createHttpServer((_req, res) => { torrentReads++; res.setHeader('Content-Type', 'application/json'); res.end('[]'); }).listen(0, '127.0.0.1');
  await once(upstream, 'listening'); t.after(() => new Promise(resolve => upstream.close(resolve)));
  const document = { ...DEFAULT_CONFIG, HOST: '127.0.0.1', PORT: port, QBT_URL: `http://127.0.0.1:${upstream.address().port}/`, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'pm2-restart-test-password', QBT_API_KEY: 'mock-qbt', JELLYFIN_API_KEY: 'mock-jelly', DEEPSEEK_API_KEY: 'mock-deep' };
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'data/config.json'), JSON.stringify(document));
  const dbFile = path.join(root, 'data/workflow.sqlite');
  const db = openWorkflowDatabase(dbFile), repo = new WorkflowRepository(db), scope = sourceScope({ jellyfinUrl: document.JELLYFIN_URL, qbtUrl: document.QBT_URL });
  const history = repo.accept({ input: { dryRun: true }, sourceScope: scope }), historyAction = repo.claimNext();
  history.status = 'completed'; history.items = [{ itemId: 'm', status: 'completed', candidates: [{ candidateId: 'stable-history', Name: '电影' }] }];
  repo.save(history, { actionId: historyAction.id, actionStatus: 'completed' });
  const queued = repo.accept({ input: { checkExisting: true, event: 'added' }, sourceScope: scope }); db.close();
  const ecosystem = createRequire(import.meta.url)('../ecosystem.config.cjs');
  const app = { ...ecosystem.apps[0], cwd: root, script: path.resolve('test/fixtures/application-server.mjs'),args:[String(port)], out_file: path.join(root, 'stdout.log'), error_file: path.join(root, 'stderr.log') };
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
  let setupStatus;
  for(let i=0;i<150;i++){
    try{const r=await fetch(`${base}/api/setup/status`,{signal:AbortSignal.timeout(1000)});if(r.ok){setupStatus=r;break;}}catch{}
    await delay(100);
  }
  assert.ok(setupStatus,`setup did not become available: ${logs}`);
  const initialPasskey=(await readFile(path.join(root,'data/passkey'),'utf8')).trim();
  assert.match(initialPasskey,/^v1:[a-f0-9]{64}$/);
  assert.ok((await readFile(path.join(root,'stdout.log'),'utf8')).includes(initialPasskey),'startup logs publish the current passkey before setup');
  const initial=(await setupStatus.json()).data;assert.equal(initial.initialized,false);assert.equal(torrentReads,0);
  const cursorScope=JSON.stringify([document.JELLYFIN_URL,'lib','Movie']);
  const initialized=await fetch(`${base}/api/setup`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:setupStatus.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':initial.csrfToken},body:JSON.stringify({ADMIN_USERNAME:document.ADMIN_USERNAME,ADMIN_PASSWORD:document.ADMIN_PASSWORD,QBT_URL:document.QBT_URL,QBT_API_KEY:document.QBT_API_KEY,JELLYFIN_API_KEY:document.JELLYFIN_API_KEY,DEEPSEEK_API_KEY:document.DEEPSEEK_API_KEY,PUBLIC_URL:`${base}/`,cursor:{mode:'import',data:{version:1,libraries:{[cursorScope]:{date:null,ids:[],pending:['retained-cursor'],undated:[]}}}}})});
  assert.equal(initialized.status,201);assert.match(await readFile(path.join(root,'data/passkey'),'utf8'),/^v1:[a-f0-9]{64}/);
  assert.equal((await readFile(path.join(root,'data/passkey'),'utf8')).trim(),initialPasskey);
  const before = await waitReady();
  const headers = await login();
  for (let i = 0; i < 50; i++) {
    const job = (await (await fetch(`${base}/api/workflows/${queued.id}`, { headers })).json()).data;
    if (job.status === 'completed') break;
    await delay(100);
  }
  assert.equal((await (await fetch(`${base}/api/workflows/${queued.id}`, { headers })).json()).data.status, 'completed');
  assert.equal(torrentReads, 1);
  const status = (await (await fetch(`${base}/api/service/status`, { headers })).json()).data;
  assert.equal(status.supported, true);
  const config = (await (await fetch(`${base}/api/config`, { headers })).json()).data;
  const save = await fetch(`${base}/api/config`, { method: 'PUT', headers, body: JSON.stringify({ revision: config.revision, values: { DEEPSEEK_MODEL: 'restarted-model',PORT:port,HOST:'127.0.0.1' } }) });
  assert.equal(save.status, 200); const saved = (await save.json()).data; assert.equal(saved.restartRequired, true);
  for(let i=0;i<3;i++)assert.equal((await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'wrong-password'})})).status,401);
  const restart = await fetch(`${base}/api/service/restart`, { method: 'POST', headers, body: JSON.stringify({ revision: saved.revision }) });
  assert.equal(restart.status, 202);
  assert.equal((await restart.json()).data.instanceId, before.instanceId);
  const after = await waitReady(before.instanceId);
  const restartedPasskey=(await readFile(path.join(root,'data/passkey'),'utf8')).trim();
  assert.notEqual(restartedPasskey,initialPasskey);
  assert.ok((await readFile(path.join(root,'stdout.log'),'utf8')).includes(restartedPasskey),'PM2 restart logs publish the replacement passkey');
  assert.notEqual(after.instanceId, before.instanceId); assert.equal(runtime.exitCode, null);
  assert.equal((await fetch(`${base}/api/auth/session`, { headers })).status, 401);
  const inspect=openWorkflowDatabase(dbFile);
  assert.equal(inspect.connection.prepare('SELECT passkey_digest FROM credentials').get().passkey_digest,digest(restartedPasskey));
  assert.equal(inspect.connection.prepare("SELECT count FROM auth_attempts WHERE namespace='login'").get().count,3);
  assert.equal(inspect.connection.prepare("SELECT item_id FROM media_cursor_ids WHERE kind='pending'").get().item_id,'retained-cursor');inspect.close();
  const newHeaders = await login();
  const loaded = (await (await fetch(`${base}/api/config`, { headers: newHeaders })).json()).data;
  assert.equal(loaded.values.DEEPSEEK_MODEL, 'restarted-model'); assert.equal(loaded.restartRequired, false);
  const restored = (await (await fetch(`${base}/api/workflows/${history.id}`, { headers: newHeaders })).json()).data;
  assert.equal(restored.items[0].candidates[0].candidateId, 'stable-history'); assert.equal(torrentReads, 1);
  const liveDb = openWorkflowDatabase(dbFile), liveRepo = new WorkflowRepository(liveDb);
  const review = liveRepo.accept({ input: { correction: true }, sourceScope: scope }), reviewAction = liveRepo.claimNext();
  review.status = 'needs_review'; review.items = [{ itemId: 'review', status: 'needs_review', candidates: [{ candidateId: 'stable-review', Name: '待纠错' }] }];
  liveRepo.save(review, { actionId: reviewAction.id, actionStatus: 'completed' }); liveDb.close();
  const blocked = await fetch(`${base}/api/service/restart`, { method: 'POST', headers: newHeaders, body: JSON.stringify({ revision: loaded.revision }) });
  assert.equal(blocked.status, 409);
  const pm2Restart = spawn(process.execPath, [pm2Path, 'restart', 'z-media-workflow'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  await once(pm2Restart, 'exit'); await waitReady(after.instanceId);
  const finalPasskey=(await readFile(path.join(root,'data/passkey'),'utf8')).trim();
  assert.notEqual(finalPasskey,restartedPasskey);
  assert.ok((await readFile(path.join(root,'stdout.log'),'utf8')).includes(finalPasskey),'external PM2 restart also rotates and logs the key');
  const finalHeaders = await login();
  const retained = (await (await fetch(`${base}/api/workflows/${review.id}`, { headers: finalHeaders })).json()).data;
  assert.equal(retained.status, 'needs_review'); assert.equal(retained.items[0].candidates[0].candidateId, 'stable-review');
});
