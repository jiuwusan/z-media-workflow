import { AppError } from '../util/error.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readConfigFile, writeConfigFile } from '../util/config-file.js';
import { CleanupSettingsStore } from '../util/cleanup-settings.js';
export const CONFIG_FIELDS = {
  HOST: ['host', 'string'], PORT: ['port', 'number'], PUBLIC_URL: ['publicUrl', 'string'],
  COOKIE_SECURE: ['secureCookie', 'boolean'], TRUST_PROXY: ['trustProxy', 'boolean'],
  WORKFLOW_CALLBACK_URL: ['callbackUrl', 'string'], QBT_URL: ['qbtUrl', 'string'], QBT_API_KEY: ['qbtKey', 'string'],
  JELLYFIN_URL: ['jellyfinUrl', 'string'], JELLYFIN_API_KEY: ['jellyfinKey', 'string'],
  DEEPSEEK_URL: ['deepseekUrl', 'string'], DEEPSEEK_API_KEY: ['deepseekKey', 'string'], DEEPSEEK_MODEL: ['deepseekModel', 'string'],
  ADMIN_USERNAME: ['adminUsername', 'string'], ADMIN_PASSWORD: ['adminPassword', 'string'], WORKFLOW_API_TOKEN: ['workflowToken', 'string'],
  WEBHOOK_AUTH_ENABLED: ['webhookAuthRequired', 'boolean'], SESSION_TTL_MS: ['sessionMs', 'number'],
  QBT_PATH_PREFIX: ['pathMapping.from', 'string'], JELLYFIN_PATH_PREFIX: ['pathMapping.to', 'string'],
  MEDIA_CURSOR_FILE: ['mediaCursorFile', 'string'], REQUEST_TIMEOUT_MS: ['requestTimeoutMs', 'number'], POLL_INTERVAL_MS: ['pollMs', 'number'],
  SCAN_TIMEOUT_MS: ['scanTimeoutMs', 'number'], VERIFY_TIMEOUT_MS: ['verifyTimeoutMs', 'number'], TORRENT_FILES_TIMEOUT_MS: ['torrentFilesTimeoutMs', 'number'],
  INGEST_RETRIES: ['ingestRetries', 'number'], MAX_JOBS: ['maxJobs', 'number'], MAX_QUEUE: ['maxQueue', 'number'],
  JOB_TTL_MS: ['jobTtlMs', 'number'], SHUTDOWN_TIMEOUT_MS: ['shutdownMs', 'number']
};
export function loadConfig(env = process.env, { persist = true } = {}) {
  if (!persist) return parseEnvironmentConfig(env);
  const filename = path.resolve(env.CONFIG_FILE?.trim() || 'data/config.json');
  const document = readConfigFile(filename);
  // Validate cleanup settings before migrating any credentials or writing the file.
  const cleanup = new CleanupSettingsStore(filename).get();
  const hasApplicationSettings = Object.keys(CONFIG_FIELDS).some(key => Object.hasOwn(document, key));
  if (hasApplicationSettings) {
    const values = {};
    for (const [key, [, type]] of Object.entries(CONFIG_FIELDS)) {
      if (!Object.hasOwn(document, key)) continue;
      if (typeof document[key] !== type) throw new AppError(`${key} 必须是 JSON ${type}`);
      values[key] = String(document[key]);
    }
    const config = parseEnvironmentConfig(values);
    if (document.torrentCleanup === undefined) {
      const store = new CleanupSettingsStore(filename, env.CLEANUP_SETTINGS_FILE?.trim() || 'data/cleanup-settings.json');
      store.set(store.get());
    }
    return { ...config, configFile: filename, legacyCleanupSettingsFile: undefined };
  }
  const config = parseEnvironmentConfig(env);
  const migrated = { ...document };
  for (const [key, [field]] of Object.entries(CONFIG_FIELDS)) {
    const value = field.split('.').reduce((value, part) => value?.[part], config);
    if (value !== undefined) migrated[key] = value;
  }
  if (document.torrentCleanup === undefined && existsSync(config.legacyCleanupSettingsFile)) {
    const legacy = readConfigFile(config.legacyCleanupSettingsFile);
    if (typeof legacy.deleteFiles !== 'boolean') throw new AppError('旧清理配置文件无效，请修复后重新启动', 500);
    cleanup.deleteFiles = legacy.deleteFiles;
  }
  migrated.torrentCleanup = document.torrentCleanup ?? cleanup;
  writeConfigFile(filename, migrated);
  return { ...config, configFile: filename, legacyCleanupSettingsFile: undefined };
}
function parseEnvironmentConfig(env) {
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
    mediaCursorFile: env.MEDIA_CURSOR_FILE?.trim() || 'data/media-cursors.json',
    configFile: env.CONFIG_FILE?.trim() || 'data/config.json',
    legacyCleanupSettingsFile: env.CLEANUP_SETTINGS_FILE?.trim() || 'data/cleanup-settings.json',
    requestTimeoutMs: number('REQUEST_TIMEOUT_MS', 15000), pollMs: number('POLL_INTERVAL_MS', 2000),
    scanTimeoutMs: number('SCAN_TIMEOUT_MS', 600000), verifyTimeoutMs: number('VERIFY_TIMEOUT_MS', 120000),
    torrentFilesTimeoutMs: number('TORRENT_FILES_TIMEOUT_MS', 120000),
    ingestRetries: number('INGEST_RETRIES', 2, 0, 5), maxJobs: number('MAX_JOBS', 200, 10, 10000), maxQueue: number('MAX_QUEUE', 30, 1, 1000),
    jobTtlMs: number('JOB_TTL_MS', 86400000), shutdownMs: number('SHUTDOWN_TIMEOUT_MS', 30000)
  };
}
