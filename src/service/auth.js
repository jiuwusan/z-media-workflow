import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../util/error.js';
export function tokenEquals(a, b) { if (typeof a !== 'string' || typeof b !== 'string') return false; const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
export class AuthService {
  constructor(config) { this.config = config; this.sessions = new Map(); this.attempts = new Map(); }
  prune() {
    const now = Date.now();
    for (const [id, session] of this.sessions) if (session.expires <= now) this.sessions.delete(id);
    for (const [ip, attempt] of this.attempts) if (attempt.expires <= now) this.attempts.delete(ip);
  }
  login(token, ip) {
    this.prune();
    const attempt = this.attempts.get(ip) ?? { count: 0, expires: Date.now() + 15 * 60000 };
    if (attempt.count >= 10) throw new AppError('登录尝试过多，请稍后再试', 429);
    attempt.count++; this.attempts.set(ip, attempt);
    if (this.attempts.size > 1000) this.attempts.delete(this.attempts.keys().next().value);
    if (!tokenEquals(token, this.config.adminToken)) throw new AppError('管理令牌错误', 401);
    this.attempts.delete(ip);
    if (this.sessions.size >= 200) this.sessions.delete(this.sessions.keys().next().value);
    const id = randomBytes(32).toString('hex'), session = { csrfToken: randomBytes(24).toString('hex'), expires: Date.now() + this.config.sessionMs };
    this.sessions.set(id, session); return { id, ...session };
  }
  session(id) { this.prune(); return this.sessions.get(id); }
  logout(id) { this.sessions.delete(id); }
  checkOrigin(ctx) {
    const allowed = [new URL(this.config.publicUrl).origin, this.config.devOrigin].filter(Boolean);
    if (!allowed.includes(ctx.get('Origin'))) throw new AppError('请求来源不被允许', 403);
  }
  authenticate(ctx, webhook = false) {
    const auth = ctx.get('Authorization'), bearer = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (webhook) { if (!tokenEquals(bearer, this.config.workflowToken)) throw new AppError('下载通知认证失败', 401); return; }
    if (tokenEquals(bearer, this.config.adminToken)) return;
    const session = this.session(ctx.cookies.get('media_session', { signed: false }));
    if (!session) throw new AppError('请登录管理面板', 401);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) {
      this.checkOrigin(ctx);
      if (!tokenEquals(ctx.get('X-CSRF-Token'), session.csrfToken)) throw new AppError('CSRF 校验失败', 403);
    }
    ctx.state.session = session;
  }
}
