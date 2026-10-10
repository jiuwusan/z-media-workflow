import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
  writeFileSync(file, '{"torrentCleanup":{"deleteFiles":"true"}}');
  assert.throws(() => new CleanupSettingsStore(file), /配置文件无效/);
  const store = new CleanupSettingsStore(path.join(file, 'child.json'));
  assert.throws(() => store.set({ deleteFiles: true }));
  assert.equal(store.get().deleteFiles, false);
  assert.throws(() => store.set({ deleteFiles: 'true' }), /布尔值/);
});

test('config.json preserves other settings and cleanup fields when saving the switch', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'cleanup-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json');
  writeFileSync(file, JSON.stringify({ other: { enabled: true }, torrentCleanup: { deleteFiles: true, future: 3 } }));
  const store = new CleanupSettingsStore(file);
  assert.equal(store.get().deleteFiles, true);
  writeFileSync(file, JSON.stringify({ other: { enabled: false }, torrentCleanup: { deleteFiles: true, future: 3 } }));
  store.set({ deleteFiles: false });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { other: { enabled: false }, torrentCleanup: { deleteFiles: false, future: 3 } });
});

test('old cleanup settings migrate into config.json without removing the original', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'cleanup-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json'), legacy = path.join(root, 'cleanup-settings.json');
  writeFileSync(legacy, '{"deleteFiles":true}');
  const store = new CleanupSettingsStore(file, legacy);
  assert.deepEqual(store.get(), { deleteFiles: true });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { torrentCleanup: { deleteFiles: true } });
  assert.equal(existsSync(legacy), true);
  store.set({ deleteFiles: false });
  assert.equal(new CleanupSettingsStore(file, legacy).get().deleteFiles, false);
});

test('legacy settings fill a missing cleanup section but never override config.json', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'cleanup-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json'), legacy = path.join(root, 'cleanup-settings.json');
  writeFileSync(file, '{"other":123}'); writeFileSync(legacy, '{"deleteFiles":true}');
  new CleanupSettingsStore(file, legacy);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { other: 123, torrentCleanup: { deleteFiles: true } });
  writeFileSync(legacy, 'invalid');
  assert.equal(new CleanupSettingsStore(file, legacy).get().deleteFiles, true);
});

test('malformed config or legacy files fail explicitly instead of resetting settings', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'cleanup-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json'), legacy = path.join(root, 'cleanup-settings.json');
  for (const value of ['[]', 'null', '{"torrentCleanup":null}', '{"torrentCleanup":{"deleteFiles":1}}']) {
    writeFileSync(file, value);
    assert.throws(() => new CleanupSettingsStore(file), /配置文件无效/);
  }
  rmSync(file); writeFileSync(legacy, '{"deleteFiles":"true"}');
  assert.throws(() => new CleanupSettingsStore(file, legacy), /配置文件无效/);
  assert.equal(existsSync(file), false);
});
