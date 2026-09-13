import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { gitAdopt, gitTransfer, git, repositoryURL } from '../src/git-sync.mjs';
import { locked, put, digest, organize, jsonBytes } from '../src/store.mjs';

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'library-git-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git'), external = path.join(base, 'external'), root = path.join(base, 'state');
  function outside(args) {
    return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', ...args], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' }, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  outside(['init', '--bare', '--initial-branch=main', remote]); outside(['clone', remote, external]);
  for (let i=0;i<3;i++) await fs.writeFile(path.join(external, `note${i}.md`), `# Note ${i}\nOriginal telescope instructions.\n`);
  await fs.writeFile(path.join(external, 'empty.txt'), '');
  const publish = () => { outside(['-C', external, 'add', '-A']); outside(['-C', external, 'commit', '-m', 'External revision']); outside(['-C', external, 'push', 'origin', 'main']); };
  publish();
  return { base, root, remote, external, outside, publish };
}
const cycle = (root, config) => locked(root, () => gitTransfer(root, config));

test('native Git adopts originals, imports external changes, exports agent changes and verifies commit', async t => {
  const { root, remote, external, outside, publish } = await setup(t);
  const { config } = await gitAdopt(root, remote);
  assert.equal((await fs.stat(path.join(root, 'files/empty.txt'))).size, 0);
  await fs.writeFile(path.join(external, 'incoming.md'), '# Incoming\nCobalt otters.'); publish();
  await cycle(root, config);
  assert.match(await fs.readFile(path.join(root, 'files/incoming.md'), 'utf8'), /Cobalt/);
  const saved = await put(root, 'agent.md', Readable.from(['# Agent\nSaffron notebook.']), { expected: 'new', key: 'agent' });
  const result = await cycle(root, config);
  assert.equal(result.remoteVerified, true);
  assert.equal(outside(['--git-dir', remote, 'rev-parse', 'main']).trim(), result.commit);
  assert.match(outside(['--git-dir', remote, 'show', 'main:agent.md']), /Saffron/);
  await organize(root, { path: 'agent.md', to: 'organized/agent.md', expected: saved.sha256, key: 'move' });
  await cycle(root, config);
  assert.match(outside(['--git-dir', remote, 'show', 'main:organized/agent.md']), /Saffron/);
  outside(['-C', external, 'pull', '--ff-only']);
  await fs.unlink(path.join(external, 'note1.md')); await fs.rename(path.join(external, 'note2.md'), path.join(external, 'renamed.md')); publish();
  await cycle(root, config);
  await assert.rejects(fs.stat(path.join(root, 'files/note1.md')), { code: 'ENOENT' });
  assert.match(await fs.readFile(path.join(root, 'files/renamed.md'), 'utf8'), /Note 2/);
});

test('simultaneous changes retain native merge stages and pause until explicit resolution', async t => {
  const { root, remote, external, publish, outside } = await setup(t);
  const { config } = await gitAdopt(root, remote);
  await fs.writeFile(path.join(external, 'note0.md'), 'REMOTE revision\n'); publish();
  const original = await digest(path.join(root, 'files/note0.md'));
  await put(root, 'note0.md', Readable.from(['LOCAL revision\n']), { expected: original.sha256, key: 'local' });
  await assert.rejects(cycle(root, config), { code: 'CONFLICT' });
  assert.match((await git(root, config, ['show', ':2:note0.md'])).stdout, /LOCAL/);
  assert.match((await git(root, config, ['show', ':3:note0.md'])).stdout, /REMOTE/);
  await assert.rejects(cycle(root, config), { code: 'CONFLICT' });
  await fs.writeFile(path.join(root, 'files/note0.md'), 'Reviewed resolution\n');
  assert.equal((await git(root, config, ['add', '--', 'note0.md'])).code, 0);
  await cycle(root, config);
  assert.match(outside(['--git-dir', remote, 'show', 'main:note0.md']), /Reviewed resolution/);
});

test('missing remote retains local commits for retry, and symlink changes cannot enter the Library', async t => {
  const { root, remote, external, publish } = await setup(t);
  const { config } = await gitAdopt(root, remote);
  await fs.rename(remote, remote + '-offline');
  await put(root, 'pending.md', Readable.from(['Pending survives']), { expected: 'new', key: 'pending' });
  await assert.rejects(cycle(root, config));
  assert.match((await git(root, config, ['show', 'HEAD:pending.md'])).stdout, /Pending/);
  await fs.rename(remote + '-offline', remote);
  await fs.symlink('/etc/passwd', path.join(external, 'unsafe')); publish();
  await assert.rejects(cycle(root, config), { code: 'UNSAFE_PATH' });
  await assert.rejects(fs.lstat(path.join(root, 'files/unsafe')), { code: 'ENOENT' });
});

test('adoption preserves mismatching local files and validates repository names', async t => {
  const first = await setup(t);
  await put(first.root, 'note0.md', Readable.from(['Keep local']), { expected: 'new', key: 'local' });
  await assert.rejects(gitAdopt(first.root, first.remote), { code: 'CONFLICT' });
  assert.equal(await fs.readFile(path.join(first.root, 'files/note0.md'), 'utf8'), 'Keep local');
  for (const invalid of ['https://token@github.com/owner/repo', 'owner/../repo', '-option', 'owner/.git']) assert.throws(() => repositoryURL(invalid), { code: 'INVALID' });
});

test('Git ignore rules leave caches local while tracked and eligible files sync', async t => {
  const { root, remote, outside } = await setup(t);
  const { config } = await gitAdopt(root, remote);
  await fs.writeFile(path.join(root, 'files/.gitignore'), '__pycache__/\n*.bin\nnote0.md\n!keep.bin\n');
  await fs.mkdir(path.join(root, 'files/__pycache__'));
  await fs.writeFile(path.join(root, 'files/__pycache__/module.pyc'), 'cache');
  const large = await fs.open(path.join(root, 'files/cache.bin'), 'w');
  await large.truncate(100 * 1024 * 1024); await large.close();
  await fs.writeFile(path.join(root, 'files/note0.md'), 'Tracked change\n');
  await fs.writeFile(path.join(root, 'files/research.md'), 'Research\n');
  await fs.writeFile(path.join(root, 'files/keep.bin'), 'Explicitly included\n');
  const result = await cycle(root, config);
  assert.equal(result.remoteVerified, true);
  assert.equal(outside(['--git-dir', remote, 'show', 'main:note0.md']), 'Tracked change\n');
  assert.equal(outside(['--git-dir', remote, 'show', 'main:research.md']), 'Research\n');
  assert.equal(outside(['--git-dir', remote, 'show', 'main:keep.bin']), 'Explicitly included\n');
  const names = outside(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']);
  assert.doesNotMatch(names, /cache.bin|module.pyc/);
  assert.equal(await fs.readFile(path.join(root, 'files/__pycache__/module.pyc'), 'utf8'), 'cache');
  assert.equal((await fs.stat(path.join(root, 'files/cache.bin'))).size, 100 * 1024 * 1024);
  assert.equal((await cycle(root, config)).commit, result.commit);
});

test('changed Hybrid policy or bound remote stops Git before any upload', async t => {
  const { root, remote, outside } = await setup(t);
  const { config } = await gitAdopt(root, remote);
  const old = outside(['--git-dir', remote, 'rev-parse', 'main']).trim();
  await put(root, 'pending.md', Readable.from(['Do not publish under a changed policy']), { expected: 'new', key: 'pending' });
  await put(root, 'settings.json', Readable.from([jsonBytes({ schemaVersion: 1, storage: { mode: 'drive', drive: { connection: 'example', folderId: 'example' } }, backup: { mode: 'off' } })]), { kind: 'settings', expected: 'new', key: 'settings' });
  await assert.rejects(cycle(root, config), { code: 'CONFLICT' });
  assert.equal(outside(['--git-dir', remote, 'rev-parse', 'main']).trim(), old);
  await fs.unlink(path.join(root, 'settings.json'));
  await git(root, config, ['remote', 'set-url', 'origin', remote + '-different']);
  await assert.rejects(cycle(root, config), { code: 'CONFLICT' });
});

test('an incoming tracked file cannot overwrite an ignored local original', async t => {
  const { root, remote, external, outside, publish } = await setup(t);
  await fs.writeFile(path.join(external, '.gitignore'), '*.cache\n'); publish();
  const { config } = await gitAdopt(root, remote);
  await fs.writeFile(path.join(root, 'files/local.cache'), 'Retain local bytes\n');
  await fs.writeFile(path.join(external, 'local.cache'), 'Incoming bytes\n');
  outside(['-C', external, 'add', '-f', '--', 'local.cache']); publish();
  await assert.rejects(cycle(root, config));
  assert.equal(await fs.readFile(path.join(root, 'files/local.cache'), 'utf8'), 'Retain local bytes\n');
  assert.equal(outside(['--git-dir', remote, 'show', 'main:local.cache']), 'Incoming bytes\n');
});

test('hidden originals obey Git safety and size checks before any push', async t => {
  const { root, remote, outside } = await setup(t);
  const { config } = await gitAdopt(root, remote);
  const original = outside(['--git-dir', remote, 'rev-parse', 'main']).trim();
  const hidden = path.join(root, 'files/.hidden');
  await fs.mkdir(hidden);
  await fs.symlink('/etc/passwd', path.join(hidden, 'link'));
  await assert.rejects(cycle(root, config), /Unsupported symlink/);
  assert.equal(outside(['--git-dir', remote, 'rev-parse', 'main']).trim(), original);
  await fs.unlink(path.join(hidden, 'link'));
  const large = await fs.open(path.join(hidden, 'large.bin'), 'w');
  await large.truncate(100 * 1024 * 1024); await large.close();
  await assert.rejects(cycle(root, config), { code: 'TOO_LARGE' });
  assert.equal(outside(['--git-dir', remote, 'rev-parse', 'main']).trim(), original);
});


test('named Git adoption rejects default and sibling private state including symlink aliases', async t => {
  const { base, root, remote } = await setup(t);
  const selected = path.join(root, 'libraries/work');
  for (const relative of ['sync/git', 'libraries/personal/sync/git']) {
    const privateRepo = path.join(root, relative);
    await fs.mkdir(privateRepo, { recursive: true });
    await assert.rejects(gitAdopt(selected, privateRepo, 'main', root), { code: 'UNSAFE_PATH' });
  }
  const alias = path.join(base, 'alias');
  await fs.symlink(path.join(root, 'sync/git'), alias);
  await assert.rejects(gitAdopt(selected, alias, 'main', root), { code: 'UNSAFE_PATH' });
  await assert.rejects(fs.stat(path.join(selected, 'sync/config.json')), { code: 'ENOENT' });
  assert.equal((await gitAdopt(selected, remote, 'main', root)).config.repository, remote);
});

test('explicit existing checkout adoption retains native HEAD/index and synchronizes both ways', async t => {
  const { root, remote, external, outside, publish } = await setup(t);
  await fs.mkdir(root);
  outside(['clone', remote, path.join(root, 'files')]);
  const before = outside(['-C', path.join(root, 'files'), 'rev-parse', 'HEAD']).trim();
  const indexBefore = await fs.readFile(path.join(root, 'files/.git/index'));
  await assert.rejects(gitAdopt(root, remote), { code: 'CONFLICT' });
  const { config } = await gitAdopt(root, remote, 'main', root, true);
  assert.equal(config.existingCheckout, true);
  assert.deepEqual(await fs.readFile(path.join(root, 'files/.git/index')), indexBefore);
  assert.equal(outside(['-C', path.join(root, 'files'), 'rev-parse', 'HEAD']).trim(), before);
  await assert.rejects(fs.stat(path.join(root, 'sync/git')), { code: 'ENOENT' });
  await fs.writeFile(path.join(root, 'files/.git/info/exclude'), 'local-only.bin\n.local/\nnode_modules/\n');
  await fs.mkdir(path.join(root, 'files/.local'));
  await fs.symlink('/no-such-ignored-vault', path.join(root, 'files/.local/notes'));
  await fs.mkdir(path.join(root, 'files/node_modules'));
  await fs.symlink('/no-such-ignored-dependency', path.join(root, 'files/node_modules/dependency'));
  await fs.writeFile(path.join(root, 'files/local-only.bin'), 'Retained local asset');
  await fs.writeFile(path.join(root, 'files/outgoing.md'), 'Outgoing change');
  const first = await cycle(root, config);
  assert.equal(outside(['-C', path.join(root, 'files'), 'rev-parse', 'HEAD']).trim(), first.commit);
  assert.equal(outside(['-C', path.join(root, 'files'), 'rev-parse', 'origin/main']).trim(), first.commit);
  assert.equal(outside(['--git-dir', remote, 'show', 'main:outgoing.md']), 'Outgoing change');
  outside(['-C', external, 'pull', '--ff-only']);
  await fs.writeFile(path.join(external, 'incoming.md'), 'Incoming change'); publish();
  const second = await cycle(root, config);
  assert.equal(await fs.readFile(path.join(root, 'files/incoming.md'), 'utf8'), 'Incoming change');
  assert.equal((await cycle(root, config)).commit, second.commit);
  assert.equal(outside(['-C', path.join(root, 'files'), 'rev-parse', 'origin/main']).trim(), second.commit);
  assert.equal(outside(['-C', path.join(root, 'files'), 'rev-list', '--left-right', '--count', 'HEAD...origin/main']).trim(), '0\t0');
  assert.doesNotMatch(outside(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']), /local-only/);
});

test('existing checkout rejects staged work, branch changes and origin changes without altering index', async t => {
  const { root, remote, outside } = await setup(t);
  await fs.mkdir(root); outside(['clone', remote, path.join(root, 'files')]);
  const checkout = path.join(root, 'files');
  await fs.writeFile(path.join(checkout, 'note0.md'), 'User staged edit');
  outside(['-C', checkout, 'add', 'note0.md']);
  const index = await fs.readFile(path.join(checkout, '.git/index'));
  await assert.rejects(gitAdopt(root, remote, 'main', root, true), { code: 'CONFLICT' });
  assert.deepEqual(await fs.readFile(path.join(checkout, '.git/index')), index);
  outside(['-C', checkout, 'reset', '--', 'note0.md']);
  const { config } = await gitAdopt(root, remote, 'main', root, true);
  outside(['-C', checkout, 'add', 'note0.md']);
  const staged = await fs.readFile(path.join(checkout, '.git/index'));
  await assert.rejects(cycle(root, config), { code: 'CONFLICT' });
  assert.deepEqual(await fs.readFile(path.join(checkout, '.git/index')), staged);
  outside(['-C', checkout, 'reset', '--', 'note0.md']);
  outside(['-C', checkout, 'checkout', '-b', 'other']);
  await assert.rejects(cycle(root, config), { code: 'CONFLICT' });
  outside(['-C', checkout, 'checkout', 'main']);
  outside(['-C', checkout, 'remote', 'set-url', 'origin', remote + '-other']);
  await assert.rejects(cycle(root, config), { code: 'CONFLICT' });
  assert.equal(await fs.readFile(path.join(checkout, 'note0.md'), 'utf8'), 'User staged edit');
});
