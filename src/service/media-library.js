import path from 'node:path';
import { AppError } from '../util/error.js';
import { containsPath, isVideo, mapPath, normalizePath } from '../util/media.js';
import { MediaCursorStore } from '../util/media-cursor.js';
export class MediaLibraryService {
  constructor(config, jellyfin, cursors = new MediaCursorStore(config.mediaCursorFile, config.jellyfinUrl)) { this.config = config; this.jellyfin = jellyfin; this.cursors = cursors; }
  async track(items, filters = {}) {
    // A first selective scan must not move the cursor past unselected older media.
    const scope = filters.itemIds?.length ? await this.scopedItems({ libraryId: filters.libraryId, type: filters.type }) : items;
    this.cursors.track(scope);
  }
  markIdentified(item) { this.cursors.confirm(item); }
  async libraries() {
    const all = await this.jellyfin.libraries();
    return all.filter(lib => ['tvshows', 'movies'].includes(lib.CollectionType));
  }
  async scopedItems({ libraryId, type, itemIds } = {}) {
    let libraries = await this.libraries();
    if (libraryId) {
      libraries = libraries.filter(l => l.ItemId === libraryId);
      if (!libraries.length) throw new AppError('该媒体库已删除或不属于电影/电视剧类型');
    }
    if (type) libraries = libraries.filter(l => l.CollectionType === (type === 'Movie' ? 'movies' : 'tvshows'));
    const items = (await Promise.all(libraries.map(async lib => (await this.jellyfin.items({ ParentId: lib.ItemId, IncludeItemTypes: lib.CollectionType === 'movies' ? 'Movie' : 'Series', SortBy: 'DateCreated', SortOrder: 'Descending' })).filter(i => lib.Locations?.some(root => containsPath(root, i.Path))).map(i => ({ ...i, LibraryId: lib.ItemId }))))).flat();
    if (itemIds) {
      if (itemIds.some(id => !items.some(i => i.Id === id))) throw new AppError('选择的媒体不在目标库内', 400);
      return items.filter(i => itemIds.includes(i.Id));
    }
    return items;
  }
  async unidentified({ page = 1, pageSize = 200, ...filters } = {}) {
    const items = (await this.scopedItems(filters)).filter(i => this.cursors.needsIdentification(i));
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
  }
  async ensureItem(id, filters = {}) {
    const item = (await this.scopedItems({ ...filters, itemIds: [id] }))[0];
    if (!item) throw new AppError('媒体条目不存在', 404);
    return item;
  }
  async forTorrent(torrent, files, type) {
    const videoPaths = files.filter(f => f.priority !== 0 && isVideo(f.name)).map(f => {
      const full = /^(\/|[a-z]:[\\/])/i.test(f.name) ? f.name : `${torrent.save_path}/${f.name}`;
      return mapPath(full, this.config.pathMapping);
    });
    if (!videoPaths.length && isVideo(torrent.content_path)) videoPaths.push(mapPath(torrent.content_path, this.config.pathMapping));
    if (!videoPaths.length) throw new AppError('下载内容没有支持的视频文件', 422);
    const matches = (item, file) => item.Type === 'Series' ? containsPath(item.Path, file) : normalizePath(item.Path) === file;
    const items = (await this.scopedItems({ type })).filter(item => videoPaths.some(file => matches(item, file)));
    return { items, missingPaths: [...new Set(videoPaths.filter(file => !items.some(item => matches(item, file))))] };
  }
}
