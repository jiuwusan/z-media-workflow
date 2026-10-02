import { AppError } from './error.js';
export function text(value, label, { optional = false, max = 2000 } = {}) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) throw new AppError(`${label}无效`);
  return value;
}
export function pagination(query) {
  const page = Number(query.page ?? 1), pageSize = Number(query.pageSize ?? 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new AppError('分页参数无效');
  return { page, pageSize };
}
export function mediaType(type) { if (type !== undefined && !['Movie', 'Series'].includes(type)) throw new AppError('媒体类型只能是 Movie 或 Series'); return type; }
export function scanInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('请求体必须是对象');
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') throw new AppError('dryRun 必须为布尔值');
  if (body.itemIds !== undefined && (!Array.isArray(body.itemIds) || body.itemIds.length > 200 || body.itemIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/i.test(id)))) throw new AppError('媒体 ID 列表无效');
  return { dryRun: body.dryRun ?? false, ...(body.libraryId ? { libraryId: text(body.libraryId, '库 ID', { max: 64 }) } : {}), ...(body.type ? { type: mediaType(body.type) } : {}), ...(body.itemIds ? { itemIds: [...new Set(body.itemIds)] } : {}) };
}
export function validFeedUrl(value) {
  let u; try { u = new URL(value); } catch { throw new AppError('订阅 URL 无效'); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new AppError('订阅仅支持 HTTP/HTTPS URL');
  return u.href;
}
