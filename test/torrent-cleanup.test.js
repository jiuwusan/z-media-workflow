import test from 'node:test';
import assert from 'node:assert/strict';
import { QbittorrentService } from '../src/service/qbittorrent.js';

const hash = 'a'.repeat(40), other = 'b'.repeat(64);
const missing = { hash, name: 'Missing movie', state: 'missingFiles' };

test('cleanup preview lists only missingFiles and never deletes data', async () => {
  const qbt = new QbittorrentService({}, async (path, options) => {
    assert.equal(path, 'torrents/info'); assert.equal(options.query.filter, 'all');
    return [missing, { hash: other, state: 'error' }, { hash: 'c'.repeat(40), state: 'stalledUP' }];
  });
  const result = await qbt.cleanupMissingFiles();
  assert.equal(result.dryRun, true); assert.equal(result.matchedCount, 1);
  assert.equal(result.deletedCount, 0); assert.equal(result.items[0].status, 'would_delete');
});

test('cleanup rechecks missing state and deletes explicit hash with files', async () => {
  let deleted = false;
  const qbt = new QbittorrentService({}, async (path, options) => {
    if (path === 'torrents/delete') {
      assert.equal(options.method, 'POST'); assert.deepEqual(options.form, { hashes: hash, deleteFiles: true });
      deleted = true; return;
    }
    assert.equal(path, 'torrents/info');
    return deleted ? [] : [missing];
  });
  const result = await qbt.cleanupMissingFiles({ dryRun: false, deleteFiles: true });
  assert.equal(result.deletedCount, 1); assert.equal(result.failedCount, 0);
  assert.equal(result.items[0].status, 'deleted');
});

test('cleanup passes the chosen file deletion mode to qBittorrent', async () => {
  for (const deleteFiles of [false, true]) {
    let deleted = false;
    const qbt = new QbittorrentService({}, async (path, options) => {
      if (path === 'torrents/delete') { assert.equal(options.form.deleteFiles, deleteFiles); deleted = true; return; }
      return deleted ? [] : [missing];
    });
    const result = await qbt.cleanupMissingFiles({ dryRun: false, deleteFiles });
    assert.equal(result.deleteFiles, deleteFiles); assert.equal(result.deletedCount, 1);
  }
});

test('cleanup skips recovered or already removed torrents', async () => {
  const qbt = new QbittorrentService({}, async (path, options) => {
    assert.equal(path, 'torrents/info');
    if (options.query.filter) return [missing, { ...missing, hash: other }];
    return options.query.hashes === hash ? [{ ...missing, state: 'uploading' }] : [];
  });
  const result = await qbt.cleanupMissingFiles({ dryRun: false });
  assert.equal(result.skippedCount, 2); assert.equal(result.deletedCount, 0);
});

test('cleanup rejects malformed upstream hashes without issuing any delete', async () => {
  const qbt = new QbittorrentService({}, async path => {
    assert.equal(path, 'torrents/info'); return [{ ...missing, hash: 'all' }];
  });
  await assert.rejects(qbt.cleanupMissingFiles({ dryRun: false }), /hash/);
});

test('cleanup verifies removal even when the delete response was lost', async () => {
  let removed = false;
  const qbt = new QbittorrentService({}, async path => {
    if (path === 'torrents/delete') { removed = true; throw new Error('response lost'); }
    return removed ? [] : [missing];
  });
  assert.equal((await qbt.cleanupMissingFiles({ dryRun: false })).deletedCount, 1);
});

test('cleanup reports failed deletions, redacts secrets and continues the batch', async () => {
  let removed;
  const qbt = new QbittorrentService({ qbtKey: 'private-key' }, async (path, options) => {
    if (path === 'torrents/delete') {
      if (options.form.hashes === hash) throw new Error('private-key upstream failed');
      removed = other; return;
    }
    if (options.query.filter) return [missing, { ...missing, hash: other }];
    return options.query.hashes === removed ? [] : [{ ...missing, hash: options.query.hashes }];
  });
  const result = await qbt.cleanupMissingFiles({ dryRun: false });
  assert.equal(result.failedCount, 1); assert.equal(result.deletedCount, 1);
  assert.equal(JSON.stringify(result).includes('private-key'), false);
});

test('overlapping cleanups are rejected and the lock is released after failure', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const qbt = new QbittorrentService({}, async () => { await pending; throw new Error('list failed'); });
  const first = qbt.cleanupMissingFiles();
  await assert.rejects(qbt.cleanupMissingFiles(), error => error.status === 409);
  release(); await assert.rejects(first, /list failed/);
  await assert.rejects(qbt.cleanupMissingFiles(), /list failed/);
});

test('cleanup rejects invalid flags and completes empty previews without deleting', async () => {
  const qbt = new QbittorrentService({}, async path => { assert.equal(path, 'torrents/info'); return []; });
  await assert.rejects(qbt.cleanupMissingFiles({ dryRun: 'false' }), /dryRun/);
  assert.deepEqual(await qbt.cleanupMissingFiles({ dryRun: false }), {
    dryRun: false, deleteFiles: false, matchedCount: 0, deletedCount: 0, skippedCount: 0, failedCount: 0, items: [],
  });
});

test('cleanup does not report success when qBittorrent accepts delete but retains the task', async () => {
  const qbt = new QbittorrentService({}, async path => path === 'torrents/delete' ? undefined : [missing]);
  const result = await qbt.cleanupMissingFiles({ dryRun: false });
  assert.equal(result.deletedCount, 0); assert.equal(result.failedCount, 1);
  assert.match(result.items[0].error, /仍存在/);
});

test('malformed recheck or verification responses never count as absence', async () => {
  for (const stage of ['recheck', 'verify']) {
    for (const malformed of [undefined, null, { error: 'invalid body' }, [{ ...missing, hash: other }]]) {
      let deleteCalls = 0;
      const qbt = new QbittorrentService({}, async (path, options) => {
        if (path === 'torrents/delete') { deleteCalls++; return; }
        if (options.query.filter) return [missing];
        if (stage === 'recheck' || deleteCalls) return malformed;
        return [missing];
      });
      const result = await qbt.cleanupMissingFiles({ dryRun: false });
      assert.equal(result.deletedCount, 0); assert.equal(result.failedCount, 1);
      assert.equal(deleteCalls, stage === 'recheck' ? 0 : 1);
    }
  }
});

test('cleanup follows saved settings and rejects stale page confirmation before any upstream call', async () => {
  const modes = []; let removed = false;
  const qbt = new QbittorrentService({}, async (path, options) => {
    if (path === 'torrents/delete') { modes.push(options.form.deleteFiles); removed = true; return; }
    return removed ? [] : [missing];
  });
  assert.equal((await qbt.cleanupMissingFiles()).deleteFiles, false);
  qbt.saveCleanupSettings({ deleteFiles: true });
  await assert.rejects(qbt.cleanupMissingFiles({ dryRun: false, expectedDeleteFiles: false }), e => e.status === 409);
  assert.deepEqual(modes, []);
  assert.equal((await qbt.cleanupMissingFiles({ dryRun: false })).deletedCount, 1);
  assert.deepEqual(modes, [true]);
});
