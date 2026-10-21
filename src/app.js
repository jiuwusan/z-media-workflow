import Koa from 'koa';
import { bodyParser } from '@koa/bodyparser';
import serve from 'koa-static';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRouter } from './router/index.js';
import { createServices } from './service/index.js';
import { AuthService } from './service/auth.js';
import { redact, log } from './util/logger.js';
import { AppError } from './util/error.js';
import { LifecycleService } from './service/lifecycle.js';
export function createApp({ config, setup, servicesFactory = createServices, services = setup && !setup.initialized ? {} : servicesFactory(config), lifecycle = new LifecycleService() }) {
  const app = new Koa(); app.proxy = config.trustProxy;
  let routes, allowedMethods;
  function activate(nextConfig = config, nextServices = services) {
    Object.assign(config, nextConfig); services = nextServices; services.auth ??= new AuthService(config); services.lifecycle = lifecycle;
    if(nextConfig.store)Object.defineProperty(config,'store',{value:nextConfig.store,enumerable:false,configurable:true});
    app.proxy = config.trustProxy; app.services = services;
    const router = createRouter(config, services); routes = router.routes(); allowedMethods = router.allowedMethods();
  }
  if (!setup || setup.initialized) activate();
  app.use(async (ctx, next) => {
    ctx.set('X-Content-Type-Options', 'nosniff'); ctx.set('X-Frame-Options', 'DENY'); ctx.set('Referrer-Policy', 'same-origin');
    ctx.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    if (ctx.path.startsWith('/api')) ctx.set('Cache-Control', 'no-store');
    try { await next(); }
    catch (e) { const secrets = [config.qbtKey, config.jellyfinKey, config.deepseekKey, config.adminPassword, config.workflowToken]; ctx.status = e.status ?? 500; const message = e.status ? redact(e.message, secrets) : '服务内部错误'; ctx.body = { error: { code: e.code ?? 'ERROR', message } }; if (ctx.status >= 500) log('request.failed', { path: ctx.path, error: redact(e.message, secrets) }); }
  });
  const parseJson = bodyParser({ enableTypes: ['json'], jsonLimit: '128kb' });
  app.use((ctx,next)=>{if(ctx.method==='POST'&&ctx.path==='/api/setup'&&(!setup||setup.initialized))throw new AppError('服务已完成初始化，不能重复配置',409);return next();});
  const parseSetup=bodyParser({enableTypes:['json'],jsonLimit:'22mb'});
  const parseCallbackForm = bodyParser({ enableTypes: ['form'], formLimit: '8kb' });
  app.use((ctx, next) => ctx.method==='POST'&&ctx.path==='/api/setup'?parseSetup(ctx,next):ctx.method === 'POST' && ctx.path === '/api/webhooks/qbittorrent/completed' && ctx.is('application/x-www-form-urlencoded') ? parseCallbackForm(ctx, next) : parseJson(ctx, next));
  app.use((ctx, next) => {
    if (lifecycle.pending && ctx.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) throw new AppError('服务正在重启，请稍后重试', 503);
    return next();
  });
  app.use(async (ctx, next) => {
    if (ctx.path === '/api/setup/status' && ctx.method === 'GET') { ctx.body = { data: setup ? setup.status(ctx) : { initialized: true } }; return; }
    if (ctx.path === '/api/setup' && ctx.method === 'POST') {
      if (!setup) throw new AppError('服务已完成初始化', 409);
      let prepared;
      const configured = setup.complete(ctx, candidate => { prepared = servicesFactory(candidate,{autoStart:false}); });
      activate(configured, prepared);
      if(services.start)services.start();else services.workflow?.start?.();
      ctx.status = 201; ctx.body = { data: { initialized: true } }; return;
    }
    if (!routes && ctx.path === '/health') { ctx.body = { data: { status: 'ok', initialized: false } }; return; }
    if (!routes && ctx.path.startsWith('/api')) throw new AppError('请先完成首次运行配置', 503);
    await next();
  });
  app.use((ctx, next) => routes ? routes(ctx, next) : next());
  app.use((ctx, next) => allowedMethods ? allowedMethods(ctx, next) : next());
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
