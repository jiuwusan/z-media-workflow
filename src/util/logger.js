export function redact(message, secrets = []) {
  let value = String(message ?? '未知错误');
  for (const secret of secrets.filter(Boolean)) value = value.split(secret).join('[REDACTED]');
  return value.replace(/(?:sk-|qbt_)[A-Za-z0-9_-]+/g, '[REDACTED]');
}
export const log = (event, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
