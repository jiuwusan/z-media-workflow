import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './error.js';
export function readConfigFile(filename) {
  if (!filename || !existsSync(filename)) return {};
  try {
    const value = JSON.parse(readFileSync(filename, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid config');
    return value;
  } catch { throw new AppError('config.json 配置文件无效，请修复后重新启动', 500); }
}
export function writeConfigFile(filename, document) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, filename);
  } finally { rmSync(temporary, { force: true }); }
}
