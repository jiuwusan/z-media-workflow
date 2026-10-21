import { randomBytes } from 'node:crypto';
import { AppError } from '../util/error.js';
import { digest, passwordRecord } from '../util/credentials.js';
import { AuditRepository } from './audit-repository.js';
export class ApplicationRepository {
  constructor(database) { this.database = database; this.db = database.connection; this.audit = new AuditRepository(database); }
  get initialized() { return Boolean(this.db.prepare('SELECT 1 FROM application_config WHERE id=1').get()); }
  readConfig() {
    const row = this.db.prepare('SELECT * FROM application_config WHERE id=1').get();
    return row ? { document: JSON.parse(row.payload), revision: String(row.revision) } : null;
  }
  credential() {
    const r = this.db.prepare('SELECT * FROM credentials WHERE id=1').get();
    return r ? { username:r.username, password:JSON.parse(r.password), version:r.version, passkeyDigest:r.passkey_digest } : null;
  }
  initialize(input, passkeyDigest, initializeCursors = () => {}) {
    const password = passwordRecord(input.ADMIN_PASSWORD);
    return this.database.transaction(() => {
      if (this.initialized) throw new AppError('服务已完成初始化，不能重复配置',409);
      const { ADMIN_PASSWORD, MEDIA_CURSOR_FILE, ...document } = input;
      this.db.prepare('INSERT INTO application_config VALUES(1,1,?)').run(JSON.stringify(document));
      this.db.prepare('INSERT INTO credentials VALUES(1,?,?,1,?)').run(input.ADMIN_USERNAME,JSON.stringify(password),passkeyDigest);
      initializeCursors();
      this.audit.append('初始化',1,{},input);
      return this.readConfig();
    });
  }
  updateConfig(patch, { revision, source = '管理员' } = {}) {
    const password = patch.ADMIN_PASSWORD ? passwordRecord(patch.ADMIN_PASSWORD) : null;
    return this.database.transaction(() => {
      const current=this.readConfig();
      if (!current) throw new AppError('请先完成初始化',503);
      if (revision !== undefined && revision !== current.revision) throw new AppError('配置已被其他操作修改，请重新读取后再保存',409);
      const { ADMIN_PASSWORD, MEDIA_CURSOR_FILE, ...fields }=patch, document={...current.document,...fields};
      const next=Number(current.revision)+1;
      this.db.prepare('UPDATE application_config SET revision=?,payload=? WHERE id=1').run(next,JSON.stringify(document));
      if (password || document.ADMIN_USERNAME !== current.document.ADMIN_USERNAME) {
        const credential=this.credential();
        this.db.prepare('UPDATE credentials SET username=?,password=?,version=version+1 WHERE id=1').run(document.ADMIN_USERNAME,JSON.stringify(password ?? credential.password));
        this.db.exec('DELETE FROM recovery_tokens');
      }
      this.audit.append(source,next,current.document,{...document,...(password ? {ADMIN_PASSWORD:'已更新'}:{})});
      return this.readConfig();
    });
  }
  replacePassword(password, source='恢复流程') { return this.updateConfig({ADMIN_PASSWORD:password},{source}); }
  rotatePasskey(passkeyDigest) {
    this.database.transaction(() => {
      this.db.prepare('UPDATE credentials SET passkey_digest=? WHERE id=1').run(passkeyDigest);
      this.db.exec('DELETE FROM recovery_tokens');
    });
  }
  attempt(namespace,ip,now=Date.now()) {
    return this.database.transaction(() => {
      this.db.prepare('DELETE FROM auth_attempts WHERE expires<=?').run(now);
      const r=this.db.prepare('SELECT * FROM auth_attempts WHERE namespace=? AND ip=?').get(namespace,ip);
      if (r?.count >= 10) throw new AppError('尝试过多，请稍后重试',429);
      this.db.prepare('INSERT INTO auth_attempts VALUES(?,?,?,?) ON CONFLICT(namespace,ip) DO UPDATE SET count=excluded.count,expires=excluded.expires').run(namespace,ip,(r?.count??0)+1,r?.expires??now+900000);
    });
  }
  clearAttempts(namespace,ip) { this.db.prepare('DELETE FROM auth_attempts WHERE namespace=? AND ip=?').run(namespace,ip); }
  createRecovery(now=Date.now()) {
    const token=randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM recovery_tokens WHERE expires<=? OR used=1').run(now);
    this.db.prepare('INSERT INTO recovery_tokens(digest,version,expires) VALUES(?,?,?)').run(digest(token),this.credential().version,now+300000);
    return token;
  }
  consumeRecovery(token,password,now=Date.now()) {
    return this.database.transaction(() => {
      const r=this.db.prepare('SELECT * FROM recovery_tokens WHERE digest=?').get(digest(token));
      if (!r || r.used || r.expires<=now || r.version!==this.credential().version) throw new AppError('恢复凭证无效或已过期',401);
      this.replacePassword(password);
      this.db.exec('DELETE FROM recovery_tokens');
    });
  }
}
