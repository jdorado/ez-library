import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { mirrorAdopt, mirrorTransfer, mirrorStatus, mirrorPolicy } from '../src/git-mirror.mjs';
import { initialize, locked, put, organize } from '../src/store.mjs';

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'library-mirror-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = await initialize(path.join(base, 'state')), remote = path.join(base, 'remote.git');
  const git = args => execFileSync('/usr/bin/git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' } });
  git(['init', '--bare', '--initial-branch=main', remote]);
  await fs.mkdir(path.join(root, 'sync'));
  await fs.writeFile(path.join(root, 'sync/config.json'), JSON.stringify({ schemaVersion: 1, mode: 'two-way', remote: '/external' }));
  return { root, remote, base, git, cycle: () => locked(root, () => mirrorTransfer(root)) };
}
test('text mirror versions notes and renames while excluding attachment bytes and hidden settings', async t => {
  const { root, remote, git, cycle } = await fixture(t);
  const note = await put(root, 'notes/a.md', Readable.from(['# Original\n![](../_attachments/image.png)']), { expected: 'new', key: 'note' });
  await put(root, '_attachments/image.png', Readable.from(['synthetic image']), { expected: 'new', key: 'image' });
  await fs.mkdir(path.join(root, 'files/.obsidian'));
  await fs.writeFile(path.join(root, 'files/.obsidian/settings.md'), 'private settings');
  await mirrorAdopt(root, remote);
  const first = await cycle();
  assert.equal(first.remoteVerified, true);
  assert.equal(git(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']).trim(), 'notes/a.md');
  assert.equal((await cycle()).commit, first.commit);
  await organize(root, { path: 'notes/a.md', to: 'organized/a.md', expected: note.sha256, key: 'move' });
  const second = await cycle(); assert.notEqual(second.commit, first.commit);
  assert.match(git(['--git-dir', remote, 'show', 'main:organized/a.md']), /Original/);
  assert.match(git(['--git-dir', remote, 'show', first.commit + ':notes/a.md']), /Original/);
  assert.equal(await fs.readFile(path.join(root, 'files/_attachments/image.png'), 'utf8'), 'synthetic image');
  const current = await mirrorStatus(root);
  await mirrorPolicy(root, current.revision, 'paused');
  assert.equal((await cycle()).state, 'paused');
});
test('outside GitHub edits stop mirroring without changing Drive originals or dropping remote history', async t => {
  const { root, remote, base, git, cycle } = await fixture(t);
  await put(root, 'note.md', Readable.from(['original']), { expected: 'new', key: 'note' });
  await mirrorAdopt(root, remote); await cycle();
  const checkout = path.join(base, 'external'); git(['clone', remote, checkout]);
  await fs.writeFile(path.join(checkout, 'note.md'), 'external edit');
  git(['-C', checkout, 'add', '.']); git(['-C', checkout, 'commit', '-m', 'external']); git(['-C', checkout, 'push']);
  await assert.rejects(cycle(), { code: 'CONFLICT' });
  assert.equal(await fs.readFile(path.join(root, 'files/note.md'), 'utf8'), 'original');
  assert.equal(git(['--git-dir', remote, 'show', 'main:note.md']), 'external edit');
});
test('deleted mirror branches are not recreated and populated destinations are not adopted', async t => {
  const { root, remote, git, cycle } = await fixture(t);
  await mirrorAdopt(root, remote); await cycle();
  git(['--git-dir', remote, 'update-ref', '-d', 'refs/heads/main']);
  await assert.rejects(cycle(), { code: 'CONFLICT' });
  await assert.rejects(mirrorAdopt(root, remote), { code: 'CONFLICT' });
});

test('failed adoption resumes exact partial setup after remote branch is corrected', async t => {
  const { root, remote, base, git, cycle } = await fixture(t);
  const checkout = path.join(base, 'seed'); git(['clone', remote, checkout]);
  await fs.writeFile(path.join(checkout, 'existing.md'), 'existing');
  git(['-C', checkout, 'add', '.']); git(['-C', checkout, 'commit', '-m', 'seed']); git(['-C', checkout, 'push']);
  await assert.rejects(mirrorAdopt(root, remote, 'main', undefined, root, 'private'), { code: 'CONFLICT' });
  assert.equal((await mirrorStatus(root)).config, null);
  await assert.rejects(mirrorAdopt(root, remote, 'library-history', undefined, root, 'other'), error => {
    assert.equal(error.code, 'CONFLICT');
    assert.match(error.message, /different excluded directories/);
    return true;
  });
  // Select an empty branch on the same repository; preserve its existing main.
  await mirrorAdopt(root, remote, 'library-history', undefined, root, 'private');
  assert.equal((await cycle()).remoteVerified, true);
  assert.equal(git(['--git-dir', remote, 'show', 'main:existing.md']), 'existing');
});

test('text mirror excludes configured directory subtrees without matching similar prefixes', async t => {
  const { root, remote, git, cycle } = await fixture(t);
  await put(root, 'private/note.md', Readable.from(['excluded']), { expected: 'new', key: 'excluded' });
  await put(root, 'private/deeper/note.txt', Readable.from(['also excluded']), { expected: 'new', key: 'deeper' });
  await put(root, 'private-notes/note.md', Readable.from(['retained']), { expected: 'new', key: 'retained' });
  await mirrorAdopt(root, remote, 'main', '.md,.txt', root, 'private');
  assert.deepEqual((await mirrorStatus(root)).config.excludeDirectories, ['private']);
  await cycle();
  assert.equal(git(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']).trim(), 'private-notes/note.md');
  assert.equal(await fs.readFile(path.join(root, 'files/private/note.md'), 'utf8'), 'excluded');
});

test('text mirror rejects unsafe excluded directory prefixes and accepts legacy config without exclusions', async t => {
  const { root, remote, cycle } = await fixture(t);
  await assert.rejects(mirrorAdopt(root, remote, 'main', undefined, root, '../private'), { code: 'INVALID' });
  await mirrorAdopt(root, remote);
  const configPath = path.join(root, 'sync/text-mirror.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  delete config.excludeDirectories;
  await fs.writeFile(configPath, JSON.stringify(config));
  assert.equal((await mirrorStatus(root)).config.excludeDirectories, undefined);
  assert.equal((await cycle()).remoteVerified, true);
});
