import { randomUUID } from 'node:crypto';
import { AppError } from '../util/error.js';
import { sleep } from '../util/http.js';
import { hasIdentity, mediaSource, selectCandidate, validateIdentity } from '../util/media.js';
import { log, redact } from '../util/logger.js';
export class WorkflowService {
  constructor(config, services) {
    this.config = config; this.services = services; this.jobs = new Map(); this.recoveries = new Map(); this.queue = []; this.running = false; this.stopping = false;
    this.secrets = [config.qbtKey, config.jellyfinKey, config.deepseekKey, config.adminPassword, config.workflowToken];
  }
  prune() {
    const terminal = [...this.jobs.values()].filter(j => !['queued', 'running', 'needs_review'].includes(j.status));
    for (const job of terminal) if (Date.now() - Date.parse(job.updatedAt) > this.config.jobTtlMs) this.jobs.delete(job.id);
    for (const job of terminal) { if (this.jobs.size < this.config.maxJobs) break; this.jobs.delete(job.id); }
    for (const id of this.recoveries.keys()) if (!this.jobs.has(id)) this.recoveries.delete(id);
  }
  get(id) { const job = this.jobs.get(id); if (!job) throw new AppError('任务不存在或已过期', 404); return structuredClone(job); }
  list({ page = 1, pageSize = 20 } = {}) {
    this.prune(); const list = [...this.jobs.values()].reverse();
    return { items: list.slice((page - 1) * pageSize, page * pageSize).map(({ items, ...j }) => ({ ...j, itemCount: items.length })), total: list.length, page, pageSize };
  }
  summary() {
    const counts = {}; for (const j of this.jobs.values()) counts[j.status] = (counts[j.status] ?? 0) + 1;
    return { counts, queued: this.queue.length, running: this.running };
  }
  ensureCapacity() { if (this.stopping) throw new AppError('服务正在关闭', 503); if (this.queue.length >= this.config.maxQueue) throw new AppError('任务队列已满，请稍后重试', 429); }
  enqueue(input = {}, recovery = []) {
    this.prune();
    if (input.hash && !recovery.length) {
      const existing = [...this.jobs.values()].find(j => j.input.hash === input.hash && j.status !== 'failed');
      if (existing) return this.get(existing.id);
    }
    this.ensureCapacity();
    if (this.jobs.size >= this.config.maxJobs) throw new AppError('任务记录已达上限，请处理待确认任务或重启服务', 429);
    const job = { id: randomUUID(), input: structuredClone(input), status: 'queued', stage: '排队', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), items: [] };
    this.jobs.set(job.id, job);
    if (recovery.length) this.recoveries.set(job.id, structuredClone(recovery));
    this.queue.push({ job, action: () => this.run(job) }); this.drain(); return this.get(job.id);
  }
  update(job, stage, status) { job.stage = stage; if (status) job.status = status; job.updatedAt = new Date().toISOString(); }
  async drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const { job, action } = this.queue.shift(); this.update(job, '处理', 'running');
      try { await action(); this.finish(job); }
      catch (error) { job.error = redact(error.message, this.secrets); this.update(job, '失败', 'failed'); }
      log('workflow.finished', { jobId: job.id, status: job.status });
    }
    this.running = false;
  }
  finish(job) {
    const status = job.items.some(i => i.status === 'needs_review') ? 'needs_review' : job.items.some(i => i.status === 'failed') ? 'failed' : 'completed';
    this.update(job, status === 'needs_review' ? '等待人工确认' : status === 'failed' ? '存在失败条目' : '完成', status);
  }
  async run(job) {
    const { jellyfin, qbittorrent, mediaLibrary } = this.services;
    const recovery = this.recoveries.get(job.id) ?? [];
    if (job.input.hash) {
      this.update(job, '检查下载'); const torrent = await qbittorrent.torrent(job.input.hash);
      if (torrent.progress < 1 || (torrent.amount_left ?? 0) > 0) throw new AppError('torrent 尚未下载完成', 409);
    }
    this.update(job, '扫描媒体库'); await jellyfin.refreshAndWait();
    // Download callbacks scan unidentified library media, independently of torrent paths.
    // Explicit pagination also preserves the complete scope of manual scans.
    const items = [];
    for (let page = 1; ; page++) {
      const result = await mediaLibrary.unidentified({ ...job.input, page, pageSize: 200 }); items.push(...result.items);
      if (items.length >= result.total || !result.items.length) break;
    }
    // Failed apply/verify entries are never skipped solely because ProviderIds now exist.
    for (const previous of recovery.filter(i => i.itemId)) {
      if (!items.some(i => i.Id === previous.itemId)) items.push(await mediaLibrary.ensureItem(previous.itemId));
    }
    if (!items.length) { job.message = '目标范围内没有未识别媒体'; return; }
    for (const item of items) {
      const entry = { itemId: item.Id, type: item.Type, originalName: item.Name, path: item.Path, source: mediaSource(item), status: 'running', candidates: [] };
      job.items.push(entry);
      try {
        const previous = recovery.find(i => i.itemId === item.Id);
        if (previous?.selectedCandidate) {
          entry.identity = previous.identity; entry.candidates = previous.candidates;
          await this.applyCandidate(job, entry, previous.selectedCandidate); continue;
        }
        this.update(job, `提取名称：${entry.source}`); entry.identity = await this.services.deepseek.identify(entry.source, item.Type);
        await this.findCandidates(job, entry, item);
        const selected = selectCandidate(entry.identity, entry.candidates);
        if (job.input.dryRun || !selected) { entry.status = 'needs_review'; entry.message = job.input.dryRun ? '预览完成，选择候选后确认应用' : '没有唯一可靠候选，请人工确认或修改搜索名称'; }
        else await this.applyCandidate(job, entry, selected);
      } catch (error) { entry.status = 'failed'; entry.error = redact(error.message, this.secrets); }
    }
    // Recovery is now represented in concrete item results; preflight failures retain it.
    this.recoveries.delete(job.id);
  }
  async findCandidates(job, entry, item) {
    this.update(job, `搜索候选：${entry.identity.name}`);
    const candidates = await this.services.jellyfin.search(item, entry.identity);
    entry.candidates = candidates.filter(hasIdentity).slice(0, 50).map(c => ({ ...c, candidateId: randomUUID() }));
  }
  async applyCandidate(job, entry, candidate) {
    entry.selectedCandidate = structuredClone(candidate);
    const item = await this.services.mediaLibrary.ensureItem(entry.itemId);
    if (item.Type !== entry.type) throw new AppError('媒体类型已变化，请重新扫描', 409);
    this.update(job, `应用候选：${candidate.Name}`); entry.status = 'running';
    const { candidateId, ...remote } = candidate;
    // Apply is intentionally not retried blindly; failed responses may still have changed metadata.
    try { await this.services.jellyfin.apply(entry.itemId, remote); }
    catch (error) { entry.applyWarning = redact(error.message, this.secrets); }
    this.update(job, '回读确认媒体信息');
    const confirmed = await this.services.jellyfin.verify(entry.itemId, remote);
    entry.confirmed = { Name: confirmed.Name, ProductionYear: confirmed.ProductionYear, ProviderIds: confirmed.ProviderIds };
    if (entry.type === 'Series') await this.services.jellyfin.refreshItem(entry.itemId);
    entry.status = 'completed'; delete entry.error; delete entry.message;
  }
  retry(id) {
    const job = this.get(id), failed = job.items.filter(i => i.status === 'failed');
    for (const previous of this.recoveries.get(id) ?? []) if (!failed.some(i => i.itemId === previous.itemId && i.path === previous.path)) failed.push(previous);
    if (!['failed', 'needs_review'].includes(job.status) || (job.status !== 'failed' && !failed.length)) throw new AppError('仅失败任务或失败条目可以重试', 409);
    return this.enqueue(job.input, failed);
  }
  queueAction(job, action) {
    this.ensureCapacity(); this.update(job, '排队', 'queued'); this.queue.push({ job, action }); this.drain(); return this.get(job.id);
  }
  reviewEntry(id, itemId) {
    const job = this.jobs.get(id); if (!job) throw new AppError('任务不存在', 404);
    if (job.status !== 'needs_review') throw new AppError('该任务当前不允许确认', 409);
    const entry = job.items.find(i => i.itemId === itemId && i.status === 'needs_review');
    if (!entry) throw new AppError('待确认媒体不存在', 404);
    return { job, entry };
  }
  confirm(id, itemId, candidateId) {
    const { job, entry } = this.reviewEntry(id, itemId), candidate = entry.candidates.find(c => c.candidateId === candidateId);
    if (!candidate) throw new AppError('候选不存在，请重新加载任务');
    return this.queueAction(job, async () => { try { await this.applyCandidate(job, entry, candidate); } catch (error) { entry.status = 'failed'; entry.error = redact(error.message, this.secrets); } });
  }
  search(id, itemId, identity) {
    const { job, entry } = this.reviewEntry(id, itemId); const valid = validateIdentity(identity);
    return this.queueAction(job, async () => { const item = await this.services.mediaLibrary.ensureItem(itemId); entry.identity = valid; await this.findCandidates(job, entry, item); entry.status = 'needs_review'; });
  }
  async close(timeoutMs = 30000) { this.stopping = true; const end = Date.now() + timeoutMs; while (this.running && Date.now() < end) await sleep(25); return !this.running; }
}
