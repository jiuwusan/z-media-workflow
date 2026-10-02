import path from 'node:path';
import { AppError } from '../util/error.js';
import { containsPath, hasIdentity, isVideo, mapPath, normalizePath } from '../util/media.js';
export class MediaLibraryService {
  constructor(config, jellyfin) { this.config = config; this.jellyfin = jellyfin; }
  async libraries() {
    const all = await this.jellyfin.libraries();
    return all.filter(lib => (lib.CollectionType === 'tvshows' && (!this.config.seriesLibraryId || lib.ItemId === this.config.seriesLibraryId)) || (lib.CollectionType === 'movies' && (!this.config.movieLibraryId || lib.ItemId === this.config.movieLibraryId)));
  }
  async scopedItems({ libraryId, type, itemIds } = {}) {
    let libraries = await this.libraries();
    if (libraryId) {
      libraries = libraries.filter(l => l.ItemId === libraryId);
      if (!libraries.length) throw new AppError('该媒体库不在配置的电影/电视剧范围内');
    }
    if (type) libraries = libraries.filter(l => l.CollectionType === (type === 'Movie' ? 'movies' : 'tvshows'));
    const items = (await Promise.all(libraries.map(async lib => (await this.jellyfin.items({ ParentId: lib.ItemId, IncludeItemTypes: lib.CollectionType === 'movies' ? 'Movie' : 'Series' })).filter(i => lib.Locations?.some(root => containsPath(root, i.Path))).map(i => ({ ...i, LibraryId: lib.ItemId }))))).flat();
    if (itemIds) {
      if (itemIds.some(id => !items.some(i => i.Id === id))) throw new AppError('选择的媒体不在目标库内', 400);
      return items.filter(i => itemIds.includes(i.Id));
    }
    return items;
  }
  async unidentified({ page = 1, pageSize = 200, ...filters } = {}) {
    const items = (await this.scopedItems(filters)).filter(i => !hasIdentity(i));
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
  }
  async ensureItem(id) {
    const item = (await this.scopedItems({ itemIds: [id] }))[0];
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
