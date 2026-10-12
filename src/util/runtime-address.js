import path from 'node:path';
import { isIP } from 'node:net';
import { readConfigFile, writeConfigFile } from './config-file.js';
export const RUNTIME_FILE = path.resolve('data/runtime.json');
export function saveRuntimeAddress(address, filename = RUNTIME_FILE) { writeConfigFile(filename, { host: address.address, port: address.port }); }
export function runtimeHealthUrl(filename = RUNTIME_FILE) {
  const { host, port } = readConfigFile(filename);
  if (typeof host !== 'string' || !isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('运行监听地址无效');
  const hostname = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : isIP(host) === 6 ? `[${host}]` : host;
  return `http://${hostname}:${port}/health`;
}
