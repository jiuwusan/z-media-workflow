import { SetupService } from './service/setup.js';
import { createApp } from './app.js';
import { log } from './util/logger.js';
import { saveRuntimeAddress } from './util/runtime-address.js';
import { LifecycleService } from './service/lifecycle.js';
const lifecycle = new LifecycleService({ managed: /^\d+$/.test(process.env.pm_id ?? '') && typeof process.send === 'function', shutdown: () => shutdown() });
const setup = new SetupService(), config = setup.config ?? { ...setup.bootstrap }, app = createApp({ config, setup, lifecycle });
const server = app.listen(config.port, config.host, () => { saveRuntimeAddress(server.address()); log('server.started', { url: config.publicUrl }); });
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  const workflow = app.services?.workflow;
  if (workflow) workflow.stopping = true;
  const timer = setTimeout(() => process.exit(1), config.shutdownMs + 1000); timer.unref();
  server.close(); const drained = workflow ? await workflow.close(config.shutdownMs) : true;
  server.closeAllConnections(); log('server.stopped', { drained }); clearTimeout(timer); process.exit(drained ? 0 : 1);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
process.on('message', message => { if (message === 'shutdown') shutdown(); });
