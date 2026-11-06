import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const dateOf = item => {
  const value = Date.parse(item.DateCreated ?? '');
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
};
export class MediaCursorStore {
  constructor(filename, server = '') {
    this.filename = filename ? path.resolve(filename) : null;
    this.server = server;
    this.state = { version: 1, libraries: {} };
    if (this.filename && existsSync(this.filename)) {
      try {
        const state = JSON.parse(readFileSync(this.filename, 'utf8'));
        if (state.version !== 1 || !state.libraries || Array.isArray(state.libraries) || typeof state.libraries !== 'object') throw new Error('invalid format');
        for (const cursor of Object.values(state.libraries)) {
          if (!cursor || !(cursor.date === null || (typeof cursor.date === 'string' && Number.isFinite(Date.parse(cursor.date)))) || !['ids', 'pending', 'undated'].every(key => Array.isArray(cursor[key]) && cursor[key].every(id => typeof id === 'string'))) throw new Error('invalid cursor');
        }
        this.state = state;
      } catch { throw new Error('媒体识别游标文件无效，请修复文件后重新启动'); }
    }
  }
  key(item) { return JSON.stringify([this.server, item.LibraryId, item.Type]); }
  needsIdentification(item) {
    const cursor = this.state.libraries[this.key(item)], date = dateOf(item);
    if (!cursor || cursor.pending.includes(item.Id)) return true;
    if (!date) return !cursor.undated.includes(item.Id);
    return !cursor.date || date > cursor.date || (date === cursor.date && !cursor.ids.includes(item.Id));
  }
  update(change) {
    const next = structuredClone(this.state);
    if (!change(next)) return;
    if (this.filename) {
      mkdirSync(path.dirname(this.filename), { recursive: true });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        const fd = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify(next, null, 2), 'utf8'); fsyncSync(fd); }
        finally { closeSync(fd); }
        renameSync(temporary, this.filename);
      } finally { rmSync(temporary, { force: true }); }
    }
    this.state = next;
  }
  track(items) {
    // Persist the complete batch before advancing any cursor, including older failures.
    this.update(state => {
      let changed = false;
      for (const item of items) {
        if (!this.needsIdentification(item)) continue;
        const cursor = state.libraries[this.key(item)] ??= { date: null, ids: [], pending: [], undated: [] };
        if (!cursor.pending.includes(item.Id)) { cursor.pending.push(item.Id); changed = true; }
      }
      return changed;
    });
  }
  confirm(item) {
    if (!this.needsIdentification(item)) return;
    this.update(state => {
      const cursor = state.libraries[this.key(item)];
      if (!cursor?.pending.includes(item.Id)) throw new Error('媒体尚未登记到识别游标，请重新扫描');
      const date = dateOf(item);
      cursor.pending = cursor.pending.filter(id => id !== item.Id);
      if (!date) { if (!cursor.undated.includes(item.Id)) cursor.undated.push(item.Id); }
      else if (!cursor.date || date > cursor.date) { cursor.date = date; cursor.ids = [item.Id]; }
      else if (date === cursor.date && !cursor.ids.includes(item.Id)) cursor.ids.push(item.Id);
      return true;
    });
  }
}
