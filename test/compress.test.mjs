import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { gzipFile } from '../src/compress.mjs';
import { put, hash, operation, MAX_FILE_BYTES } from '../src/store.mjs';

async function fixture(t, data = Buffer.from('frozen evidence')) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'library-gzip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await put(root, 'data/source.json', Readable.from([data]), { expected: 'new', key: 'source' });
  return { root, data, request: { path: 'data/source.json', to: 'archive/source.json.gz', expected: hash(data), key: 'compress' } };
}

test('gzip keeps large binary data inside Library and records source/target proof', async t => {
  const { root, data, request } = await fixture(t, randomBytes(2 * 1024 * 1024));
  const result = await gzipFile(root, request);
  const archive = await fs.readFile(path.join(root, 'files', request.to));
  assert(archive.length > 1024 * 1024);
  assert.deepEqual(gunzipSync(archive), data);
  assert.equal(result.sha256, hash(archive));
  assert.equal(result.source.sha256, hash(data));
  assert.equal(result.source.bytes, data.length);
  assert.equal(result.state, 'stored');
  assert.equal((await fs.stat(path.join(root, 'files', request.to))).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readFile(path.join(root, 'files', request.path)), data);
  assert.equal((await operation(root, request.key)).state, 'stored');
  assert.equal((await gzipFile(root, request)).replay, true);
  // Reconcile interruption after receipt installation, before destination rename.
  await fs.unlink(path.join(root, 'files', request.to));
  assert.equal((await operation(root, request.key)).state, 'missing');
  assert.equal((await gzipFile(root, request)).state, 'stored');
  assert.deepEqual(await fs.readFile(path.join(root, 'files', request.to)), archive);
});

test('gzip fails closed on stale source, occupied target, reused key and writer contention', async t => {
  const { root, request } = await fixture(t);
  await assert.rejects(gzipFile(root, { ...request, expected: '0'.repeat(64) }), { code: 'CONFLICT' });
  await assert.rejects(fs.stat(path.join(root, 'files', request.to)), { code: 'ENOENT' });
  await assert.rejects(operation(root, request.key), { code: 'ENOENT' });
  await gzipFile(root, request);
  await assert.rejects(gzipFile(root, { ...request, key: 'new-key' }), { code: 'CONFLICT' });
  await assert.rejects(gzipFile(root, { ...request, to: 'another.gz' }), { code: 'KEY_REUSED' });
  await fs.mkdir(path.join(root, '.writer-lock'));
  await assert.rejects(gzipFile(root, request), { code: 'BUSY' });
  await fs.rmdir(path.join(root, '.writer-lock'));
  await fs.writeFile(path.join(root, 'files', request.path), 'changed');
  await assert.rejects(gzipFile(root, request), { code: 'CONFLICT' });
});

test('gzip rejects traversal, symlinks, oversized sources and ambiguous destinations', async t => {
  const { root, request } = await fixture(t);
  for (const invalid of [{ expected: 'new' }, { to: request.path }, { to: 'no-gzip' }, { path: '' }]) {
    await assert.rejects(gzipFile(root, { ...request, ...invalid }), { code: 'INVALID' });
  }
  await assert.rejects(gzipFile(root, { ...request, path: '../outside' }), { code: 'UNSAFE_PATH' });
  await assert.rejects(gzipFile(root, { ...request, to: '../outside.gz' }), { code: 'UNSAFE_PATH' });
  await fs.symlink(path.join(root, 'files', request.path), path.join(root, 'files', 'link'));
  await assert.rejects(gzipFile(root, { ...request, path: 'link' }), { code: 'UNSAFE_PATH' });
  await fs.symlink(path.join(root, 'files', request.path), path.join(root, 'files', 'link.gz'));
  await assert.rejects(gzipFile(root, { ...request, to: 'link.gz' }), { code: 'UNSAFE_PATH' });
  await fs.truncate(path.join(root, 'files', request.path), MAX_FILE_BYTES + 1);
  await assert.rejects(gzipFile(root, request), { code: 'TOO_LARGE' });
});

test('gzip CLI needs no payload stdin and local help needs no state', async t => {
  const { root, request, data } = await fixture(t);
  const cli = new URL('../bin/ez-library.mjs', import.meta.url).pathname;
  const run = spawnSync(process.execPath, [cli, 'gzip', '--path', request.path, '--to', request.to,
    '--expected', request.expected, '--key', request.key], { env: { ...process.env, EZ_LIBRARY_STATE: root }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).data.source.sha256, hash(data));
  const help = spawnSync(process.execPath, [cli, 'gzip', '--help'], { env: { ...process.env, EZ_LIBRARY_STATE: '/does-not-exist' }, encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /gzip --path/);
});
