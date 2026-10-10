import { randomBytes, timingSafeEqual, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from '../util/error.js';
export function tokenEquals(a, b) { if (typeof a !== 'string' || typeof b !== 'string') return false; const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
const derivePassword = promisify(scrypt);
export class AuthService {
  constructor(config) {
    this.config = config; this.sessions = new Map(); this.attempts = new Map();
    this.passwordSalt = randomBytes(16);
    this.passwordHash = typeof config.adminPassword === 'string' ? derivePassword(config.adminPassword, this.passwordSalt, 32) : undefined;
  }
  prune() {
    const now = Date.now();
    for (const [id, session] of this.sessions) if (session.expires <= now) this.sessions.delete(id);
    for (const [ip, attempt] of this.attempts) if (attempt.expires <= now) this.attempts.delete(ip);
  }
  async login(username, password, ip) {
    this.prune();
    const attempt = this.attempts.get(ip) ?? { count: 0, expires: Date.now() + 15 * 60000 };
    if (attempt.count >= 10) throw new AppError('登录尝试过多，请稍后再试', 429);
    attempt.count++; this.attempts.set(ip, attempt);
    if (this.attempts.size > 1000) this.attempts.delete(this.attempts.keys().next().value);
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 128 || password.length > 1024 || !this.passwordHash) throw new AppError('用户名或密码错误', 401);
    const expected = await this.passwordHash, actual = await derivePassword(password, this.passwordSalt, 32);
    if (!timingSafeEqual(actual, expected) || !tokenEquals(username, this.config.adminUsername)) throw new AppError('用户名或密码错误', 401);
    this.attempts.delete(ip);
    if (this.sessions.size >= 200) this.sessions.delete(this.sessions.keys().next().value);
    const id = randomBytes(32).toString('hex'), session = { csrfToken: randomBytes(24).toString('hex'), expires: Date.now() + this.config.sessionMs };
    this.sessions.set(id, session); return { id, ...session };
  }
  session(id) { this.prune(); return this.sessions.get(id); }
  logout(id) { this.sessions.delete(id); }
  authenticateMaintenance(ctx) {
    if (typeof this.config.workflowToken !== 'string' || this.config.workflowToken.length < 24) throw new AppError('清理接口需要配置至少 24 位的 WORKFLOW_API_TOKEN', 503);
    const auth = ctx.get('Authorization');
    if (!auth.startsWith('Bearer ') || !tokenEquals(auth.slice(7), this.config.workflowToken)) throw new AppError('清理接口认证失败', 401);
  }
  authenticate(ctx, webhook = false) {
    const auth = ctx.get('Authorization'), bearer = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (webhook) { if (this.config.webhookAuthRequired === false) return; if (!tokenEquals(bearer, this.config.workflowToken)) throw new AppError('下载通知认证失败', 401); return; }
    const session = this.session(ctx.cookies.get('media_session', { signed: false }));
    if (!session) throw new AppError('请登录管理面板', 401);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) {
      if (!tokenEquals(ctx.get('X-CSRF-Token'), session.csrfToken)) throw new AppError('CSRF 校验失败', 403);
    }
    ctx.state.session = session;
  }
}
