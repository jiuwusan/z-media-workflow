import { AppError } from '../util/error.js';
import { pagination, scanInput, mediaType, text } from '../util/validation.js';
import { validateIdentity } from '../util/media.js';
export function workflowController(workflow, mediaLibrary, jellyfin) {
  const accepted = (ctx, job) => { ctx.status = 202; ctx.body = { data: job }; };
  return {
    checkTorrents(ctx) {
      const body = ctx.request.body ?? {};
      if (typeof body.hash !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(body.hash) || Object.keys(body).some(key => key !== 'hash')) throw new AppError('请选择一个种子，仅接受有效的 torrent hash');
      accepted(ctx, workflow.enqueue({ hash: body.hash.toLowerCase(), event: 'added' }, [], { recheck: true }));
    },
    added(ctx) {
      const body = ctx.request.body ?? {};
      if (typeof body.hash !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(body.hash)) throw new AppError('torrent hash 无效');
      accepted(ctx, workflow.enqueue({ hash: body.hash.toLowerCase(), event: 'added' }));
    },
    completed(ctx) {
      const body = ctx.request.body ?? {};
      if (typeof body.hash !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(body.hash)) throw new AppError('torrent hash 无效');
      accepted(ctx, workflow.enqueue({ hash: body.hash.toLowerCase(), ...(body.type ? { type: mediaType(body.type) } : {}) }));
    },
    scan(ctx) { accepted(ctx, workflow.enqueue(scanInput(ctx.request.body ?? {}))); },
    identify(ctx) {
      const body = ctx.request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['name', 'year'].includes(key))) throw new AppError('仅接受搜索名称和年份');
      const identity = validateIdentity(body);
      accepted(ctx, workflow.enqueue({ correction: true, dryRun: true, itemIds: [text(ctx.params.itemId, '媒体 ID', { max: 200 })], identity }));
    },
    async libraries(ctx) { ctx.body = { data: await mediaLibrary.libraries() }; },
    async poster(ctx) {
      if (!/^[a-f0-9]{32}$/i.test(ctx.params.itemId)) throw new AppError('媒体 ID 无效');
      const poster = await jellyfin.poster(ctx.params.itemId);
      if (!poster) throw new AppError('海报不存在', 404);
      ctx.type = poster.contentType; ctx.body = poster.body;
    },
    async media(ctx) { ctx.body = { data: await mediaLibrary.list({ ...pagination(ctx.query), libraryId: ctx.query.libraryId, type: mediaType(ctx.query.type), search: text(ctx.query.search, '搜索名称', { optional: true, max: 300 }), sort: ctx.query.sort }) }; },
    list(ctx) { ctx.body = { data: workflow.list(pagination(ctx.query)) }; },
    get(ctx) { ctx.body = { data: workflow.get(ctx.params.jobId) }; },
    retry(ctx) { accepted(ctx, workflow.retry(ctx.params.jobId)); },
    confirm(ctx) { const b = ctx.request.body ?? {}; accepted(ctx, workflow.confirm(ctx.params.jobId, text(b.itemId, '媒体 ID'), text(b.candidateId, '候选 ID'))); },
    search(ctx) { const b = ctx.request.body ?? {}; accepted(ctx, workflow.search(ctx.params.jobId, text(b.itemId, '媒体 ID'), { name: b.name, year: b.year })); },
    async unidentified(ctx) { ctx.body = { data: await mediaLibrary.unidentified({ ...pagination(ctx.query), libraryId: ctx.query.libraryId, type: mediaType(ctx.query.type) }) }; }
  };
}
