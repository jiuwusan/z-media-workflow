import { AppError } from '../util/error.js';
export function loadConfig(env = process.env) {
  const number = (key, fallback, min = 1, max = 1e8) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new AppError(`${key} 配置无效`);
    return n;
  };
  const url = (key, fallback) => {
    const value = env[key] ?? fallback;
    let u; try { u = new URL(value); } catch { throw new AppError(`${key} 必须是完整 URL`); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new AppError(`${key} URL 无效`);
    return u.href.endsWith('/') ? u.href : `${u.href}/`;
  };
  const required = key => { if (!env[key]) throw new AppError(`请设置 ${key}`); return env[key]; };
  const webhookAuthRequired = env.WEBHOOK_AUTH_ENABLED !== 'false';
  const adminUsername = required('ADMIN_USERNAME'), adminPassword = required('ADMIN_PASSWORD');
  if (adminUsername.length > 128 || adminPassword.length > 1024) throw new AppError('管理员用户名或密码长度无效');
  const workflowToken = webhookAuthRequired ? required('WORKFLOW_API_TOKEN') : (env.WORKFLOW_API_TOKEN ?? '');
  if (webhookAuthRequired && workflowToken.length < 24) throw new AppError('回调令牌需至少 24 位');
  return {
    host: env.HOST ?? '127.0.0.1', port: number('PORT', 3000, 1, 65535),
    publicUrl: url('PUBLIC_URL', 'http://localhost:3000/'), secureCookie: env.COOKIE_SECURE === 'true', trustProxy: env.TRUST_PROXY === 'true',
    callbackUrl: env.WORKFLOW_CALLBACK_URL ? url('WORKFLOW_CALLBACK_URL').replace(/\/$/, '') : undefined,
    qbtUrl: url('QBT_URL', 'http://localhost:8080/'), qbtKey: required('QBT_API_KEY'),
    jellyfinUrl: url('JELLYFIN_URL', 'http://localhost:8096/'), jellyfinKey: required('JELLYFIN_API_KEY'),
    deepseekUrl: url('DEEPSEEK_URL', 'https://api.deepseek.com/'), deepseekKey: required('DEEPSEEK_API_KEY'), deepseekModel: env.DEEPSEEK_MODEL ?? 'deepseek-flash',
    adminUsername, adminPassword, workflowToken, webhookAuthRequired, sessionMs: number('SESSION_TTL_MS', 8 * 3600000),
    pathMapping: { from: env.QBT_PATH_PREFIX ?? '', to: env.JELLYFIN_PATH_PREFIX ?? '' },
    requestTimeoutMs: number('REQUEST_TIMEOUT_MS', 15000), pollMs: number('POLL_INTERVAL_MS', 2000),
    scanTimeoutMs: number('SCAN_TIMEOUT_MS', 600000), verifyTimeoutMs: number('VERIFY_TIMEOUT_MS', 120000),
    ingestRetries: number('INGEST_RETRIES', 2, 0, 5), maxJobs: number('MAX_JOBS', 200, 10, 10000), maxQueue: number('MAX_QUEUE', 30, 1, 1000),
    jobTtlMs: number('JOB_TTL_MS', 86400000), shutdownMs: number('SHUTDOWN_TIMEOUT_MS', 30000)
  };
}
