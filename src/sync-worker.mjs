import { setTimeout } from 'node:timers/promises';
import { syncRun, syncStatus } from './sync.mjs';

// One resident supervisor, no LLM polling or provider transport implementation.
// Native bisync owns deltas, conflicts, receipts, and recovery. The same Library
// writer lock serializes CLI writes, transfers, and QMD refresh.
const root = process.env.EZ_LIBRARY_STATE || '/state';
let stopping = false;
const controller = new AbortController();
process.on('SIGTERM', () => { stopping = true; controller.abort(); });
process.on('SIGINT', () => { stopping = true; controller.abort(); });
while (!stopping) {
  let interval = 60;
  try {
    const { config } = await syncStatus(root);
    interval = config?.intervalSeconds || 60;
    if (config?.mode === 'two-way') await syncRun(root);
  } catch (error) {
    process.stderr.write(JSON.stringify({ event: 'library-sync', code: error.code || 'UNAVAILABLE', message: error.message }) + '\n');
  }
  if (!stopping) await setTimeout(interval * 1000, undefined, { signal: controller.signal }).catch(() => {});
}
