import { createHttpClient, sleep } from '../util/http.js';
import { AppError } from '../util/error.js';
import { normalizeName, providerEntries } from '../util/media.js';
// UpdateItem replaces these values, so load the editable DTO before changing identification.
const metadataFields = 'Path,ProviderIds,OriginalTitle,CustomRating,DateCreated,Genres,Overview,People,ProductionLocations,Settings,SortName,SpecialEpisodeNumbers,Studios,Taglines,Tags,AirTime,RemoteTrailers,MediaStreams';
function premiereYear(item) {
  const year = new Date(item.PremiereDate ?? '').getUTCFullYear();
  return Number.isInteger(year) && year >= 1800 && year <= new Date().getFullYear() + 5 ? year : undefined;
}
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
      const result = await this.http('Items', { query: { Recursive: true, IncludeItemTypes: 'Movie,Series', Fields: 'Path,ProviderIds,OriginalTitle,DateCreated', ...query, StartIndex: start, Limit: pageSize } });
      items.push(...result.Items); start += result.Items.length;
      if (start >= result.TotalRecordCount) break;
      if (!result.Items.length) throw new AppError('Jellyfin 分页返回异常', 502);
    }
    return items;
  }
  async item(id, { metadata = false } = {}) {
    // GetItem requires a user context on some servers; the global query supports API keys.
    const result = await this.http('Items', { query: { Ids: id, Fields: metadata ? metadataFields : 'Path,ProviderIds,OriginalTitle', Limit: 1 } });
    if (!result.Items?.length) throw new AppError('Jellyfin 媒体条目不存在', 404);
    return result.Items[0];
  }
  async search(item, identity) {
    const results = await this.http(`Items/RemoteSearch/${item.Type}`, { method: 'POST', json: { ItemId: item.Id, SearchInfo: { Name: identity.name, ...(identity.year === null ? {} : { Year: identity.year }) }, IncludeDisabledProviders: false } });
    return results.map(candidate => {
      if (candidate.ProductionYear != null) return candidate;
      // Series providers may emit only PremiereDate, although movies include ProductionYear.
      const year = premiereYear(candidate);
      return year === undefined ? candidate : { ...candidate, ProductionYear: year };
    });
  }
  async apply(id, candidate, expected) {
    // RemoteSearch/Apply waits for provider downloads; UpdateItem only saves local metadata.
    const item = await this.item(id, { metadata: true });
    if (typeof item.LockData !== 'boolean') throw new AppError('Jellyfin 未返回完整编辑设置，无法安全保存识别结果', 502);
    if (expected && (item.Path !== expected.Path || item.Type !== expected.Type)) throw new AppError('媒体路径或类型已变化，请重新扫描', 409);
    if (!candidate.Name?.trim() || !providerEntries(candidate).length) throw new AppError('候选缺少有效媒体名称或提供方 ID', 422);
    if (item.Type === 'Series') {
      // UpdateItem propagates parent ratings to children even when the ratings are unchanged.
      const children = await this.items({ ParentId: id, IncludeItemTypes: 'Season,Episode', Fields: 'CustomRating,Settings' });
      const wouldOverwrite = children.some(child => (child.CustomRating && child.CustomRating !== item.CustomRating) || (child.OfficialRating && child.OfficialRating !== item.OfficialRating && !child.LockedFields?.includes('OfficialRating')));
      if (wouldOverwrite) throw new AppError('季或集存在独立评级，无法安全保存节目识别结果，请先在 Jellyfin 处理评级设置', 409);
    }
    const update = { ...item, Name: candidate.Name, ProviderIds: structuredClone(candidate.ProviderIds), ...(candidate.ProductionYear == null ? {} : { ProductionYear: candidate.ProductionYear }) };
    await this.http(`Items/${encodeURIComponent(id)}`, { method: 'POST', json: update });
  }
  refreshItem(id, { full = false } = {}) { return this.http(`Items/${encodeURIComponent(id)}/Refresh`, { method: 'POST', query: { Recursive: true, MetadataRefreshMode: full ? 'FullRefresh' : 'Default', ImageRefreshMode: full ? 'FullRefresh' : 'Default', ReplaceAllMetadata: full, ReplaceAllImages: false } }); }
  async verify(id, candidate) {
    const expected = providerEntries(candidate);
    if (!expected.length) throw new AppError('候选缺少有效媒体提供方 ID', 422);
    const deadline = Date.now() + this.config.verifyTimeoutMs;
    while (Date.now() < deadline) {
      const item = await this.item(id), actual = new Map(providerEntries(item));
      const year = item.ProductionYear ?? (item.Type === 'Series' ? premiereYear(item) : undefined);
      if (expected.every(([k, v]) => actual.get(k) === v) && normalizeName(item.Name) === normalizeName(candidate.Name) && (!candidate.ProductionYear || year === candidate.ProductionYear)) {
        return year === undefined ? item : { ...item, ProductionYear: year };
      }
      await sleep(this.config.pollMs);
    }
    throw new AppError('媒体信息回读确认超时，尚未确认所选元数据', 504);
  }
}
