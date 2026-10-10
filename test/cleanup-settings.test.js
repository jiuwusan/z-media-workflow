import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CleanupSettingsStore } from '../src/util/cleanup-settings.js';

test('cleanup settings default to preserving files and persist across reloads', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'cleanup-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const store = new CleanupSettingsStore(file);
  assert.deepEqual(store.get(), { deleteFiles: false });
  store.set({ deleteFiles: true });
  assert.deepEqual(new CleanupSettingsStore(file).get(), { deleteFiles: true });
  store.set({ deleteFiles: false });
  assert.deepEqual(new CleanupSettingsStore(file).get(), { deleteFiles: false });
  const copy = store.get(); copy.deleteFiles = true;
  assert.equal(store.get().deleteFiles, false);
});

test('invalid settings and persistence errors do not change active settings', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'cleanup-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  writeFileSync(file, '{"deleteFiles":"true"}');
  assert.throws(() => new CleanupSettingsStore(file), /配置文件无效/);
  const store = new CleanupSettingsStore(path.join(file, 'child.json'));
  assert.throws(() => store.set({ deleteFiles: true }));
  assert.equal(store.get().deleteFiles, false);
  assert.throws(() => store.set({ deleteFiles: 'true' }), /布尔值/);
});
