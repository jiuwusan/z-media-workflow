import { AppError } from './error.js';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createHttpClient({ baseUrl, headers = {}, timeoutMs = 15000 }) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  return async (path, { method = 'GET', query, json, form, timeout = timeoutMs } = {}) => {
    const url = new URL(path.replace(/^\/+/, ''), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new AppError('非法 API 路径');
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const requestHeaders = { ...headers };
    let body;
    if (json !== undefined) { body = JSON.stringify(json); requestHeaders['Content-Type'] = 'application/json'; }
    if (form) { body = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])); requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded'; }
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { method, headers: requestHeaders, body, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
        if (method === 'GET' && (res.status === 429 || res.status >= 500) && attempt < 2) { await res.body?.cancel(); await sleep(200 * 2 ** attempt); continue; }
        if (!res.ok) { await res.body?.cancel(); throw new AppError(`上游 API ${method} ${url.pathname} 返回 HTTP ${res.status}`, 502, 'UPSTREAM_ERROR'); }
        const raw = await res.text();
        if (!raw) return undefined;
        if (res.headers.get('content-type')?.includes('json')) {
          try { return JSON.parse(raw); } catch { throw new AppError('上游返回了无效 JSON', 502); }
        }
        return raw;
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (method === 'GET' && attempt < 2) { await sleep(200 * 2 ** attempt); continue; }
        throw new AppError('上游连接失败或请求超时', 502, 'UPSTREAM_UNAVAILABLE');
      }
    }
  };
}
