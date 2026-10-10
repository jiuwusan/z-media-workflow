import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './error.js';

export class CleanupSettingsStore {
  constructor(filename) {
    this.filename = filename ? path.resolve(filename) : null;
    this.settings = { deleteFiles: false };
    if (this.filename && existsSync(this.filename)) {
      try {
        const saved = JSON.parse(readFileSync(this.filename, 'utf8'));
        if (!saved || typeof saved.deleteFiles !== 'boolean') throw new Error('invalid settings');
        this.settings = { deleteFiles: saved.deleteFiles };
      } catch { throw new AppError('种子清理配置文件无效，请修复后重新启动', 500); }
    }
  }
  get() { return { ...this.settings }; }
  set(settings) {
    if (!settings || typeof settings.deleteFiles !== 'boolean') throw new AppError('deleteFiles 必须为布尔值');
    const next = { deleteFiles: settings.deleteFiles };
    if (this.filename) {
      mkdirSync(path.dirname(this.filename), { recursive: true });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        renameSync(temporary, this.filename);
      } finally { rmSync(temporary, { force: true }); }
    }
    this.settings = next;
    return this.get();
  }
}
