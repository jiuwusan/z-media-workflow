import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openWorkflowDatabase } from '../src/storage/database.js';
import { WorkflowRepository } from '../src/storage/workflow-repository.js';
import { WorkflowService } from '../src/service/workflow.js';

for (const [point, correction] of [['prepared', false], ['http', false], ['verified', false], ['cursor', false], ['http', true]]) {
  test(`forced process termination at ${point}, correction=${correction}, preserves intent without duplicate writes`, { timeout: 15000 }, async t => {
    const dir = mkdtempSync(path.join(tmpdir(), 'workflow-crash-')), filename = path.join(dir, 'workflow.sqlite');
    let current = { Id: 'm', Type: 'Movie', LibraryId: 'lib', Name: 'Before', Path: '/movies/a.mkv', ProviderIds: {} }, writes = 0;
    const upstream = createServer(async (req, res) => {
      if (req.method === 'POST') { let data = ''; for await (const chunk of req) data += chunk; current = { ...current, ...JSON.parse(data) }; writes++; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(current));
    }).listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const base = `http://127.0.0.1:${upstream.address().port}`;
    let child, database;
    t.after(async () => { if (child?.exitCode === null && child?.signalCode === null) { child.kill(); await once(child, 'exit'); } database?.close(); await new Promise(r => upstream.close(r)); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
    child = spawn(process.execPath, [path.resolve('test/fixtures/workflow-crash-worker.mjs'), filename, base, point, String(correction)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let logs = '', jobId;
    child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error(`checkpoint timeout: ${logs}`)), 10000);
      child.on('message', m => { if (m.jobId) jobId = m.jobId; if (m.at === point) { clearTimeout(timeout); resolve(); } });
      child.once('exit', () => { clearTimeout(timeout); reject(Error(`worker exited: ${logs}`)); });
    });
    const exited = once(child, 'exit'); child.kill(); await exited;
    assert.ok(jobId); assert.equal(writes, point === 'prepared' ? 0 : 1);
    database = openWorkflowDatabase(filename);
    const repository = new WorkflowRepository(database), config = { jellyfinUrl: `${base}/`, qbtUrl: 'http://qbt/' };
    let confirmed = 0;
    const wf = new WorkflowService(config, { mediaLibrary: { ensureItem: async () => (await fetch(base)).json(), markIdentified: () => { confirmed++; } } }, { repository });
    await wf.startPromise;
    const restored = wf.get(jobId);
    assert.equal(restored.status, point === 'prepared' ? 'failed' : 'completed');
    assert.equal(restored.items[0].phase, point === 'prepared' ? 'prepared' : 'completed');
    assert.equal(restored.items[0].intent.kind, 'jellyfin.apply');
    assert.equal(writes, point === 'prepared' ? 0 : 1);
    assert.equal(confirmed, point === 'prepared' || correction ? 0 : 1);
    assert.equal(existsSync(`${filename}.cursor`), point === 'cursor');
    if (correction) assert.equal(restored.items[0].selectedCandidate.candidateId, 'chosen');
    await wf.close();
  });
}
