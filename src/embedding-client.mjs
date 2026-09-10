import http from 'node:http';

export const model = 'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf';
export const protocol = 'ez-qmd-embeddings-v1';
export const socket = '/inference/worker.sock';

export function request(body, socketPath = process.env.EZ_LIBRARY_EMBED_SOCKET) {
  if (!socketPath) return Promise.reject(Error('Semantic embeddings are off. Enable the shared embeddings service through the Ez plugin manager.'));
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let data = '', bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) res.destroy(Error('Embedding response too large')); else data += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (res.statusCode !== 200 || result.protocol !== protocol || result.model !== model) throw Error(result.error || 'Incompatible embedding service');
          resolve(result.result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(120000, () => req.destroy(Error('Embedding service timed out')));
    req.on('error', reject);
    req.end(JSON.stringify({ protocol, model, ...body }));
  });
}

// Literal QMD model operations. QMD still owns prompts, chunking and vectors.
export async function invoke(method, requestedModel, args) {
  if (requestedModel !== model || (args[1]?.model && args[1].model !== model)) throw Error('Shared embedding model mismatch; use the pinned Library model');
  const result = await request({ method, args });
  const vector = value => {
    if (!value || value.model !== model || !Array.isArray(value.embedding) || value.embedding.length !== 768 || !value.embedding.every(Number.isFinite)) throw Error('Invalid embedding vector');
  };
  if (method === 'embed') vector(result);
  if (method === 'embedBatch') {
    if (!Array.isArray(result) || result.length !== args[0].length) throw Error('Invalid embedding batch');
    result.forEach(vector);
  }
  if (method === 'tokenize' && (!Array.isArray(result) || !result.every(x => Number.isInteger(x) && x >= 0))) throw Error('Invalid tokenizer result');
  if (method === 'detokenize' && typeof result !== 'string') throw Error('Invalid tokenizer result');
  return result;
}

export async function embeddingStatus() {
  if (!process.env.EZ_LIBRARY_EMBED_SOCKET) return { state: 'off' };
  try { return { state: 'ready', ...(await request({ method: 'health', args: [] })) }; }
  catch { return { state: 'unavailable', model }; }
}
