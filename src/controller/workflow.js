import { AppError } from '../util/error.js';
import { pagination, scanInput, mediaType, text } from '../util/validation.js';
export function workflowController(workflow, mediaLibrary) {
  const accepted = (ctx, job) => { ctx.status = 202; ctx.body = { data: job }; };
  return {
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
    list(ctx) { ctx.body = { data: workflow.list(pagination(ctx.query)) }; },
    get(ctx) { ctx.body = { data: workflow.get(ctx.params.jobId) }; },
    retry(ctx) { accepted(ctx, workflow.retry(ctx.params.jobId)); },
    confirm(ctx) { const b = ctx.request.body ?? {}; accepted(ctx, workflow.confirm(ctx.params.jobId, text(b.itemId, '媒体 ID'), text(b.candidateId, '候选 ID'))); },
    search(ctx) { const b = ctx.request.body ?? {}; accepted(ctx, workflow.search(ctx.params.jobId, text(b.itemId, '媒体 ID'), { name: b.name, year: b.year })); },
    async unidentified(ctx) { ctx.body = { data: await mediaLibrary.unidentified({ ...pagination(ctx.query), libraryId: ctx.query.libraryId, type: mediaType(ctx.query.type) }) }; }
  };
}
