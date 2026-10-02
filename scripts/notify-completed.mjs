import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
const [hash, type] = process.argv.slice(2);
async function main() {
  let fileEnv = {};
  try { fileEnv = parseEnv(await readFile(new URL('.env.notify', import.meta.url), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const env = { ...fileEnv, ...process.env };
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hash ?? '')) throw new Error('请传入有效的 torrent hash（qBittorrent %I）');
  if (type && !['Movie', 'Series'].includes(type)) throw new Error('可选类型为 Movie 或 Series');
  if (!env.WORKFLOW_CALLBACK_URL || !env.WORKFLOW_API_TOKEN) throw new Error('请配置 .env.notify 或通知环境变量');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(env.WORKFLOW_CALLBACK_URL, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.WORKFLOW_API_TOKEN}` }, body: JSON.stringify({ hash, ...(type ? { type } : {}) }) });
      if (!response.ok) { if (response.status >= 500 || response.status === 429) throw new Error('通知服务暂不可用'); throw new Error(`通知被拒绝（HTTP ${response.status}）`); }
      const result = await response.json(); console.log(`已通知工作流服务，任务 ID：${result.data.id}`); return;
    } catch (e) {
      if (attempt === 2 || e.message.startsWith('通知被拒绝')) throw e;
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}
main().catch(() => { console.error('下载完成通知失败：请检查 hash、回调地址、独立通知令牌及网络连接。'); process.exitCode = 1; });
