import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { put, replaceText, operation, hash, MAX_REPLACE_BYTES } from '../src/store.mjs';

const initial = '# Day\r\n\r\n## A\r\nstarted 🛰\r\n\r\n## B\r\nstarted\r\n';
const a = { before: '## A\r\nstarted 🛰\r\n', after: '## A\r\ncompleted 🛰\r\n' };
const b = { before: '## B\r\nstarted\r\n', after: '## B\r\ncompleted\r\n' };
async function fixture(t, data = initial) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'library-replace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await put(root, 'runs/day.md', Readable.from([Buffer.from(data)]), { expected: 'new', key: 'initial' });
  return root;
}
const read = root => fs.readFile(path.join(root, 'files/runs/day.md'), 'utf8');

test('scoped replacements preserve interleaved writers, exact bytes and replay', async t => {
  const root = await fixture(t);
  const first = await replaceText(root, 'runs/day.md', a, { key: 'a' });
  await replaceText(root, 'runs/day.md', b, { key: 'b' });
  const expected = initial.replace(a.before, a.after).replace(b.before, b.after);
  assert.equal(await read(root), expected);
  assert.equal((await operation(root, 'a')).state, 'stored');
  assert.notEqual((await operation(root, 'a')).sha256, first.sha256);
  assert.equal((await replaceText(root, 'runs/day.md', a, { key: 'a' })).replay, true);
  assert.equal(await read(root), expected);
  assert.equal(await fs.readFile(path.join(root, 'history', hash(initial)), 'utf8'), initial);
  assert.equal((await fs.stat(path.join(root, 'files/runs/day.md'))).mode & 0o777, 0o600);
  assert.equal('before' in await operation(root, 'a'), false);
  // A changed owning block does not become a stale overwrite on replay.
  await replaceText(root, 'runs/day.md', { before: a.after, after: a.after + 'new progress\r\n' }, { key: 'a2' });
  assert.equal((await operation(root, 'a')).state, 'stored'); // old completed text remains present
});

test('same-block conflict, ambiguity and reused keys do not rewrite a file', async t => {
  const root = await fixture(t);
  await replaceText(root, 'runs/day.md', a, { key: 'a' });
  await assert.rejects(replaceText(root, 'runs/day.md', { ...a, after: 'different' }, { key: 'other' }), { code: 'CONFLICT' });
  await assert.rejects(replaceText(root, 'runs/day.md', b, { key: 'a' }), { code: 'KEY_REUSED' });
  const before = await read(root);
  await assert.rejects(replaceText(root, 'runs/day.md', { before: '## ', after: 'new' }, { key: 'ambiguous' }), { code: 'CONFLICT' });
  await assert.rejects(replaceText(root, 'runs/day.md', { before: b.before, after: a.after }, { key: 'duplicate-after' }), { code: 'CONFLICT' });
  assert.equal(await read(root), before);
  await assert.rejects(operation(root, 'ambiguous'), { code: 'ENOENT' });
});

test('interrupted receipt reconciles against current unrelated edits', async t => {
  const root = await fixture(t);
  await replaceText(root, 'runs/day.md', a, { key: 'a' });
  // Model a durable intent with its destination not yet installed.
  await fs.writeFile(path.join(root, 'files/runs/day.md'), initial.replace(b.before, b.after));
  assert.equal((await operation(root, 'a')).state, 'changed');
  const result = await replaceText(root, 'runs/day.md', a, { key: 'a' });
  assert.equal(result.state, 'stored');
  assert.equal(await read(root), initial.replace(a.before, a.after).replace(b.before, b.after));
});

test('replacement rejects unsafe input, source, contention and size', async t => {
  const root = await fixture(t);
  for (const value of [null, { before: '', after: 'a' }, { before: 'a', after: '' }, { before: 'a', after: 'a' },
    { ...a, extra: true }, { before: '\ud800', after: 'x' }, { before: 'x', after: 'y'.repeat(MAX_REPLACE_BYTES) }]) {
    await assert.rejects(replaceText(root, 'runs/day.md', value, { key: 'bad' }), { code: 'INVALID' });
  }
  await assert.rejects(replaceText(root, '../outside', a, { key: 'bad' }), { code: 'UNSAFE_PATH' });
  await fs.symlink(path.join(root, 'files/runs/day.md'), path.join(root, 'files/link'));
  await assert.rejects(replaceText(root, 'link', a, { key: 'bad' }), { code: 'UNSAFE_PATH' });
  await fs.mkdir(path.join(root, '.writer-lock'));
  await assert.rejects(replaceText(root, 'runs/day.md', a, { key: 'bad' }), { code: 'BUSY' });
  await fs.rmdir(path.join(root, '.writer-lock'));
  await fs.writeFile(path.join(root, 'files/runs/day.md'), Buffer.from([255]));
  await assert.rejects(replaceText(root, 'runs/day.md', a, { key: 'bad' }), { code: 'INVALID' });
  await fs.truncate(path.join(root, 'files/runs/day.md'), 8 * 1024 * 1024 + 1);
  await assert.rejects(replaceText(root, 'runs/day.md', a, { key: 'bad' }), { code: 'TOO_LARGE' });
});

test('replace CLI uses bounded JSON, not shell or regex interpretation', async t => {
  const root = await fixture(t);
  const cli = new URL('../bin/ez-library.mjs', import.meta.url).pathname;
  const run = input => spawnSync(process.execPath, [cli, 'replace', '--path', 'runs/day.md', '--key', 'cli'],
    { input, env: { ...process.env, EZ_LIBRARY_STATE: root }, encoding: 'utf8' });
  const result = run(JSON.stringify(a));
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).data.state, 'stored');
  assert.equal(run('{').status, 2);
  assert.equal(run(Buffer.from([255])).status, 2);
  assert.equal(run(' '.repeat(MAX_REPLACE_BYTES + 1)).status, 2);
});
