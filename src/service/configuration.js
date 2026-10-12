import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DEFAULT_CONFIG, CONFIG_FIELDS, validateConfig } from '../config/index.js';
import { readConfigFile, writeConfigFile } from '../util/config-file.js';
import { AppError } from '../util/error.js';
const secrets = new Set(['ADMIN_PASSWORD', 'QBT_API_KEY', 'JELLYFIN_API_KEY', 'DEEPSEEK_API_KEY', 'WORKFLOW_API_TOKEN']);
const revision = document => createHash('sha256').update(JSON.stringify(document)).digest('hex');
const fieldValue = (config, field) => field.split('.').reduce((value, key) => value?.[key], config);
export class ConfigurationService {
  constructor(config) { this.runtime = config; this.filename = config.configFile; }
  read() {
    if (!this.filename || !existsSync(this.filename)) throw new AppError('配置文件不存在，请恢复配置文件后重试', 503);
    const document = readConfigFile(this.filename); validateConfig(document, this.filename); return document;
  }
  view(document) {
    const saved = validateConfig(document, this.filename), values = {}, secretFields = {};
    for (const [key, [, type]] of Object.entries(CONFIG_FIELDS)) {
      const value = document[key] ?? DEFAULT_CONFIG[key] ?? (type === 'string' ? '' : undefined);
      if (secrets.has(key)) secretFields[key] = Boolean(value);
      else values[key] = value;
    }
    const restartRequired = Object.values(CONFIG_FIELDS).some(([field]) => fieldValue(saved, field) !== fieldValue(this.runtime, field));
    return { values, secretFields, revision: revision(document), restartRequired };
  }
  get() { return this.view(this.read()); }
  save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['values', 'revision'].includes(key)) || !input.values || typeof input.values !== 'object' || Array.isArray(input.values) || typeof input.revision !== 'string') throw new AppError('配置保存参数无效');
    const document = this.read();
    if (input.revision !== revision(document)) throw new AppError('配置已被其他操作修改，请重新读取后再保存', 409);
    const next = { ...document };
    for (const [key, value] of Object.entries(input.values)) {
      if (!Object.hasOwn(CONFIG_FIELDS, key)) throw new AppError('存在不支持的配置项');
      if (secrets.has(key) && value === '') continue;
      if (key === 'ADMIN_PASSWORD' && (typeof value !== 'string' || value.length < 12)) throw new AppError('管理员密码至少 12 位');
      next[key] = value;
    }
    validateConfig(next, this.filename);
    writeConfigFile(this.filename, next);
    return this.view(next);
  }
}
