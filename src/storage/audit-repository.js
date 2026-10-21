export const secretFields = new Set(['ADMIN_PASSWORD','QBT_API_KEY','JELLYFIN_API_KEY','DEEPSEEK_API_KEY','WORKFLOW_API_TOKEN','passkey','recoveryToken']);
export class AuditRepository {
  constructor(database) { this.database = database; this.db = database.connection; }
  append(source, revision, before, after) {
    const changes = [];
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
      changes.push(secretFields.has(field) ? { field, before: before[field] ? '已设置' : '未设置', after: after[field] ? '已更新' : '未设置' } : { field, before: before[field] ?? null, after: after[field] ?? null });
    }
    this.db.prepare('INSERT INTO configuration_audit(created_at,source,revision,changes) VALUES(?,?,?,?)').run(Date.now(), source, String(revision), JSON.stringify(changes));
    this.prune();
  }
  prune() {
    this.db.prepare('DELETE FROM configuration_audit WHERE created_at<?').run(Date.now() - 90 * 86400000);
    this.db.exec('DELETE FROM configuration_audit WHERE id NOT IN (SELECT id FROM configuration_audit ORDER BY id DESC LIMIT 10000)');
  }
  list({ page = 1, pageSize = 20 } = {}) {
    return { items: this.db.prepare('SELECT * FROM configuration_audit ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize,(page-1)*pageSize).map(r=>({ id:r.id, createdAt:new Date(r.created_at).toISOString(), source:r.source, revision:r.revision, changes:JSON.parse(r.changes) })), total:this.db.prepare('SELECT count(*) AS n FROM configuration_audit').get().n, page,pageSize };
  }
}
