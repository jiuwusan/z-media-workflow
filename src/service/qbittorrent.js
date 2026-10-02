import { createHttpClient } from '../util/http.js';
import { AppError } from '../util/error.js';
export class QbittorrentService {
  constructor(config, http) { this.http = http ?? createHttpClient({ baseUrl: `${config.qbtUrl}api/v2/`, headers: { Authorization: `Bearer ${config.qbtKey}` }, timeoutMs: config.requestTimeoutMs }); }
  version() { return this.http('app/version'); }
  async torrent(hash) {
    const list = await this.http('torrents/info', { query: { hashes: hash } });
    if (!list?.length) throw new AppError('找不到该 torrent', 404);
    return list[0];
  }
  files(hash) { return this.http('torrents/files', { query: { hash } }); }
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
