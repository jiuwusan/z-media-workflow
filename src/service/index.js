import { QbittorrentService } from './qbittorrent.js';
import { JellyfinService } from './jellyfin.js';
import { DeepseekService } from './deepseek.js';
import { MediaLibraryService } from './media-library.js';
import { WorkflowService } from './workflow.js';
import { AuthService } from './auth.js';
export function createServices(config) {
  const services = { qbittorrent: new QbittorrentService(config), jellyfin: new JellyfinService(config), deepseek: new DeepseekService(config), auth: new AuthService(config) };
  services.mediaLibrary = new MediaLibraryService(config, services.jellyfin); services.workflow = new WorkflowService(config, services); return services;
}
