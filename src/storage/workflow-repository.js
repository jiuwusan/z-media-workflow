import { randomUUID } from 'node:crypto';
import { AppError } from '../util/error.js';

export function sourceScope(config) {
  const normalize = value => value ? new URL(value).href.replace(/\/*$/, '/') : '';
  return { jellyfinUrl: normalize(config.jellyfinUrl), qbtUrl: normalize(config.qbtUrl) };
}
const timestamp = () => new Date().toISOString();
const protectedJob = job => ['queued', 'running', 'needs_review'].includes(job.status) || job.items.some(i => i.intent && i.phase !== 'completed');
export class WorkflowRepository {
  constructor(database, limits = {}) {
    this.database = database; this.db = database.connection;
    this.limits = { maxJobs: 200, maxQueue: 30, jobTtlMs: 86400000, ...limits };
  }
  get(id) {
    const row = this.db.prepare('SELECT payload FROM workflow_jobs WHERE id=?').get(id);
    if (!row) throw new AppError('任务不存在或已过期', 404);
    return { ...JSON.parse(row.payload), items: this.db.prepare('SELECT payload FROM workflow_items WHERE job_id=? ORDER BY position').all(id).map(r => JSON.parse(r.payload)) };
  }
  list({ page = 1, pageSize = 20 } = {}) {
    this.prune();
    return { items: this.db.prepare('SELECT payload, item_count FROM workflow_jobs ORDER BY sequence DESC LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize).map(r => ({ ...JSON.parse(r.payload), itemCount: r.item_count })), total: this.db.prepare('SELECT count(*) AS n FROM workflow_jobs').get().n, page, pageSize };
  }
  summary() {
    const counts = Object.fromEntries(this.db.prepare('SELECT status, count(*) AS n FROM workflow_jobs GROUP BY status').all().map(r => [r.status, r.n]));
    return { counts, queued: this.db.prepare("SELECT count(*) AS n FROM workflow_actions WHERE status='queued'").get().n, running: Boolean(this.db.prepare("SELECT 1 FROM workflow_actions WHERE status='running' LIMIT 1").get()) };
  }
  prune(now = Date.now(), reserve = false) {
    const work = () => {
      this.db.prepare('DELETE FROM workflow_jobs WHERE protected=0 AND updated_at<?').run(new Date(now - this.limits.jobTtlMs).toISOString());
      const total = this.db.prepare('SELECT count(*) AS n FROM workflow_jobs').get().n;
      const excess = total - this.limits.maxJobs + (reserve ? 1 : 0);
      if (excess > 0) this.db.prepare('DELETE FROM workflow_jobs WHERE id IN (SELECT id FROM workflow_jobs WHERE protected=0 ORDER BY sequence LIMIT ?)').run(excess);
    };
    if (this.db.isTransaction) work(); else this.database.transaction(work);
  }
  capacity() {
    if (this.summary().queued >= this.limits.maxQueue) throw new AppError('任务队列已满，请稍后重试', 429);
  }
  accept({ input = {}, sourceScope: scope, recovery = [], options = {}, parentJobId }) {
    return this.database.transaction(() => {
      this.prune();
      const dedupe = input.hash ? JSON.stringify([scope.qbtUrl, input.hash, input.event ?? 'completed']) : input.checkExisting ? JSON.stringify([scope.qbtUrl, 'checkExisting']) : null;
      if (dedupe && !parentJobId && !recovery.length) {
        const row = this.db.prepare(`SELECT id FROM workflow_jobs WHERE dedupe_key=? AND
          (status IN ('queued','running') OR (protected=1 AND status='failed') OR (?=0 AND status!='failed'))
          ORDER BY sequence DESC LIMIT 1`).get(dedupe, Number(Boolean(options.recheck || input.checkExisting)));
        if (row) return this.get(row.id);
      }
      this.capacity(); this.prune(Date.now(), true);
      if (this.db.prepare('SELECT count(*) AS n FROM workflow_jobs').get().n >= this.limits.maxJobs) throw new AppError('任务记录已达上限，请处理待确认或中断任务', 429);
      const job = { id: randomUUID(), input: structuredClone(input), sourceScope: scope, status: 'queued', stage: '排队', createdAt: timestamp(), updatedAt: timestamp(), items: [], ...(parentJobId ? { parentJobId } : {}) };
      this.db.prepare(`INSERT INTO workflow_jobs(id,status,stage,created_at,updated_at,source_scope,dedupe_key,payload,protected) VALUES(?,?,?,?,?,?,?,?,1)`).run(job.id, job.status, job.stage, job.createdAt, job.updatedAt, JSON.stringify(scope), dedupe, '{}');
      this.saveRecord(job);
      this.insertAction(job.id, parentJobId ? 'retry' : 'run', { options, recovery, ...(parentJobId ? { parentJobId } : {}) });
      return this.get(job.id);
    });
  }
  insertAction(jobId, kind, payload) {
    this.db.prepare('INSERT INTO workflow_actions(id,job_id,kind,status,payload,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), jobId, kind, 'queued', JSON.stringify(payload), timestamp());
  }
  enqueueAction(jobId, { kind, payload }) {
    return this.database.transaction(() => {
      this.capacity(); const job = this.get(jobId);
      if (job.status !== 'needs_review') throw new AppError('该任务当前不允许确认', 409);
      const entry = job.items.find(i => i.itemId === payload.itemId && i.status === 'needs_review');
      if (!entry) throw new AppError('待确认媒体不存在', 404);
      const saved = structuredClone(payload);
      if (kind === 'confirm') {
        const candidate = entry.candidates.find(c => c.candidateId === payload.candidateId);
        if (!candidate) throw new AppError('候选不存在，请重新加载任务');
        saved.candidate = structuredClone(candidate);
      }
      if (kind === 'search' && job.input.correction) job.input.identity = saved.identity;
      job.status = 'queued'; job.stage = '排队'; job.updatedAt = timestamp();
      this.saveRecord(job); this.insertAction(jobId, kind, saved); return job;
    });
  }
  claimNext() {
    return this.database.transaction(() => {
      const row = this.db.prepare("SELECT * FROM workflow_actions WHERE status='queued' ORDER BY sequence LIMIT 1").get();
      if (!row) return null;
      this.db.prepare("UPDATE workflow_actions SET status='running',started_at=? WHERE id=?").run(timestamp(), row.id);
      const job = this.get(row.job_id); job.status = 'running'; job.stage = '处理'; job.updatedAt = timestamp(); this.saveRecord(job);
      return this.action(row, 'running');
    });
  }
  action(row, status = row.status) { return { id: row.id, jobId: row.job_id, kind: row.kind, status, payload: JSON.parse(row.payload), sequence: row.sequence }; }
  runningActions() { return this.db.prepare("SELECT * FROM workflow_actions WHERE status='running' ORDER BY sequence").all().map(r => this.action(r)); }
  saveRecord(job) {
    const { items, ...payload } = job;
    this.db.prepare('UPDATE workflow_jobs SET status=?,stage=?,updated_at=?,item_count=?,protected=?,payload=? WHERE id=?').run(job.status, job.stage, job.updatedAt, items.length, Number(protectedJob(job)), JSON.stringify(payload), job.id);
    this.db.prepare('DELETE FROM workflow_items WHERE job_id=?').run(job.id);
    const insert = this.db.prepare('INSERT INTO workflow_items(job_id,entry_key,position,status,phase,payload) VALUES(?,?,?,?,?,?)');
    items.forEach((entry, index) => insert.run(job.id, entry.entryKey ?? entry.itemId ?? String(index), index, entry.status, entry.phase ?? null, JSON.stringify(entry)));
  }
  save(job, { actionId, actionStatus } = {}) {
    this.database.transaction(() => {
      this.saveRecord(job);
      if (actionId) this.db.prepare('UPDATE workflow_actions SET status=?,completed_at=? WHERE id=?').run(actionStatus, timestamp(), actionId);
    });
  }
}

