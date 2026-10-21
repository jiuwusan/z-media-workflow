import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AppError } from './error.js';
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export function passwordRecord(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw new AppError('管理员密码长度应为 8 至 1024 位');
  const salt = randomBytes(16).toString('hex'), options = { N: 16384, r: 8, p: 1 };
  return { salt, hash: scryptSync(password, salt, 32, options).toString('hex'), ...options };
}
export function verifyPassword(password, record) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const actual = scryptSync(password, record.salt, 32, { N: record.N, r: record.r, p: record.p });
  return timingSafeEqual(actual, Buffer.from(record.hash, 'hex'));
}
