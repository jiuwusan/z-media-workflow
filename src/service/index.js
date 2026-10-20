import { QbittorrentService } from './qbittorrent.js';
import { JellyfinService } from './jellyfin.js';
import { DeepseekService } from './deepseek.js';
import { MediaLibraryService } from './media-library.js';
import { WorkflowService } from './workflow.js';
import { AuthService } from './auth.js';
import { TorrentNamingService } from './torrent-naming.js';
import path from 'node:path';
import { openWorkflowDatabase } from '../storage/database.js';
import { WorkflowRepository } from '../storage/workflow-repository.js';
export function createServices(config) {
  const services = { qbittorrent: new QbittorrentService(config), jellyfin: new JellyfinService(config), deepseek: new DeepseekService(config), auth: new AuthService(config) };
  services.torrentNaming = new TorrentNamingService(config, services.qbittorrent, services.deepseek, [config.qbtKey, config.deepseekKey, config.adminPassword, config.workflowToken]);
  const database = openWorkflowDatabase(path.join(path.dirname(config.configFile), 'workflow.sqlite'));
  try {
    services.mediaLibrary = new MediaLibraryService(config, services.jellyfin);
    services.workflow = new WorkflowService(config, services, { repository: new WorkflowRepository(database, config) });
    services.close = async timeoutMs => { const drained = await services.workflow.close(timeoutMs); if (drained) database.close(); return drained; };
    return services;
  } catch (error) { database.close(); throw error; }
}
