import Koa from 'koa';
import { bodyParser } from '@koa/bodyparser';
import serve from 'koa-static';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRouter } from './router/index.js';
import { createServices } from './service/index.js';
import { AuthService } from './service/auth.js';
import { redact, log } from './util/logger.js';
export function createApp({ config, services = createServices(config) }) {
  services.auth ??= new AuthService(config);
  const app = new Koa(); app.proxy = config.trustProxy;
  const secrets = [config.qbtKey, config.jellyfinKey, config.deepseekKey, config.adminPassword, config.workflowToken];
  app.use(async (ctx, next) => {
    ctx.set('X-Content-Type-Options', 'nosniff'); ctx.set('X-Frame-Options', 'DENY'); ctx.set('Referrer-Policy', 'same-origin');
    ctx.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    if (ctx.path.startsWith('/api')) ctx.set('Cache-Control', 'no-store');
    try { await next(); }
    catch (e) { ctx.status = e.status ?? 500; const message = e.status ? redact(e.message, secrets) : '服务内部错误'; ctx.body = { error: { code: e.code ?? 'ERROR', message } }; if (ctx.status >= 500) log('request.failed', { path: ctx.path, error: redact(e.message, secrets) }); }
  });
  const parseJson = bodyParser({ enableTypes: ['json'], jsonLimit: '128kb' });
  const parseCallbackForm = bodyParser({ enableTypes: ['form'], formLimit: '8kb' });
  app.use((ctx, next) => ctx.method === 'POST' && ctx.path === '/api/webhooks/qbittorrent/completed' && ctx.is('application/x-www-form-urlencoded') ? parseCallbackForm(ctx, next) : parseJson(ctx, next));
  const router = createRouter(config, services); app.use(router.routes()); app.use(router.allowedMethods());
  const root = fileURLToPath(new URL('../web/dist/', import.meta.url));
  const staticFiles = serve(root, { hidden: false, index: 'index.html' });
  app.use(async (ctx, next) => {
    if (ctx.path.startsWith('/api/') || ctx.path === '/api' || ctx.path.split('/').some(part => part.startsWith('.'))) return next();
    await staticFiles(ctx, async () => {
      if (ctx.method === 'GET' && !ctx.path.includes('.') && ctx.accepts('html')) {
        try { ctx.type = 'html'; ctx.body = await readFile(`${root}/index.html`); return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      await next();
    });
  });
  app.use(ctx => { ctx.status = 404; ctx.body = { error: { code: 'NOT_FOUND', message: '接口或页面不存在' } }; });
  return app;
}
