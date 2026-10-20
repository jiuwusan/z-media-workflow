import { randomUUID } from 'node:crypto';
import { AppError } from '../util/error.js';
import { sleep } from '../util/http.js';
import { compareProviderIdentity, hasChineseName, hasIdentity, isLaterSeasonCandidate, mediaSource, movieSearchNames, selectCandidate, validateIdentity } from '../util/media.js';
import { log, redact } from '../util/logger.js';
import { openWorkflowDatabase } from '../storage/database.js';
import { WorkflowRepository, sourceScope } from '../storage/workflow-repository.js';
import { recoverRunningActions, reconcileIntent, completeReconciled, sameScope } from './workflow-recovery.js';
export class WorkflowService {
  constructor(config, services, { repository, autoStart = true } = {}) {
    this.config = config; this.services = services; this.running = false; this.stopping = false;
    this.repository = repository ?? new WorkflowRepository(openWorkflowDatabase(':memory:'), config);
    this.ownsRepository = !repository; this.scope = sourceScope(config);
    this.ready = false; this.started = false; this.autoStart = autoStart; this.storageError = null;
    this.secrets = [config.qbtKey, config.jellyfinKey, config.deepseekKey, config.adminPassword, config.workflowToken];
    if (autoStart) this.start();
  }
  async start() {
    if (this.started) return this.startPromise;
    this.started = true;
    try {
      if (this.repository.runningActions().length) {
        this.recovering = true;
        this.startPromise = recoverRunningActions({ repository: this.repository, services: this.services, sourceScope: this.scope })
          .then(() => { this.recovering = false; this.ready = true; return this.drain(); })
          .catch(error => { this.recovering = false; this.storageError = error; this.ready = false; });
      } else { this.ready = true; this.startPromise = this.drain(); }
    } catch (error) { this.storageError = error; this.ready = false; }
    return this.startPromise;
  }
  prune() { return this.repository.prune(); }
  get(id) { return this.repository.get(id); }
  list(input) { return this.repository.list(input); }
  summary() { return { ...this.repository.summary(), running: this.running }; }
  ensureCapacity() {
    if (this.stopping || this.storageError || (this.autoStart && !this.ready)) throw new AppError('服务正在关闭或持久层尚未就绪', 503);
    for (const key of ['maxJobs', 'maxQueue', 'jobTtlMs']) if (this.config[key] != null) this.repository.limits[key] = this.config[key];
  }
  enqueue(input = {}, recovery = [], options = {}) {
    this.ensureCapacity();
    const job = this.persist(() => this.repository.accept({ input: this.sanitize(input), recovery: this.sanitize(recovery), options, sourceScope: this.scope, parentJobId: options.parentJobId }));
    if (this.ready) this.drain(); return this.get(job.id);
  }
  sanitize(value) {
    if (typeof value === 'string') return redact(value, this.secrets);
    if (Array.isArray(value)) return value.map(v => this.sanitize(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, this.sanitize(v)]));
    return value;
  }
  persist(fn) {
    try { return fn(); } catch (error) {
      if (!error.status) { this.storageError = error; this.ready = false; log('workflow.storage.failed', { message: redact(error.message, this.secrets) }); }
      throw error;
    }
  }
  checkpoint(job) { if (this.storageError) throw this.storageError; this.persist(() => this.repository.save(this.sanitize(job))); }
  update(job, stage, status) { job.stage = stage; if (status) job.status = status; job.updatedAt = new Date().toISOString(); this.checkpoint(job); }
  async drain() {
    if (this.running || !this.ready || this.stopping) return;
    this.running = true;
    try {
      while (!this.stopping && !this.storageError) {
        const action = this.persist(() => this.repository.claimNext()); if (!action) break;
        const job = this.get(action.jobId);
        try { await this.dispatch(action, job); this.finish(job); }
        catch (error) {
          if (this.storageError) break;
          job.error = redact(error.message, this.secrets);
          for (const entry of job.items) if (['queued', 'running'].includes(entry.status)) { entry.status = 'failed'; entry.error = job.error; }
          this.update(job, '失败', 'failed');
        }
        this.persist(() => this.repository.save(this.sanitize(job), { actionId: action.id, actionStatus: job.status === 'failed' ? 'failed' : 'completed' }));
        log('workflow.finished', { jobId: job.id, status: job.status });
      }
    } catch (error) { if (!this.storageError) { this.storageError = error; this.ready = false; } }
    finally { this.running = false; }
  }
  async dispatch(action, job) {
    if (!sameScope(job.sourceScope, this.scope)) throw new AppError('任务来源服务地址已变化，请重新发起操作', 409);
    if (action.kind === 'retry') {
      const pending = [];
      for (const old of action.payload.recovery) {
        const entry = structuredClone(old);
        if (entry.intent && entry.phase !== 'completed') {
          const result = await reconcileIntent(entry.intent, this.services);
          if (result.state === 'matched') {
            await completeReconciled(job, entry, result.item, this.services); job.items.push(entry); this.checkpoint(job);
            this.resolveParent(action.payload.parentJobId, entry); continue;
          }
          if (result.state !== 'unchanged') {
            entry.status = 'failed'; entry.error = result.reason; entry.recoveryState = 'interrupted'; job.items.push(entry); this.checkpoint(job); continue;
          }
          if (job.input.correction) {
            entry.status = 'needs_review'; entry.message = '原人工选择与候选已保留，请再次确认后应用';
            delete entry.error; delete entry.recoveryState;
            job.items.push(entry); this.checkpoint(job); continue;
          }
        }
        delete entry.recoveryState;
        pending.push(entry);
      }
      if (action.payload.recovery.length && !pending.length) return;
      action.payload.recovery = pending;
    }
    if (['run', 'retry'].includes(action.kind)) return this.run(job, { ...action.payload.options, recovery: action.payload.recovery });
    const entry = job.items.find(i => i.itemId === action.payload.itemId);
    if (!entry) throw new AppError('待处理条目不存在', 404);
    if (action.kind === 'confirm') {
      entry.selectionMethod = 'manual'; delete entry.selectionWarning;
      try { await this.applyCandidate(job, entry, action.payload.candidate); }
      catch (error) { if (this.storageError) throw error; entry.status = 'failed'; entry.error = redact(error.message, this.secrets); }
    } else if (action.kind === 'search') {
      const item = await this.services.mediaLibrary.ensureItem(entry.itemId, { libraryId: entry.libraryId ?? job.input.libraryId, type: entry.type });
      entry.identity = action.payload.identity;
      for (const key of ['aiDecision', 'aiDecisionError', 'selectionMethod', 'selectionWarning']) delete entry[key];
      await this.findCandidates(job, entry, item); entry.status = 'needs_review';
    } else throw new AppError('未知工作流动作', 409);
  }
  resolveParent(id, resolved) {
    if (!id) return;
    let parent;
    try { parent = this.get(id); } catch (error) { if (error.status === 404) return; throw error; }
    const entry = parent.items.find(i => i.itemId === resolved.itemId);
    if (entry) { Object.assign(entry, resolved); parent.updatedAt = new Date().toISOString(); }
    if (parent.recovery) parent.recovery = parent.recovery.filter(i => i.itemId !== resolved.itemId);
    this.checkpoint(parent);
    if (parent.parentJobId) this.resolveParent(parent.parentJobId, resolved);
  }
  finish(job) {
    const status = job.items.some(i => i.status === 'needs_review') ? 'needs_review' : job.items.some(i => i.status === 'failed') ? 'failed' : 'completed';
    this.update(job, status === 'needs_review' ? '等待人工确认' : status === 'failed' ? '存在失败条目' : '完成', status);
  }
  async run(job, { scanLibrary = Boolean(job.input.hash), recovery = [], skipItemIds = [] } = {}) {
    job.recovery = recovery; job.skipItemIds = skipItemIds; this.checkpoint(job);
    if (job.input.correction) { const result = await this.runCorrection(job); delete job.recovery; return result; }
    if (job.input.event === 'added') {
      job.skipItemIds = skipItemIds;
      for (const entry of recovery) if (!job.items.some(i => i.itemId === entry.itemId)) job.items.push(structuredClone(entry));
      await this.services.torrentNaming.run(job, (job, stage) => this.update(job, stage), job => this.checkpoint(job));
      for (const entry of job.items.filter(i => i.status === 'completed')) if (job.parentJobId) this.resolveParent(job.parentJobId, entry);
      delete job.recovery;
      return;
    }
    const { jellyfin, qbittorrent, mediaLibrary } = this.services;
    let torrent;
    if (job.input.hash) {
      this.update(job, '检查下载'); torrent = await qbittorrent.torrent(job.input.hash);
      if (torrent.progress < 1 || (torrent.amount_left ?? 0) > 0) throw new AppError('torrent 尚未下载完成', 409);
    }
    if (scanLibrary) {
      this.update(job, '定位种子所属媒体库');
      const libraries = await mediaLibrary.librariesForTorrent(torrent, await qbittorrent.files(job.input.hash));
      job.refreshedLibraries = libraries.map(lib => ({ id: lib.ItemId, name: lib.Name }));
      for (const library of libraries) {
        this.update(job, `提交媒体库刷新：${library.Name ?? library.ItemId}`);
        await jellyfin.refreshItem(library.ItemId);
      }
      const waitMs = this.config.libraryRefreshWaitMs ?? 10000;
      if (waitMs > 0) {
        this.update(job, `等待 ${waitMs / 1000} 秒后检查识别`);
        await sleep(waitMs);
      }
    }
    this.update(job, '读取待识别媒体');
    // Download callbacks scan media beyond the workflow cursor, independently of torrent paths.
    // Explicit pagination also preserves the complete scope of manual scans.
    const items = []; let readCount = 0;
    for (let page = 1; ; page++) {
      const result = await mediaLibrary.unidentified({ ...job.input, page, pageSize: 200 });
      items.push(...result.items.filter(i => !skipItemIds.includes(i.Id) && !job.items.some(e => e.itemId === i.Id)));
      readCount += result.items.length;
      if (readCount >= result.total || !result.items.length) break;
    }
    // Failed apply/verify entries are never skipped solely because ProviderIds now exist.
    for (const previous of recovery.filter(i => i.itemId)) {
      if (!items.some(i => i.Id === previous.itemId)) items.push(await mediaLibrary.ensureItem(previous.itemId));
    }
    if (!items.length) { job.message = '目标范围内没有未识别媒体'; return; }
    for (const item of items) job.items.push({ itemId: item.Id, libraryId: item.LibraryId, type: item.Type, originalName: item.Name, path: item.Path, source: mediaSource(item), status: 'queued', candidates: [] });
    job.discoveryComplete = true; this.checkpoint(job);
    await mediaLibrary.track(items, job.input);
    for (const item of items) {
      const entry = job.items.find(e => e.itemId === item.Id); entry.status = 'running';
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
    delete job.recovery; this.checkpoint(job);
  }
  async runCorrection(job) {
    const item = await this.services.mediaLibrary.ensureItem(job.input.itemIds[0]);
    const entry = { itemId: item.Id, libraryId: item.LibraryId, type: item.Type, originalName: item.Name, path: item.Path, source: mediaSource(item), identity: validateIdentity(job.input.identity), status: 'running', candidates: [] };
    job.items.push(entry);
    await this.findCandidates(job, entry, item);
    entry.status = 'needs_review'; entry.message = '请选择正确候选，确认后才会更新媒体信息';
    this.checkpoint(job);
  }
  async findCandidates(job, entry, item) {
    delete entry.candidateSearchWarning;
    const names = entry.type === 'Movie' ? movieSearchNames(entry.identity.name) : [entry.identity.name];
    this.update(job, `搜索候选：${names[0]}`);
    let candidates = await this.services.jellyfin.search(item, { ...entry.identity, name: names[0] });
    if (entry.type === 'Movie') {
      for (const name of names.slice(1)) {
        if (candidates.some(c => hasIdentity(c) && (entry.identity.year == null || c.ProductionYear === entry.identity.year))) break;
        this.update(job, `补查电影候选：${name}`);
        try { candidates = [...await this.services.jellyfin.search(item, { ...entry.identity, name }), ...candidates]; }
        catch (error) { entry.candidateSearchWarning = redact(error.message, this.secrets); }
      }
    }
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
    if (entry.intent && entry.phase !== 'completed') {
      const result = await reconcileIntent(entry.intent, this.services);
      if (result.state === 'matched') { await completeReconciled(job, entry, result.item, this.services); this.checkpoint(job); if (job.parentJobId) this.resolveParent(job.parentJobId, entry); return; }
      if (result.state !== 'unchanged') throw new AppError(result.reason ?? '执行结果待核对', 409);
    }
    entry.selectedCandidate = structuredClone(candidate);
    const item = await this.services.mediaLibrary.ensureItem(entry.itemId, { libraryId: entry.libraryId ?? job.input.libraryId, type: entry.type });
    if (item.Type !== entry.type) throw new AppError('媒体类型已变化，请重新扫描', 409);
    if (item.Path !== entry.path) throw new AppError('媒体路径已变化，请重新扫描', 409);
    this.update(job, `应用候选：${candidate.Name}`); entry.status = 'running';
    const { candidateId, ...remote } = candidate;
    entry.intent = { kind: 'jellyfin.apply', sourceScope: this.scope, target: { itemId: entry.itemId, type: entry.type, libraryId: item.LibraryId, path: item.Path, before: { Name: item.Name, ProductionYear: item.ProductionYear, ProviderIds: item.ProviderIds } }, expected: remote };
    entry.phase = 'prepared'; this.checkpoint(job);
    // Successful submission completes identification; Jellyfin loads metadata asynchronously.
    await this.services.jellyfin.apply(entry.itemId, remote, item);
    entry.phase = 'verified'; this.checkpoint(job);
    if (!job.input.correction) this.services.mediaLibrary.markIdentified(item);
    entry.confirmed = { Name: remote.Name, ProductionYear: remote.ProductionYear, ProviderIds: structuredClone(remote.ProviderIds) };
    entry.status = 'completed'; entry.phase = 'completed'; delete entry.error; delete entry.message;
    this.checkpoint(job);
    if (job.parentJobId) this.resolveParent(job.parentJobId, entry);
    this.update(job, '提交后台元数据刷新');
    try { await this.services.jellyfin.refreshItem(entry.itemId, { full: true }); }
    catch (error) { entry.refreshWarning = redact(error.message, this.secrets); }
  }
  retry(id) {
    this.ensureCapacity();
    const job = this.get(id), failed = job.items.filter(i => i.status === 'failed');
    for (const entry of job.recovery ?? []) if (!failed.some(i => i.itemId === entry.itemId)) failed.push(entry);
    if (!['failed', 'needs_review'].includes(job.status) || (job.status !== 'failed' && !failed.length)) throw new AppError('仅失败任务或失败条目可以重试', 409);
    if (!sameScope(job.sourceScope, this.scope)) throw new AppError('任务来源服务地址已变化，请重新发起操作', 409);
    return this.enqueue(job.input, failed, { scanLibrary: false, parentJobId: id, skipItemIds: [...new Set([...(job.skipItemIds ?? []), ...job.items.filter(i => ['completed', 'needs_review'].includes(i.status)).map(i => i.itemId)])] });
  }
  confirm(id, itemId, candidateId) {
    this.ensureCapacity();
    const job = this.persist(() => this.repository.enqueueAction(id, { kind: 'confirm', payload: { itemId, candidateId } }));
    if (this.ready) this.drain(); return this.get(job.id);
  }
  search(id, itemId, identity) {
    this.ensureCapacity();
    const job = this.persist(() => this.repository.enqueueAction(id, { kind: 'search', payload: { itemId, identity: validateIdentity(identity) } }));
    if (this.ready) this.drain(); return this.get(job.id);
  }
  async close(timeoutMs = 30000) {
    this.stopping = true; const end = Date.now() + timeoutMs;
    while ((this.running || this.recovering) && Date.now() < end) await sleep(25);
    return !this.running && !this.recovering;
  }
}



