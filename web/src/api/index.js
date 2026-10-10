import { ElMessage } from 'element-plus';
let csrfToken = '', authenticated = false;
export function setSession(session) { csrfToken = session?.csrfToken ?? ''; authenticated = Boolean(session); }
export function hasSession() { return authenticated; }
export async function api(path, { method = 'GET', body, quiet = false } = {}) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
    const res = await fetch(`/api${path}`, { method, headers, credentials: 'same-origin', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await res.json();
    if (!res.ok) {
      if (res.status === 401 && path !== '/auth/login') { setSession(null); window.dispatchEvent(new Event('auth-expired')); }
      const error = new Error(result.error?.message ?? `请求失败 (${res.status})`);
      if (result.data) error.data = result.data;
      throw error;
    }
    return result.data;
  } catch (e) { if (!quiet) ElMessage.error(e.message); throw e; }
}
