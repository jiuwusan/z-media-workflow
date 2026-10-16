import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { CONFIG_FILE, DEFAULT_CONFIG, loadConfig, validateConfig } from '../config/index.js';
import { writeConfigFile } from '../util/config-file.js';
import { AppError } from '../util/error.js';
import { tokenEquals } from './auth.js';
const allowed = ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'PUBLIC_URL', 'QBT_URL', 'QBT_API_KEY', 'JELLYFIN_URL', 'JELLYFIN_API_KEY', 'DEEPSEEK_URL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'WORKFLOW_CALLBACK_URL', 'WEBHOOK_AUTH_ENABLED', 'WORKFLOW_API_TOKEN', 'COOKIE_SECURE', 'TRUST_PROXY'];
export class SetupService {
  constructor(filename = CONFIG_FILE) {
    this.filename = filename; this.config = loadConfig(filename); this.nonce = randomBytes(24).toString('hex');
    this.bootstrap = { host: '0.0.0.0', port: 3000, publicUrl: 'http://localhost:3000/', trustProxy: false, shutdownMs: 30000 };
  }
  get initialized() { return Boolean(this.config); }
  status(ctx) {
    if (this.initialized) return { initialized: true };
    ctx.cookies.set('media_setup', this.nonce, { httpOnly: true, sameSite: 'strict', signed: false, maxAge: 30 * 60000, path: '/' });
    return { initialized: false, csrfToken: this.nonce };
  }
  complete(ctx, prepare = () => {}) {
    if (this.initialized || existsSync(this.filename)) throw new AppError('服务已完成初始化，不能重复配置', 409);
    if (!tokenEquals(ctx.cookies.get('media_setup', { signed: false }), this.nonce) || !tokenEquals(ctx.get('X-CSRF-Token'), this.nonce)) throw new AppError('初始化 CSRF 校验失败，请刷新页面', 403);
    const input = ctx.request.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new AppError('初始化参数无效');
    if (typeof input.ADMIN_PASSWORD !== 'string' || input.ADMIN_PASSWORD.length < 8) throw new AppError('管理员密码至少 8 位');
    const token = input.WORKFLOW_API_TOKEN === undefined || input.WORKFLOW_API_TOKEN === '' ? randomBytes(32).toString('hex') : input.WORKFLOW_API_TOKEN;
    const document = { ...DEFAULT_CONFIG, ...input, WORKFLOW_API_TOKEN: token, torrentCleanup: { deleteFiles: false } };
    const config = validateConfig(document, this.filename);
    prepare(config);
    try { writeConfigFile(this.filename, document, { exclusive: true }); }
    catch (error) { if (error.code === 'EEXIST') throw new AppError('服务已完成初始化，不能重复配置', 409); throw new AppError('配置保存失败，请检查数据目录权限', 500); }
    this.config = config;
    ctx.cookies.set('media_setup', null, { signed: false, path: '/' });
    return config;
  }
}
