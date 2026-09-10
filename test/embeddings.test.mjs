import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve, validateCall } from '../src/embedding-worker.mjs';
import { request, protocol, model, invoke, embeddingStatus } from '../src/embedding-client.mjs';

test('default off never invokes a model or downloads; unavailable has no local fallback', async () => {
  assert.equal((await embeddingStatus()).state, 'off');
  await assert.rejects(invoke('embed', model, ['text', {}]), /off/);
  await assert.rejects(request({ method: 'health', args: [] }, '/nonexistent/worker.sock'));
  await assert.rejects(invoke('embed', 'foreign', ['text', {}]), /mismatch/);
});
test('worker exposes only bounded embedding and tokenizer operations', () => {
  for (const v of [ { method: 'dispose', args: [] }, { method: 'embed', args: ['text', { model: 'foreign' }] }, { method: 'embedBatch', args: [Array(33).fill('x'), {}] }, { method: 'tokenize', args: ['x'.repeat(300000)] }, { method: 'detokenize', args: [[-1]] } ]) {
    assert.throws(() => validateCall({ protocol, model, ...v }));
  }
  assert.throws(() => validateCall({ protocol: 'wrong', model, method: 'health', args: [] }));
});
test('two clients share serialized inference without shared documents or model mutation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-emb-')), socket = path.join(root, 'worker.sock');
  let active = 0, max = 0, calls = 0;
  const server = await serve({ embed: async text => { active++; calls++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 10)); active--; return { embedding: [text.length], model }; } }, socket);
  t.after(async () => { await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }); });
  await Promise.all(['one', 'two'].map(text => request({ method: 'embed', args: [text, {}] }, socket)));
  assert.equal(calls, 2); assert.equal(max, 1);
  assert.equal((await request({ method: 'health', args: [] }, socket)).dimensions, 768);
  await assert.rejects(request({ method: 'dispose', args: [] }, socket));
});
