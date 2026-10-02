import { createHttpClient, sleep } from '../util/http.js';
import { AppError } from '../util/error.js';
import { normalizeName, providerEntries } from '../util/media.js';
export class JellyfinService {
  constructor(config, http) {
    this.config = config;
    this.http = http ?? createHttpClient({ baseUrl: config.jellyfinUrl, headers: { 'X-Emby-Token': config.jellyfinKey }, timeoutMs: config.requestTimeoutMs });
  }
  info() { return this.http('System/Info'); }
  libraries() { return this.http('Library/VirtualFolders'); }
  tasks() { return this.http('ScheduledTasks'); }
  async scanTask() {
    const task = (await this.tasks()).find(t => t.Key === 'RefreshLibrary');
    if (!task) throw new AppError('Jellyfin 未提供媒体库扫描任务', 502);
    return task;
  }
  async refreshAndWait() {
    const deadline = Date.now() + this.config.scanTimeoutMs;
    let before = await this.scanTask();
    while (before.State !== 'Idle') {
      if (Date.now() >= deadline) throw new AppError('等待已有扫描超时', 504);
      await sleep(this.config.pollMs); before = await this.scanTask();
    }
    const previousEnd = before.LastExecutionResult?.EndTimeUtc;
    await this.http('Library/Refresh', { method: 'POST' });
    while (Date.now() < deadline) {
      const current = await this.scanTask();
      const result = current.LastExecutionResult;
      // A fresh completion record is required, even when a short scan stays Idle between polls.
      if (current.State === 'Idle' && result?.EndTimeUtc && result.EndTimeUtc !== previousEnd) {
        if (result.Status !== 'Completed') throw new AppError(`Jellyfin 扫描失败：${result.Status}`, 502);
        return result;
      }
      await sleep(this.config.pollMs);
    }
    throw new AppError('Jellyfin 扫描超时', 504);
  }
  async items({ pageSize = 200, ...query } = {}) {
    const items = [];
    for (let start = 0; ; ) {
      const result = await this.http('Items', { query: { Recursive: true, IncludeItemTypes: 'Movie,Series', Fields: 'Path,ProviderIds,OriginalTitle', ...query, StartIndex: start, Limit: pageSize } });
      items.push(...result.Items); start += result.Items.length;
      if (start >= result.TotalRecordCount) break;
      if (!result.Items.length) throw new AppError('Jellyfin 分页返回异常', 502);
    }
    return items;
  }
  async item(id) {
    // GetItem requires a user context on some servers; the global query supports API keys.
    const result = await this.http('Items', { query: { Ids: id, Fields: 'Path,ProviderIds,OriginalTitle', Limit: 1 } });
    if (!result.Items?.length) throw new AppError('Jellyfin 媒体条目不存在', 404);
    return result.Items[0];
  }
  async search(item, identity) {
    const results = await this.http(`Items/RemoteSearch/${item.Type}`, { method: 'POST', json: { ItemId: item.Id, SearchInfo: { Name: identity.name, ...(identity.year === null ? {} : { Year: identity.year }) }, IncludeDisabledProviders: false } });
    return results.map(candidate => {
      if (candidate.ProductionYear != null) return candidate;
      // Series providers may emit only PremiereDate, although movies include ProductionYear.
      const year = new Date(candidate.PremiereDate ?? '').getUTCFullYear();
      return Number.isInteger(year) && year >= 1800 && year <= new Date().getFullYear() + 5 ? { ...candidate, ProductionYear: year } : candidate;
    });
  }
  async apply(id, candidate) {
    await this.http(`Items/RemoteSearch/Apply/${encodeURIComponent(id)}`, { method: 'POST', query: { ReplaceAllImages: false }, json: candidate });
  }
  refreshItem(id) { return this.http(`Items/${encodeURIComponent(id)}/Refresh`, { method: 'POST', query: { Recursive: true, MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', ReplaceAllMetadata: false, ReplaceAllImages: false } }); }
  async verify(id, candidate) {
    const expected = providerEntries(candidate);
    if (!expected.length) throw new AppError('候选缺少有效媒体提供方 ID', 422);
    const deadline = Date.now() + this.config.verifyTimeoutMs;
    while (Date.now() < deadline) {
      const item = await this.item(id), actual = new Map(providerEntries(item));
      if (expected.every(([k, v]) => actual.get(k) === v) && normalizeName(item.Name) === normalizeName(candidate.Name) && (!candidate.ProductionYear || item.ProductionYear === candidate.ProductionYear)) return item;
      await sleep(this.config.pollMs);
    }
    throw new AppError('媒体信息回读确认超时，尚未确认所选元数据', 504);
  }
}
