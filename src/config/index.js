import { AppError } from '../util/error.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readConfigFile } from '../util/config-file.js';
export const CONFIG_FILE = path.resolve('data/config.json');
export const DEFAULT_CONFIG = {
  HOST: '0.0.0.0', PORT: 3000, PUBLIC_URL: 'http://localhost:3000/', COOKIE_SECURE: false, TRUST_PROXY: false,
  QBT_URL: 'http://localhost:8080/', JELLYFIN_URL: 'http://localhost:8096/', DEEPSEEK_URL: 'https://api.deepseek.com/', DEEPSEEK_MODEL: 'deepseek-flash',
  WORKFLOW_API_TOKEN: '', WEBHOOK_AUTH_ENABLED: false, SESSION_TTL_MS: 28800000,
  QBT_PATH_PREFIX: '', JELLYFIN_PATH_PREFIX: '', MEDIA_CURSOR_FILE: 'data/media-cursors.json',
  REQUEST_TIMEOUT_MS: 15000, POLL_INTERVAL_MS: 2000, SCAN_TIMEOUT_MS: 600000, VERIFY_TIMEOUT_MS: 120000,
  TORRENT_FILES_TIMEOUT_MS: 120000, INGEST_RETRIES: 2, MAX_JOBS: 200, MAX_QUEUE: 30, JOB_TTL_MS: 86400000, SHUTDOWN_TIMEOUT_MS: 30000,
  torrentCleanup: { deleteFiles: false }
};
const fields = {
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
export function loadConfig(filename = CONFIG_FILE) {
  if (!existsSync(filename)) return null;
  return validateConfig(readConfigFile(filename), filename);
}
export function validateConfig(document, filename = CONFIG_FILE) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new AppError('配置必须是 JSON 对象');
  const values = { ...DEFAULT_CONFIG, ...document };
  const config = { configFile: path.resolve(filename), pathMapping: {} };
  for (const [key, [field, type]] of Object.entries(fields)) {
    if (values[key] === undefined) continue;
    if (typeof values[key] !== type) throw new AppError(`${key} 必须是 JSON ${type}`);
    if (type === 'number') {
      const [min, max] = { PORT: [1, 65535], INGEST_RETRIES: [0, 5], MAX_JOBS: [10, 10000], MAX_QUEUE: [1, 1000] }[key] ?? [1, 1e8];
      if (!Number.isInteger(values[key]) || values[key] < min || values[key] > max) throw new AppError(`${key} 配置无效`);
    }
    let value = values[key];
    if (['PUBLIC_URL', 'QBT_URL', 'JELLYFIN_URL', 'DEEPSEEK_URL', 'WORKFLOW_CALLBACK_URL'].includes(key)) {
      if (key === 'WORKFLOW_CALLBACK_URL' && value === '') continue;
      let url; try { url = new URL(value); } catch { throw new AppError(`${key} 必须是完整 URL`); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AppError(`${key} URL 无效`);
      value = url.href.endsWith('/') ? url.href : `${url.href}/`;
      if (key === 'WORKFLOW_CALLBACK_URL') value = value.replace(/\/$/, '');
    }
    if (field.includes('.')) config.pathMapping[field.split('.')[1]] = value;
    else config[field] = value;
  }
  for (const key of ['HOST', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'QBT_API_KEY', 'JELLYFIN_API_KEY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'MEDIA_CURSOR_FILE']) if (!values[key]?.trim()) throw new AppError(`请设置 ${key}`);
  if (values.ADMIN_PASSWORD.length > 1024) throw new AppError('管理员密码长度无效');
  if (values.WEBHOOK_AUTH_ENABLED && values.WORKFLOW_API_TOKEN.length < 24) throw new AppError('请设置至少 24 位的 WORKFLOW_API_TOKEN');
  if (!values.torrentCleanup || Array.isArray(values.torrentCleanup) || typeof values.torrentCleanup.deleteFiles !== 'boolean') throw new AppError('torrentCleanup 配置无效');
  return config;
}
