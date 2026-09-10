import http from 'node:http';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { model, protocol, socket, request } from './embedding-client.mjs';

export function validateCall(value) {
  if (value?.protocol !== protocol || value.model !== model || !Array.isArray(value.args)) throw Error('Incompatible embedding request');
  const { method, args } = value;
  const text = x => typeof x === 'string' && Buffer.byteLength(x) <= 256 * 1024;
  if (method === 'health' && args.length === 0) return;
  if (method === 'tokenize' && args.length === 1 && text(args[0])) return;
  if (method === 'detokenize' && args.length === 1 && Array.isArray(args[0]) && args[0].length <= 65536 && args[0].every(x => Number.isInteger(x) && x >= 0 && x <= 262144)) return;
  if (['embed', 'embedBatch'].includes(method) && args.length === 2 && args[1] && Object.keys(args[1]).every(k => ['model', 'isQuery'].includes(k)) && (!args[1].model || args[1].model === model) && (args[1].isQuery === undefined || typeof args[1].isQuery === 'boolean')) {
    if (method === 'embed' && text(args[0])) return;
    if (method === 'embedBatch' && Array.isArray(args[0]) && args[0].length <= 32 && args[0].every(text)) return;
  }
  throw Error('Invalid embedding operation');
}

export async function serve(llm, socketPath = socket) {
  let pending = 0, queue = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    const reply = (code, result, error) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ protocol, model, result, error })); };
    if (req.method !== 'POST' || req.url !== '/') return reply(404, null, 'Unknown operation');
    let bytes = 0, parts = [];
    try {
      for await (const part of req) { bytes += part.length; if (bytes > 2 * 1024 * 1024) { reply(413, null, 'Request too large'); return; } parts.push(part); }
      const value = JSON.parse(Buffer.concat(parts)); validateCall(value);
      if (value.method === 'health') return reply(200, { model, dimensions: 768 });
      // Bound native work and memory. Clients can retry explicitly after contention.
      if (pending >= 16) return reply(503, null, 'Embedding worker queue full');
      pending++;
      const operation = queue.then(() => res.destroyed ? null : llm[value.method](...value.args));
      queue = operation.catch(() => {});
      try { reply(200, await operation); }
      finally { pending--; }
    } catch { reply(400, null, 'Embedding operation failed'); }
  });
  server.requestTimeout = 30000;
  await fs.rm(socketPath, { force: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o660);
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv[2] === '--health') await request({ method: 'health', args: [] }, socket);
  else {
    const { LlamaCpp } = await import(new URL('./llm.js', import.meta.resolve('@tobilu/qmd')));
    const llm = new LlamaCpp({ embedModel: model, modelCacheDir: '/models', inactivityTimeoutMs: 0 });
    // Load only the embedding model; readiness means a real vector was produced.
    console.error('Loading shared embedding model');
    const probe = await llm.embed('readiness');
    if (probe?.embedding.length !== 768) throw Error('Embedding model failed readiness');
    const server = await serve(llm);
    const stop = () => server.close(async () => { await llm.dispose(); process.exit(0); });
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  }
}
