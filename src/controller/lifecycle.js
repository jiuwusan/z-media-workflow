import { AppError } from '../util/error.js';
import { log } from '../util/logger.js';

export function lifecycleController(services) {
  const lifecycle = services.lifecycle;
  return {
    health(ctx) {
      const workflow = services.workflow;
      const status = workflow?.storageError ? 'unavailable' : workflow?.ready === false ? 'starting' : lifecycle.pending ? 'restarting' : 'ok';
      if (['unavailable', 'starting'].includes(status)) ctx.status = 503;
      ctx.body = { data: { status, instanceId: lifecycle.instanceId } };
    },
    status(ctx) { ctx.body = { data: lifecycle.status() }; },
    restart(ctx) {
      const body = ctx.request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.revision !== 'string' || Object.keys(body).some(key => key !== 'revision')) throw new AppError('重启参数无效');
      const result = lifecycle.prepare(body, services);
      const restart = () => { setTimeout(() => lifecycle.launch().catch(() => log('service.restart.failed', { message: '请检查服务日志与 PM2 配置' })), 100).unref(); };
      ctx.res.once('finish', restart);
      ctx.res.once('close', () => { if (!ctx.res.writableFinished) restart(); });
      ctx.status = 202; ctx.body = { data: result };
    }
  };
}
