import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { addLibrary, selectLibrary } from '../src/libraries.mjs';

test('channel file returns bounded original bytes from only the selected Library', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'library-channel-file-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await addLibrary(base, 'work', 'Work');
  const { root } = await selectLibrary(base, 'work');
  const bytes = Buffer.from('%PDF-1.7\n\x00\xff\x01 original bytes');
  await fs.writeFile(path.join(root, 'files', 'manual.pdf'), bytes);
  const invoke = args => spawnSync(process.execPath, [new URL('../bin/ez-library.mjs', import.meta.url).pathname, 'file', ...args], {
    env: { ...process.env, EZ_LIBRARY_STATE: base }, maxBuffer: 21 * 1024 * 1024,
  });
  const valid = invoke(['--library', 'work', '--', 'manual.pdf']);
  assert.equal(valid.status, 0, valid.stderr.toString());
  assert.deepEqual(valid.stdout, bytes);
  await fs.writeFile(path.join(root, 'files', 'empty.pdf'), '');
  assert.equal(invoke(['--library', 'work', '--', 'empty.pdf']).status, 0);
  await fs.symlink(path.join(root, 'files', 'manual.pdf'), path.join(root, 'files', 'link.pdf'));
  await fs.symlink(path.join(root, 'files'), path.join(root, 'files', 'linked'));
  const oversized = await fs.open(path.join(root, 'files', 'large.pdf'), 'w');
  await oversized.truncate(20 * 1024 * 1024 + 1); await oversized.close();
  for (const args of [
    ['--library', 'work', '--', '../settings.json'],
    ['--library', 'work', '--', '/etc/passwd'],
    ['--library', 'work', '--', 'link.pdf'],
    ['--library', 'work', '--', 'linked/manual.pdf'],
    ['--library', 'work', '--', 'large.pdf'],
    ['--library', 'work', '--all', '--', 'manual.pdf'],
    ['--library', 'work', '--raw', '--', 'manual.pdf'],
    ['--library', 'work', '--', 'manual.pdf', 'extra'],
    ['--library', 'work', 'manual.pdf'],
    ['--', 'manual.pdf'],
    ['--library', 'missing', '--', 'manual.pdf'],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 2, `${args}: ${result.stderr}`);
    assert.equal(result.stdout.length, 0);
  }
  const other = invoke(['--library', 'default', '--', 'manual.pdf']);
  assert.notEqual(other.status, 0);
  assert.equal(other.stdout.length, 0);
});
