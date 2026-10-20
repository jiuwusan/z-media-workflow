import { normalizeName, providerEntries } from '../util/media.js';
const sameProviders = (a, b) => JSON.stringify(providerEntries(a).sort()) === JSON.stringify(providerEntries(b).sort());
export const sameScope = (a, b) => a?.jellyfinUrl === b?.jellyfinUrl && a?.qbtUrl === b?.qbtUrl;
export function matchesExpectedMedia(item, intent) {
  const ids = new Map(providerEntries(item)), expected = intent.expected;
  return providerEntries(expected).length > 0 && providerEntries(expected).every(([k, v]) => ids.get(k) === v)
    && normalizeName(item.Name) === normalizeName(expected.Name)
    && (expected.ProductionYear == null || item.ProductionYear === expected.ProductionYear);
}
export async function reconcileIntent(intent, services) {
  try {
    if (intent.kind !== 'jellyfin.apply') return { state: 'unknown', reason: '暂不支持核对此操作' };
    const target = intent.target;
    const item = await services.mediaLibrary.ensureItem(target.itemId, { libraryId: target.libraryId, type: target.type });
    if (item.Id !== target.itemId || item.Type !== target.type || item.Path !== target.path || (target.libraryId && item.LibraryId !== target.libraryId)) return { state: 'conflict', reason: '媒体路径、媒体库或类型已变化' };
    if (matchesExpectedMedia(item, intent)) return { state: 'matched', item };
    const before = target.before;
    if (before && item.Name === before.Name && item.ProductionYear === before.ProductionYear && sameProviders(item, before)) return { state: 'unchanged', item };
    return { state: 'conflict', reason: '媒体信息已变化，不能确认本次写入结果' };
  } catch { return { state: 'unknown', reason: '执行结果待核对，目标暂不可读取' }; }
}
export function interrupt(entry, reason) {
  entry.status = 'failed'; entry.recoveryState = 'interrupted'; entry.error = reason;
}
export async function completeReconciled(job, entry, item, services) {
  entry.phase = 'verified';
  if (entry.intent.kind === 'jellyfin.apply') {
    if (!job.input.correction) await services.mediaLibrary.markIdentified(item);
    const { Name, ProductionYear, ProviderIds } = entry.intent.expected;
    entry.confirmed = { Name, ...(ProductionYear == null ? {} : { ProductionYear }), ProviderIds };
  }
  entry.phase = 'completed'; entry.status = 'completed'; delete entry.error; delete entry.recoveryState;
}
export function summarizeJob(job) {
  job.status = job.items.some(i => i.status === 'needs_review') ? 'needs_review' : job.items.some(i => i.status === 'failed') || !job.items.length ? 'failed' : 'completed';
  job.stage = job.status === 'completed' ? '恢复核对完成' : job.status === 'needs_review' ? '等待人工确认' : '执行中断，请检查后重试';
  job.updatedAt = new Date().toISOString();
}
export async function recoverRunningActions({ repository, services, sourceScope }) {
  for (const action of repository.runningActions()) {
    const job = repository.get(action.jobId);
    for (const old of job.recovery ?? []) if (!job.items.some(i => i.itemId === old.itemId)) job.items.push(old);
    for (const entry of job.items) {
      if (entry.status === 'completed' || (entry.status === 'needs_review' && !entry.intent)) continue;
      if (!sameScope(job.sourceScope, sourceScope)) { interrupt(entry, '任务来源服务地址已变化，请重新发起操作'); continue; }
      if (!entry.intent || entry.phase === 'completed') { interrupt(entry, '服务退出导致执行中断，请重试'); continue; }
      const result = await reconcileIntent(entry.intent, services);
      if (result.state === 'matched') {
        try { await completeReconciled(job, entry, result.item, services); }
        catch { interrupt(entry, '外部写入已核实，本地游标收尾失败，请重试'); }
      } else interrupt(entry, result.reason ?? '操作尚未完成，请检查后重试');
    }
    summarizeJob(job);
    if (job.status !== 'completed') { job.recoveryState = 'interrupted'; job.error = sameScope(job.sourceScope, sourceScope) ? '服务退出导致执行中断，请检查条目后重试' : '任务来源服务地址已变化，请重新发起操作'; }
    repository.save(job, { actionId: action.id, actionStatus: job.status === 'completed' ? 'completed' : 'failed' });
  }
}
