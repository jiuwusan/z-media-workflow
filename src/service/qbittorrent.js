import { createHttpClient, sleep } from '../util/http.js';
import { AppError } from '../util/error.js';
import { redact } from '../util/logger.js';
import { CleanupSettingsStore } from '../util/cleanup-settings.js';
export class QbittorrentService {
  constructor(config, http) { this.cleanupStore = new CleanupSettingsStore(config.cleanupSettingsFile); this.cleanupSecret = config.qbtKey; this.http = http ?? createHttpClient({ baseUrl: `${config.qbtUrl}api/v2/`, headers: { Authorization: `Bearer ${config.qbtKey}` }, timeoutMs: config.requestTimeoutMs }); }
  version() { return this.http('app/version'); }
  async addedNotification() {
    const prefs = await this.http('app/preferences');
    return { enabled: prefs.autorun_on_torrent_added_enabled === true, program: prefs.autorun_on_torrent_added_program ?? '' };
  }
  async setAddedNotification({ enabled, program }) {
    await this.http('app/setPreferences', { method: 'POST', form: { json: JSON.stringify({ autorun_on_torrent_added_enabled: enabled, autorun_on_torrent_added_program: program }) } });
    const saved = await this.addedNotification();
    if (saved.enabled !== enabled || saved.program !== program) throw new AppError('qBittorrent 新增通知设置回读不一致，请重新读取配置', 502);
    return saved;
  }
  renameFile(hash, oldPath, newPath) { return this.http('torrents/renameFile', { method: 'POST', form: { hash, oldPath, newPath } }); }
  async completionNotification() {
    const prefs = await this.http('app/preferences');
    return { enabled: prefs.autorun_enabled === true, program: prefs.autorun_program ?? '' };
  }
  async setCompletionNotification({ enabled, program }) {
    await this.http('app/setPreferences', { method: 'POST', form: { json: JSON.stringify({ autorun_enabled: enabled, autorun_program: program }) } });
    const saved = await this.completionNotification();
    if (saved.enabled !== enabled || saved.program !== program) throw new AppError('qBittorrent 通知设置回读不一致，请重新读取配置', 502);
    return saved;
  }
  async torrent(hash) {
    const list = await this.http('torrents/info', { query: { hashes: hash } });
    if (!Array.isArray(list)) throw new AppError('qBittorrent 种子回读响应无效', 502);
    if (!list.length) throw new AppError('找不到该 torrent', 404);
    const torrent = list.find(item => typeof item?.hash === 'string' && item.hash.toLowerCase() === hash.toLowerCase());
    if (!torrent) throw new AppError('qBittorrent 回读的 torrent hash 不匹配', 502);
    return torrent;
  }
  files(hash) { return this.http('torrents/files', { query: { hash } }); }
  torrents() { return this.http('torrents/info', { query: { filter: 'all' } }); }
  cleanupSettings() { return this.cleanupStore.get(); }
  saveCleanupSettings(settings) { return this.cleanupStore.set(settings); }
  async cleanupMissingFiles({ dryRun = true, deleteFiles = this.cleanupSettings().deleteFiles, expectedDeleteFiles } = {}) {
    if (typeof dryRun !== 'boolean') throw new AppError('dryRun 必须为布尔值');
    if (typeof deleteFiles !== 'boolean') throw new AppError('deleteFiles 必须为布尔值');
    if (expectedDeleteFiles !== undefined && expectedDeleteFiles !== deleteFiles) throw new AppError('清理设置已变化，请重新读取并确认', 409);
    if (this.cleanupRunning) throw new AppError('种子清理正在执行，请稍后重试', 409);
    this.cleanupRunning = true;
    try {
      const torrents = await this.torrents();
      if (!Array.isArray(torrents)) throw new AppError('qBittorrent 种子列表无效', 502);
      const candidates = torrents.filter(torrent => torrent?.state === 'missingFiles');
      if (candidates.some(torrent => typeof torrent.hash !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(torrent.hash))) throw new AppError('qBittorrent 返回了无效的 torrent hash', 502);
      const unique = [...new Map(candidates.map(torrent => [torrent.hash.toLowerCase(), torrent])).values()];
      const result = { dryRun, deleteFiles, matchedCount: unique.length, deletedCount: 0, skippedCount: 0, failedCount: 0, items: [] };
      for (const torrent of unique) {
        const hash = torrent.hash.toLowerCase();
        const entry = { hash, name: torrent.name, state: 'missingFiles', status: 'would_delete' };
        result.items.push(entry);
        if (dryRun) continue;
        try {
          let current;
          try { current = await this.torrent(hash); }
          catch (error) { if (error.status !== 404) throw error; }
          if (!current || current.state !== 'missingFiles') {
            entry.status = 'skipped'; entry.reason = current ? '种子状态已恢复或变化' : '种子已不存在';
            result.skippedCount++; continue;
          }
          let deleteError;
          try { await this.http('torrents/delete', { method: 'POST', form: { hashes: hash, deleteFiles } }); }
          catch (error) { deleteError = error; }
          let removed = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            try { await this.torrent(hash); }
            catch (error) { if (error.status !== 404) throw error; removed = true; break; }
            if (attempt < 2) await sleep(200);
          }
          if (!removed) throw deleteError ?? new AppError('删除后种子仍存在，未能确认清理完成', 502);
          entry.status = 'deleted'; result.deletedCount++;
        } catch (error) {
          entry.status = 'failed'; entry.error = redact(error.message, [this.cleanupSecret]); result.failedCount++;
        }
      }
      return result;
    } finally { this.cleanupRunning = false; }
  }
  categories() { return this.http('torrents/categories'); }
  rss() { return this.http('rss/items', { query: { withData: true } }); }
  rules() { return this.http('rss/rules'); }
  addFeed(url, path = '') { return this.http('rss/addFeed', { method: 'POST', form: { url, path } }); }
  removeFeed(path) { return this.http('rss/removeItem', { method: 'POST', form: { path } }); }
  refresh(path = '') { return this.http('rss/refreshItem', { method: 'POST', form: { itemPath: path } }); }
  async setRule(name, patch) {
    // setRule replaces the native rule, so merge its history and unexposed options first.
    const existing = (await this.rules())[name] ?? {};
    const merged = { ...existing, ...patch };
    if (existing.torrentParams) {
      merged.torrentParams = { ...existing.torrentParams };
      for (const [legacy, native] of [['savePath', 'save_path'], ['assignedCategory', 'category'], ['addPaused', 'stopped']]) {
        if (Object.hasOwn(patch, legacy)) merged.torrentParams[native] = patch[legacy];
      }
      if (patch.savePath) merged.torrentParams.use_auto_tmm = false;
    }
    return this.http('rss/setRule', { method: 'POST', form: { ruleName: name, ruleDef: JSON.stringify(merged) } });
  }
  removeRule(name) { return this.http('rss/removeRule', { method: 'POST', form: { ruleName: name } }); }
}
