import { setTimeout } from 'node:timers/promises';
import { syncRun, syncStatus } from './sync.mjs';
import { catalog, libraryRoot } from './libraries.mjs';

// One resident supervisor, no LLM polling or provider transport implementation.
// Native bisync owns deltas, conflicts, receipts, and recovery. The same Library
// writer lock serializes CLI writes, transfers, and QMD refresh.
const root = process.env.EZ_LIBRARY_STATE || '/state';
let stopping = false;
const controller = new AbortController();
process.on('SIGTERM', () => { stopping = true; controller.abort(); });
process.on('SIGINT', () => { stopping = true; controller.abort(); });
const due = new Map();
while (!stopping) {
  let interval = 60;
  try {
    for (const { name } of (await catalog(root)).libraries) {
      if (stopping) break;
      try {
        const selected = await libraryRoot(root, name);
        const { config } = await syncStatus(selected);
        if (config?.mode !== 'two-way') { due.delete(name); continue; }
        if ((due.get(name) || 0) <= Date.now()) {
          try { await syncRun(selected, root); }
          finally { due.set(name, Date.now() + config.intervalSeconds * 1000); }
        }
        interval = Math.min(interval, Math.max(1, ((due.get(name) || 0) - Date.now()) / 1000));
      } catch (error) {
        process.stderr.write(JSON.stringify({ event: 'library-sync', library: name, code: error.code || 'UNAVAILABLE', message: error.message }) + '\n');
      }
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({ event: 'library-sync', code: error.code || 'UNAVAILABLE', message: error.message }) + '\n');
  }
  if (!stopping) await setTimeout(interval * 1000, undefined, { signal: controller.signal }).catch(() => {});
}
