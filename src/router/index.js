import Router from '@koa/router';
import { authController } from '../controller/auth.js';
import { workflowController } from '../controller/workflow.js';
import { qbittorrentController } from '../controller/qbittorrent.js';
import { systemController } from '../controller/system.js';
import { ConfigurationService } from '../service/configuration.js';
import { configurationController } from '../controller/configuration.js';
import { lifecycleController } from '../controller/lifecycle.js';
import { pagination } from '../util/validation.js';
export function createRouter(config, services) {
  const router = new Router();
  const auth = authController(config, services.auth), workflow = workflowController(services.workflow, services.mediaLibrary, services.jellyfin), qbt = qbittorrentController(services.qbittorrent, config), system = systemController(config, services);
  const admin = async (ctx, next) => { services.auth.authenticate(ctx); await next(); };
  const webhook = async (ctx, next) => { services.auth.authenticate(ctx, true); await next(); };
  const cleanupAuth = async (ctx, next) => !ctx.get('Authorization') && ctx.cookies.get('media_session', { signed: false }) ? admin(ctx, next) : webhook(ctx, next);
  services.configuration ??= new ConfigurationService(config);
  const configuration = configurationController(services.configuration);
  const lifecycle = lifecycleController(services);
  router.get('/health', lifecycle.health);
  router.get('/api/service/status', admin, lifecycle.status);
  router.post('/api/service/restart', admin, lifecycle.restart);
  router.post('/api/auth/login', auth.login);
  if(services.recovery){
    router.get('/api/auth/recovery/context',ctx=>{ctx.body={data:services.recovery.context(ctx)};});
    router.post('/api/auth/recovery/verify',ctx=>{services.recovery.csrf(ctx);ctx.body={data:services.recovery.verify(ctx.request.body?.passkey,ctx.ip)};});
    router.post('/api/auth/recovery/reset',ctx=>{services.recovery.csrf(ctx);const b=ctx.request.body??{};ctx.body={data:services.recovery.reset(b.token,b.password,b.confirmPassword,ctx.ip)};});
  }
  router.get('/api/auth/session', admin, auth.session);
  router.post('/api/auth/logout', admin, auth.logout);
  router.get('/api/dashboard', admin, system.dashboard);
  router.post('/api/connections/check', admin, system.check);
  router.get('/api/notifications/context', admin, system.notifications);
  router.get('/api/config', admin, configuration.get);
  router.get('/api/config/history',admin,ctx=>{ctx.body={data:services.configuration.store.audit.list(pagination(ctx.query))};});
  router.put('/api/config', admin, configuration.save);
  router.get('/api/qbittorrent/completion-notification', admin, qbt.completionNotification);
  router.get('/api/qbittorrent/added-notification', admin, qbt.addedNotification);
  if(services.qbittorrent?.history){
    router.get('/api/qbittorrent/cleanup-history',admin,ctx=>{ctx.body={data:services.qbittorrent.history.list(pagination(ctx.query))};});
    router.get('/api/qbittorrent/cleanup-history/:id',admin,ctx=>{
      if(!/^[1-9][0-9]*$/.test(ctx.params.id)||!Number.isSafeInteger(Number(ctx.params.id)))ctx.throw(400,'清理记录 ID 无效');
      ctx.body={data:services.qbittorrent.history.get(Number(ctx.params.id))};
    });
  }
  router.put('/api/qbittorrent/added-notification', admin, qbt.setAddedNotification);
  router.put('/api/qbittorrent/completion-notification', admin, qbt.setCompletionNotification);
  router.get('/api/qbittorrent/rss', admin, qbt.rss);
  router.get('/api/qbittorrent/torrents', admin, qbt.torrents);
  router.get('/api/qbittorrent/naming-settings', admin, qbt.namingSettings);
  router.put('/api/qbittorrent/naming-settings', admin, qbt.saveNamingSettings);
  router.get('/api/qbittorrent/cleanup-settings', admin, qbt.cleanupSettings);
  router.put('/api/qbittorrent/cleanup-settings', admin, qbt.saveCleanupSettings);
  router.post('/api/qbittorrent/cleanup-missing-files', cleanupAuth, qbt.cleanupMissingFiles);
  router.get('/api/qbittorrent/categories', admin, qbt.categories);
  router.get('/api/qbittorrent/rss/rules', admin, qbt.rules);
  router.post('/api/qbittorrent/rss/feeds', admin, qbt.addFeed);
  router.delete('/api/qbittorrent/rss/feeds', admin, qbt.removeFeed);
  router.post('/api/qbittorrent/rss/refresh', admin, qbt.refresh);
  router.put('/api/qbittorrent/rss/rules/:name', admin, qbt.setRule);
  router.delete('/api/qbittorrent/rss/rules/:name', admin, qbt.removeRule);
  router.post('/api/webhooks/qbittorrent/completed', webhook, workflow.completed);
  router.post('/api/webhooks/qbittorrent/added', webhook, workflow.added);
  router.get('/api/media/unidentified', admin, workflow.unidentified);
  router.get('/api/media/libraries', admin, workflow.libraries);
  router.get('/api/media/items', admin, workflow.media);
  router.get('/api/media/:itemId/poster', admin, workflow.poster);
  router.post('/api/media/:itemId/identify', admin, workflow.identify);
  router.get('/api/workflows', admin, workflow.list);
  router.post('/api/workflows/scan', admin, workflow.scan);
  router.post('/api/workflows/check-torrents', admin, workflow.checkTorrents);
  router.get('/api/workflows/:jobId', admin, workflow.get);
  router.post('/api/workflows/:jobId/retry', admin, workflow.retry);
  router.post('/api/workflows/:jobId/confirm', admin, workflow.confirm);
  router.post('/api/workflows/:jobId/search', admin, workflow.search);
  return router;
}
