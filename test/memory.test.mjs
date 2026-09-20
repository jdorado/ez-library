import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { memoryGet, memoryOperation, memoryRecall, memoryRemember, memoryStatus } from '../src/memory.mjs';
import { put } from '../src/store.mjs';

const cli = new URL('../bin/ez-library.mjs', import.meta.url).pathname;
const fixture = async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ez-library-memory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};
const memory = (content, extra = {}) => ({
  id: 'owner.preference.coffee', kind: 'preference', content,
  source: { type: 'conversation', ref: 'turn:memory-test' },
  tags: ['coffee'], confidence: 'high', reviewAt: '2099-01-01T00:00:00Z', ...extra,
});
const code = expected => error => error.code === expected;

test('curated memory is separate from archived Library files and recall is source-linked', async t => {
  const root = await fixture(t);
  await put(root, 'notes/archive.md', Readable.from(['archive-only note']), { key: 'archive:1', expected: 'new' });
  const saved = await memoryRemember(root, memory('Prefer a concise filter coffee recommendation.'), { key: 'memory:1', expected: 'new' });
  const result = await memoryRecall(root, 'filter coffee');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].id, 'owner.preference.coffee');
  assert.equal(result.results[0].source.ref, 'turn:memory-test');
  assert.equal((await memoryRecall(root, 'archive-only')).results.length, 0);
  assert.equal(await fs.readFile(path.join(root, 'files/notes/archive.md'), 'utf8'), 'archive-only note');
  assert.equal((await memoryStatus(root)).active, 1);
  assert.equal((await memoryGet(root, saved.id)).sha256, saved.sha256);
});

test('memory writes are idempotent, revision guarded and retain prior records', async t => {
  const root = await fixture(t);
  const firstInput = memory('Prefer concise coffee recommendations.');
  const first = await memoryRemember(root, firstInput, { key: 'memory:1', expected: 'new' });
  const replay = await memoryRemember(root, firstInput, { key: 'memory:1', expected: 'new' });
  assert.equal(replay.replay, true);
  await fs.unlink(path.join(root, 'memory/records', first.id + '.json'));
  const recovered = await memoryRemember(root, firstInput, { key: 'memory:1', expected: 'new' });
  assert.equal(recovered.replay, true);
  assert.equal(recovered.sha256, first.sha256);
  const nextInput = memory('Prefer concise coffee recommendations with one reason.', { source: { type: 'conversation', ref: 'turn:memory-update' } });
  const next = await memoryRemember(root, nextInput, { key: 'memory:2', expected: first.sha256 });
  assert.notEqual(next.sha256, first.sha256);
  assert.equal(await fs.readFile(path.join(root, 'memory/history', first.sha256 + '.json'), 'utf8').then(JSON.parse).then(x => x.content), firstInput.content);
  await assert.rejects(memoryRemember(root, memory('stale replacement'), { key: 'memory:3', expected: first.sha256 }), code('CONFLICT'));
  assert.equal((await memoryGet(root, first.id)).record.content, nextInput.content);
  assert.equal((await memoryOperation(root, 'memory:2')).state, 'stored');
});

test('review state can remove a memory from default recall without deleting its provenance', async t => {
  const root = await fixture(t);
  const first = await memoryRemember(root, memory('Use the owner preference only after checking its source.'), { key: 'memory:1', expected: 'new' });
  await memoryRemember(root, memory('Use the owner preference only after checking its source.', { status: 'superseded' }), { key: 'memory:2', expected: first.sha256 });
  assert.equal((await memoryRecall(root, 'owner preference')).results.length, 0);
  assert.equal((await memoryRecall(root, 'owner preference', { includeInactive: true })).results[0].status, 'superseded');
  assert.equal((await memoryStatus(root)).inactive, 1);
});

test('CLI memory path supports filtered recall and rejects archive-style library selection', async t => {
  const root = await fixture(t);
  const save = spawnSync(process.execPath, [cli, 'memory', 'remember', '--expected', 'new', '--key', 'cli:1'], {
    env: { ...process.env, EZ_LIBRARY_STATE: root }, input: JSON.stringify(memory('CLI memory content', { tags: ['cli'] })), encoding: 'utf8',
  });
  assert.equal(save.status, 0, save.stderr);
  const recall = spawnSync(process.execPath, [cli, 'memory', 'recall', '', '--tag', 'cli'], {
    env: { ...process.env, EZ_LIBRARY_STATE: root }, encoding: 'utf8',
  });
  assert.equal(recall.status, 0, recall.stderr);
  assert.equal(JSON.parse(recall.stdout).data.results[0].id, 'owner.preference.coffee');
  const invalid = spawnSync(process.execPath, [cli, 'memory', 'status', '--library', 'default'], {
    env: { ...process.env, EZ_LIBRARY_STATE: root }, encoding: 'utf8',
  });
  assert.equal(invalid.status, 2);
});
