import { text, validFeedUrl } from '../util/validation.js';
import { AppError } from '../util/error.js';
import { log } from '../util/logger.js';
export function qbittorrentController(qbt) {
  return {
    async cleanupSettings(ctx) { ctx.body = { data: qbt.cleanupSettings() }; },
    async saveCleanupSettings(ctx) {
      const body = ctx.request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'deleteFiles') || typeof body.deleteFiles !== 'boolean') throw new AppError('只接受布尔值 deleteFiles 设置');
      ctx.body = { data: qbt.saveCleanupSettings({ deleteFiles: body.deleteFiles }) };
    },
    async cleanupMissingFiles(ctx) {
      const body = ctx.request.body === undefined ? {} : ctx.request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['dryRun', 'expectedDeleteFiles'].includes(key))) throw new AppError('请求体必须是对象，只允许 dryRun 和 expectedDeleteFiles 参数');
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') throw new AppError('dryRun 必须为布尔值');
      if (body.expectedDeleteFiles !== undefined && typeof body.expectedDeleteFiles !== 'boolean') throw new AppError('expectedDeleteFiles 必须为布尔值');
      const result = await qbt.cleanupMissingFiles({ dryRun: body.dryRun ?? true, ...(body.expectedDeleteFiles === undefined ? {} : { expectedDeleteFiles: body.expectedDeleteFiles }) });
      ctx.status = result.failedCount ? 502 : 200; ctx.body = { data: result };
      const { dryRun, deleteFiles, matchedCount, deletedCount, skippedCount, failedCount } = result;
      log('qbittorrent.cleanup.finished', { dryRun, deleteFiles, matchedCount, deletedCount, skippedCount, failedCount });
    },
    async addedNotification(ctx) { ctx.body = { data: await qbt.addedNotification() }; },
    async setAddedNotification(ctx) {
      const body = ctx.request.body ?? {};
      if (Object.keys(body).some(key => !['enabled', 'program'].includes(key))) throw new AppError('只允许修改新增种子通知设置');
      if (typeof body.enabled !== 'boolean' || typeof body.program !== 'string' || /[\r\n\0]/.test(body.program)) throw new AppError('启用状态需为布尔值，通知命令需为单行文本');
      const program = text(body.program, '通知命令', { optional: !body.enabled, max: 4096 });
      ctx.body = { data: await qbt.setAddedNotification({ enabled: body.enabled, program }) };
    },
    async completionNotification(ctx) { ctx.body = { data: await qbt.completionNotification() }; },
    async setCompletionNotification(ctx) {
      const body = ctx.request.body ?? {};
      if (Object.keys(body).some(key => !['enabled', 'program'].includes(key))) throw new AppError('只允许修改下载完成通知设置');
      if (typeof body.enabled !== 'boolean' || typeof body.program !== 'string' || /[\r\n\0]/.test(body.program)) throw new AppError('启用状态需为布尔值，通知命令需为单行文本');
      const program = text(body.program, '通知命令', { optional: !body.enabled, max: 4096 });
      ctx.body = { data: await qbt.setCompletionNotification({ enabled: body.enabled, program }) };
    },
    async rss(ctx) { ctx.body = { data: await qbt.rss() }; },
    async rules(ctx) { ctx.body = { data: await qbt.rules() }; },
    async categories(ctx) { ctx.body = { data: await qbt.categories() }; },
    async addFeed(ctx) { const b = ctx.request.body ?? {}; await qbt.addFeed(validFeedUrl(text(b.url, '订阅地址')), text(b.path, '订阅路径', { optional: true })); ctx.status = 201; ctx.body = { data: { ok: true } }; },
    async removeFeed(ctx) { await qbt.removeFeed(text(ctx.request.body?.path, '订阅路径')); ctx.body = { data: { ok: true } }; },
    async refresh(ctx) { await qbt.refresh(text(ctx.request.body?.path, '订阅路径', { optional: true })); ctx.body = { data: { ok: true } }; },
    async setRule(ctx) {
      const body = ctx.request.body ?? {}, rule = {};
      text(ctx.params.name, '规则名称', { max: 200 });
      for (const key of ['enabled', 'useRegex', 'smartFilter']) {
        if (body[key] !== undefined) { if (typeof body[key] !== 'boolean') throw new AppError(`${key} 必须为布尔值`); rule[key] = body[key]; }
      }
      if (body.addPaused !== undefined) { if (body.addPaused !== null && typeof body.addPaused !== 'boolean') throw new AppError('addPaused 必须为布尔值或 null'); rule.addPaused = body.addPaused; }
      for (const key of ['mustContain', 'mustNotContain', 'episodeFilter', 'assignedCategory', 'savePath']) if (body[key] !== undefined) rule[key] = text(body[key], key, { optional: true });
      if (!Array.isArray(body.affectedFeeds) || body.affectedFeeds.length > 100 || body.affectedFeeds.some(x => typeof x !== 'string')) throw new AppError('affectedFeeds 必须为订阅 URL 列表');
      rule.affectedFeeds = body.affectedFeeds.map(validFeedUrl);
      if (body.ignoreDays !== undefined) { if (!Number.isInteger(body.ignoreDays) || body.ignoreDays < 0 || body.ignoreDays > 36500) throw new AppError('ignoreDays 无效'); rule.ignoreDays = body.ignoreDays; }
      await qbt.setRule(ctx.params.name, rule); ctx.body = { data: { ok: true } };
    },
    async removeRule(ctx) { await qbt.removeRule(text(ctx.params.name, '规则名称')); ctx.body = { data: { ok: true } }; }
  };
}
