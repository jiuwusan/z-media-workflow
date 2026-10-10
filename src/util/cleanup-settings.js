import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from './error.js';
import { readConfigFile, writeConfigFile } from './config-file.js';

export class CleanupSettingsStore {
  constructor(filename, legacyFilename) {
    this.filename = filename ? path.resolve(filename) : null;
    this.settings = { deleteFiles: false };
    this.document = this.readDocument();
    if (this.document.torrentCleanup !== undefined) {
      this.settings = { deleteFiles: this.document.torrentCleanup.deleteFiles };
    } else if (this.filename && legacyFilename && existsSync(legacyFilename)) {
      try {
        const saved = JSON.parse(readFileSync(legacyFilename, 'utf8'));
        if (!saved || Array.isArray(saved) || typeof saved.deleteFiles !== 'boolean') throw new Error('invalid settings');
        this.set({ deleteFiles: saved.deleteFiles });
      } catch { throw new AppError('旧清理配置文件无效或迁移失败，请修复后重新启动', 500); }
    }
  }
  readDocument() {
    if (!this.filename || !existsSync(this.filename)) return this.document ?? {};
    try {
      const saved = readConfigFile(this.filename);
      if (saved.torrentCleanup !== undefined && (!saved.torrentCleanup || Array.isArray(saved.torrentCleanup) || typeof saved.torrentCleanup.deleteFiles !== 'boolean')) throw new Error('invalid cleanup settings');
      return saved;
    } catch { throw new AppError('config.json 配置文件无效，请修复后重新启动', 500); }
  }
  get() { return { ...this.settings }; }
  set(settings) {
    if (!settings || typeof settings.deleteFiles !== 'boolean') throw new AppError('deleteFiles 必须为布尔值');
    const next = { deleteFiles: settings.deleteFiles };
    const current = this.readDocument();
    const document = { ...current, torrentCleanup: { ...current.torrentCleanup, ...next } };
    if (this.filename) {
      writeConfigFile(this.filename, document);
    }
    this.document = document;
    this.settings = next;
    return this.get();
  }
}
