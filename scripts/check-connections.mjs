import 'dotenv/config';
import { loadConfig } from '../src/config/index.js';
import { createServices } from '../src/service/index.js';
const config = loadConfig(), services = createServices(config);
const checks = {
  qbittorrent: async () => ({ version: await services.qbittorrent.version() }),
  jellyfin: async () => ({ version: (await services.jellyfin.info()).Version, libraries: (await services.mediaLibrary.libraries()).map(l => ({ name: l.Name, type: l.CollectionType, directories: l.Locations })) }),
  deepseek: async () => ({ models: (await services.deepseek.models()).data.map(m => m.id) }),
  media: async () => { const items = await services.mediaLibrary.scopedItems(); if (items.length) await services.jellyfin.item(items[0].Id); return { itemCount: items.length, unidentified: items.filter(i => !Object.keys(i.ProviderIds ?? {}).some(k => /^(tmdb|tvdb|imdb)$/i.test(k))).length, itemReadback: items.length ? 'ok' : 'no_items' }; }
};
await Promise.all(Object.entries(checks).map(async ([name, check]) => {
  try { console.log(JSON.stringify({ service: name, ok: true, result: await check() })); }
  catch { console.log(JSON.stringify({ service: name, ok: false, error: '只读连接检查失败，请检查服务地址、凭据及网络' })); process.exitCode = 1; }
}));
