import { SetupService } from './service/setup.js';
import { createApp } from './app.js';
import { log } from './util/logger.js';
import { saveRuntimeAddress } from './util/runtime-address.js';
import { LifecycleService } from './service/lifecycle.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export function startServer(setup = new SetupService()) {
const lifecycle = new LifecycleService({ managed: /^\d+$/.test(process.env.pm_id ?? '') && typeof process.send === 'function', shutdown: () => shutdown() });
const config = setup.config ?? { ...setup.bootstrap }, app = createApp({ config, setup, lifecycle });
const server = app.listen(config.port, config.host, () => { saveRuntimeAddress(server.address()); log('server.started', { url: config.publicUrl }); });
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  const workflow = app.services?.workflow;
  if (workflow) workflow.stopping = true;
  const timer = setTimeout(() => process.exit(1), config.shutdownMs + 1000); timer.unref();
  server.close(); const drained = app.services?.close ? await app.services.close(config.shutdownMs) : workflow ? await workflow.close(config.shutdownMs) : true;
  if(drained)setup.close();
  server.closeAllConnections(); log('server.stopped', { drained }); clearTimeout(timer); process.exit(drained ? 0 : 1);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
process.on('message', message => { if (message === 'shutdown') shutdown(); });
return {app,server,shutdown};
}
const entry=process.env.pm_exec_path??process.argv[1];
if(entry && path.resolve(entry)===fileURLToPath(import.meta.url))startServer();
