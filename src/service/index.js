import { QbittorrentService } from './qbittorrent.js';
import { JellyfinService } from './jellyfin.js';
import { DeepseekService } from './deepseek.js';
import { MediaLibraryService } from './media-library.js';
import { WorkflowService } from './workflow.js';
import { AuthService } from './auth.js';
import { TorrentNamingService } from './torrent-naming.js';
export function createServices(config) {
  const services = { qbittorrent: new QbittorrentService(config), jellyfin: new JellyfinService(config), deepseek: new DeepseekService(config), auth: new AuthService(config) };
  services.torrentNaming = new TorrentNamingService(config, services.qbittorrent, services.deepseek, [config.qbtKey, config.deepseekKey, config.adminPassword, config.workflowToken]);
  services.mediaLibrary = new MediaLibraryService(config, services.jellyfin); services.workflow = new WorkflowService(config, services); return services;
}
