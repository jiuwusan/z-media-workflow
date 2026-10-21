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
import { CursorRepository } from '../storage/cursor-repository.js';
import { ConfigurationService } from './configuration.js';
import { RecoveryService } from './recovery.js';
export function createServices(config,{autoStart=true}={}) {
  const services = { qbittorrent: new QbittorrentService(config), jellyfin: new JellyfinService(config), deepseek: new DeepseekService(config), auth: new AuthService(config) };
  services.torrentNaming = new TorrentNamingService(config, services.qbittorrent, services.deepseek, [config.qbtKey, config.deepseekKey, config.adminPassword, config.workflowToken]);
  const database = config.store?.database ?? openWorkflowDatabase(path.join(config.dataDir??path.dirname(config.configFile), 'workflow.sqlite'));
  try {
    services.database=database;
    services.configuration=new ConfigurationService(config);
    if(config.store)services.recovery=new RecoveryService(config.store);
    services.mediaLibrary = new MediaLibraryService(config, services.jellyfin,new CursorRepository(database,config.jellyfinUrl));
    services.workflow = new WorkflowService(config, services, { repository: new WorkflowRepository(database, config),autoStart });
    services.close = async timeoutMs => { const drained = await services.workflow.close(timeoutMs); if (drained) database.close(); return drained; };
    return services;
  } catch (error) { database.close(); throw error; }
}
