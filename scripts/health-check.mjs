import { runtimeHealthUrl } from '../src/util/runtime-address.js';
try {
  const response = await fetch(runtimeHealthUrl(), { signal: AbortSignal.timeout(4000), redirect: 'manual' });
  await response.body?.cancel();
  if (!response.ok) process.exitCode = 1;
} catch { process.exitCode = 1; }
