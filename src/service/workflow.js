import { randomUUID } from 'node:crypto';
import { AppError } from '../util/error.js';
import { sleep } from '../util/http.js';
import { compareProviderIdentity, hasChineseName, hasIdentity, isLaterSeasonCandidate, mediaSource, selectCandidate, validateIdentity } from '../util/media.js';
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
    if (input.checkExisting) {
      const existing = [...this.jobs.values()].find(j => j.input.checkExisting && ['queued', 'running'].includes(j.status));
      if (existing) return this.get(existing.id);
    }
    if (input.hash && !recovery.length) {
      const existing = [...this.jobs.values()].find(j => j.input.hash === input.hash && (j.input.event ?? 'completed') === (input.event ?? 'completed') && j.status !== 'failed');
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
    if (job.input.event === 'added') {
      await this.services.torrentNaming.run(job, (job, stage) => this.update(job, stage));
      this.recoveries.delete(job.id); return;
    }
    const { jellyfin, qbittorrent, mediaLibrary } = this.services;
    const recovery = this.recoveries.get(job.id) ?? [];
    if (job.input.hash) {
      this.update(job, '检查下载'); const torrent = await qbittorrent.torrent(job.input.hash);
      if (torrent.progress < 1 || (torrent.amount_left ?? 0) > 0) throw new AppError('torrent 尚未下载完成', 409);
    }
    this.update(job, '扫描媒体库'); await jellyfin.refreshAndWait();
    // Download callbacks scan media beyond the workflow cursor, independently of torrent paths.
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
    await mediaLibrary.track(items, job.input);
    for (const item of items) {
      const entry = { itemId: item.Id, libraryId: item.LibraryId, type: item.Type, originalName: item.Name, path: item.Path, source: mediaSource(item), status: 'running', candidates: [] };
      job.items.push(entry);
      try {
        const previous = recovery.find(i => i.itemId === item.Id);
        if (previous && (previous.path !== item.Path || (previous.libraryId && previous.libraryId !== item.LibraryId))) throw new AppError('媒体路径或媒体库已变化，请重新扫描', 409);
        if (previous?.selectedCandidate) {
          entry.identity = previous.identity; entry.candidates = previous.candidates;
          entry.selectionMethod = previous.selectionMethod; entry.aiDecision = previous.aiDecision;
          if (previous.selectionWarning) entry.selectionWarning = previous.selectionWarning;
          await this.applyCandidate(job, entry, previous.selectedCandidate); continue;
        }
        this.update(job, `提取名称：${entry.source}`); entry.identity = await this.services.deepseek.identify(entry.source, item.Type);
        await this.findCandidates(job, entry, item);
        let selected = selectCandidate(entry.identity, entry.candidates);
        if (selected) {
          entry.selectionMethod = 'rules';
          selected = await this.preferChineseCandidate(job, entry, selected);
        }
        else if (entry.candidates.length) {
          this.update(job, `AI 判断候选：${entry.identity.name}`);
          try {
            const decision = await this.services.deepseek.chooseCandidate(entry.source, entry.type, entry.identity, entry.candidates);
            entry.aiDecision = { ...decision, reason: redact(decision.reason, this.secrets) };
            selected = decision.confidence === 'high' ? entry.candidates.find(c => c.candidateId === decision.candidateId && (entry.identity.year == null || c.ProductionYear === entry.identity.year || isLaterSeasonCandidate(entry.identity, c, entry.type, decision))) : null;
            if (selected) {
              entry.selectionMethod = 'ai';
              if (isLaterSeasonCandidate(entry.identity, selected, entry.type, decision)) entry.selectionWarning = `AI 已核实为第 ${decision.season} 季：资源年份 ${entry.identity.year}，节目首播年份 ${selected.ProductionYear}。${entry.aiDecision.reason}`;
            }
          } catch (error) { entry.aiDecisionError = redact(error.message, this.secrets); }
        }
        if (!selected) {
          selected = entry.candidates.find(c => entry.identity.year == null || c.ProductionYear === entry.identity.year);
          if (selected) {
            entry.selectionMethod = 'fallback';
            entry.selectionWarning = `未能确定唯一候选，已临时选择第一个有效且年份匹配的结果：${selected.Name}${selected.ProductionYear ? ` (${selected.ProductionYear})` : ''}`;
          }
        }
        if (job.input.dryRun || !selected) { entry.status = 'needs_review'; entry.message = job.input.dryRun ? '预览完成，选择候选后确认应用' : entry.type === 'Series' ? '没有年份匹配或经 AI 核实后续季关系的候选，请人工确认或修改搜索名称' : '没有有效且年份匹配的候选，请人工确认或修改搜索名称'; }
        else await this.applyCandidate(job, entry, selected);
      } catch (error) { entry.status = 'failed'; entry.error = redact(error.message, this.secrets); }
    }
    // Recovery is now represented in concrete item results; preflight failures retain it.
    this.recoveries.delete(job.id);
  }
  async findCandidates(job, entry, item) {
    delete entry.candidateSearchWarning;
    this.update(job, `搜索候选：${entry.identity.name}`);
    let candidates = await this.services.jellyfin.search(item, entry.identity);
    if (entry.type === 'Series' && entry.identity.year != null && !candidates.some(c => hasIdentity(c) && c.ProductionYear === entry.identity.year)) {
      this.update(job, `补查节目候选：${entry.identity.name}`);
      try { candidates = [...await this.services.jellyfin.search(item, { ...entry.identity, year: null }), ...candidates]; }
      catch (error) { if (!candidates.length) throw error; entry.candidateSearchWarning = redact(error.message, this.secrets); }
    }
    // Keep distinct names/providers, but collapse identical results from the two searches.
    const seen = new Set();
    entry.candidates = candidates.filter(hasIdentity).filter(c => {
      const key = JSON.stringify([c.Name, c.ProductionYear, Object.entries(c.ProviderIds ?? {}).sort()]);
      if (seen.has(key)) return false; seen.add(key); return true;
    }).slice(0, 50).map(c => ({ ...c, candidateId: randomUUID() }));
  }
  async preferChineseCandidate(job, entry, selected) {
    if (hasChineseName(selected) || selected.ProductionYear == null) return selected;
    const chinese = entry.candidates.filter(c => hasChineseName(c) && c.ProductionYear === selected.ProductionYear && compareProviderIdentity(selected, c) !== 'conflict');
    if (!chinese.length) return selected;
    const same = chinese.filter(c => compareProviderIdentity(selected, c) === 'same');
    if (same.length && same.every(a => same.every(b => compareProviderIdentity(a, b) !== 'conflict'))) return same[0];
    this.update(job, `AI 判断中文候选：${entry.identity.name}`);
    try {
      const decision = await this.services.deepseek.chooseCandidate(entry.source, entry.type, entry.identity, [selected, ...chinese]);
      entry.aiDecision = { ...decision, reason: redact(decision.reason, this.secrets) };
      const preferred = decision.confidence === 'high' ? chinese.find(c => c.candidateId === decision.candidateId) : null;
      if (preferred) { entry.selectionMethod = 'ai'; return preferred; }
    } catch (error) { entry.aiDecisionError = redact(error.message, this.secrets); }
    return selected;
  }
  async applyCandidate(job, entry, candidate) {
    entry.selectedCandidate = structuredClone(candidate);
    const item = await this.services.mediaLibrary.ensureItem(entry.itemId, { libraryId: entry.libraryId ?? job.input.libraryId, type: entry.type });
    if (item.Type !== entry.type) throw new AppError('媒体类型已变化，请重新扫描', 409);
    if (item.Path !== entry.path) throw new AppError('媒体路径已变化，请重新扫描', 409);
    this.update(job, `应用候选：${candidate.Name}`); entry.status = 'running';
    const { candidateId, ...remote } = candidate;
    // Successful submission completes identification; Jellyfin loads metadata asynchronously.
    await this.services.jellyfin.apply(entry.itemId, remote, item);
    this.services.mediaLibrary.markIdentified(item);
    entry.confirmed = { Name: remote.Name, ProductionYear: remote.ProductionYear, ProviderIds: structuredClone(remote.ProviderIds) };
    entry.status = 'completed'; delete entry.error; delete entry.message;
    this.update(job, '提交后台元数据刷新');
    try { await this.services.jellyfin.refreshItem(entry.itemId, { full: true }); }
    catch (error) { entry.refreshWarning = redact(error.message, this.secrets); }
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
    return this.queueAction(job, async () => { try { entry.selectionMethod = 'manual'; delete entry.selectionWarning; await this.applyCandidate(job, entry, candidate); } catch (error) { entry.status = 'failed'; entry.error = redact(error.message, this.secrets); } });
  }
  search(id, itemId, identity) {
    const { job, entry } = this.reviewEntry(id, itemId); const valid = validateIdentity(identity);
    return this.queueAction(job, async () => { const item = await this.services.mediaLibrary.ensureItem(itemId, { libraryId: entry.libraryId ?? job.input.libraryId, type: entry.type }); entry.identity = valid; delete entry.aiDecision; delete entry.aiDecisionError; delete entry.selectionMethod; delete entry.selectionWarning; await this.findCandidates(job, entry, item); entry.status = 'needs_review'; });
  }
  async close(timeoutMs = 30000) { this.stopping = true; const end = Date.now() + timeoutMs; while (this.running && Date.now() < end) await sleep(25); return !this.running; }
}
