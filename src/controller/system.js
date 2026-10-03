import { redact } from '../util/logger.js';
export function systemController(config, services) {
  return {
    async dashboard(ctx) {
      ctx.body = { data: { ...services.workflow.summary(), libraries: await services.mediaLibrary.libraries(), connections: {
        qbittorrent: { url: config.qbtUrl, configured: Boolean(config.qbtKey) }, jellyfin: { url: config.jellyfinUrl, configured: Boolean(config.jellyfinKey) }, deepseek: { url: config.deepseekUrl, configured: Boolean(config.deepseekKey), model: config.deepseekModel }
      }, pathMapping: config.pathMapping, callbackUrl: `${config.publicUrl.replace(/\/$/, '')}/api/webhooks/qbittorrent/completed`, webhookAuthRequired: config.webhookAuthRequired !== false } };
    },
    async check(ctx) {
      const calls = { qbittorrent: () => services.qbittorrent.version(), jellyfin: async () => ({ version: (await services.jellyfin.info()).Version }), deepseek: async () => ({ models: (await services.deepseek.models()).data.map(m => m.id) }) };
      const entries = await Promise.all(Object.entries(calls).map(async ([name, call]) => {
        try { return [name, { ok: true, result: await call() }]; } catch (e) { return [name, { ok: false, error: redact(e.message, [config.qbtKey, config.jellyfinKey, config.deepseekKey]) }]; }
      }));
      ctx.body = { data: Object.fromEntries(entries) };
    }
  };
}
