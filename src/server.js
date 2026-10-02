import 'dotenv/config';
import { loadConfig } from './config/index.js';
import { createServices } from './service/index.js';
import { createApp } from './app.js';
import { log } from './util/logger.js';
const config = loadConfig(), services = createServices(config), app = createApp({ config, services });
const server = app.listen(config.port, config.host, () => log('server.started', { url: config.publicUrl }));
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  services.workflow.stopping = true;
  const timer = setTimeout(() => process.exit(1), config.shutdownMs + 1000); timer.unref();
  server.close(); const drained = await services.workflow.close(config.shutdownMs);
  server.closeAllConnections(); log('server.stopped', { drained }); clearTimeout(timer); process.exit(drained ? 0 : 1);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
