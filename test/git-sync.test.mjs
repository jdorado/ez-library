import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { gitAdopt, gitTransfer, git, repositoryURL, remoteReceipt } from '../src/git-sync.mjs';
import { locked, put, digest, organize, jsonBytes, operation } from '../src/store.mjs';
import { syncPolicy, syncRun, syncStatus } from '../src/sync.mjs';

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

test('pull-only imports additions, renames and deletions without a push or local commit', async t => {
  const { root, remote, external, outside, publish } = await setup(t);
  const { config } = await gitAdopt(root, remote, 'main', root, false, 'pull-only');
  // Any push, even one with no changed refs, would fail against this URL.
  await git(root, config, ['remote', 'set-url', '--push', 'origin', remote + '-forbidden']);
  await fs.writeFile(path.join(external, 'incoming.md'), 'Remote-only violet telescope');
  await fs.rename(path.join(external, 'note0.md'), path.join(external, 'renamed.md'));
  await fs.unlink(path.join(external, 'note1.md')); publish();
  const expected = outside(['--git-dir', remote, 'rev-parse', 'main']).trim();
  const result = await cycle(root, config);
  assert.equal(result.commit, expected);
  assert.equal(result.remoteVerified, true);
  assert.match(await fs.readFile(path.join(root, 'files/incoming.md'), 'utf8'), /violet/);
  assert.match(await fs.readFile(path.join(root, 'files/renamed.md'), 'utf8'), /Note 0/);
  await assert.rejects(fs.stat(path.join(root, 'files/note1.md')), { code: 'ENOENT' });
  assert.equal((await cycle(root, config)).commit, expected);
  assert.equal(outside(['--git-dir', remote, 'rev-parse', 'main']).trim(), expected);
});

test('pull-only preserves local edits, staged work and untracked files without committing them', async t => {
  for (const kind of ['edited', 'staged', 'untracked']) {
    const { root, remote, outside } = await setup(t);
    const { config } = await gitAdopt(root, remote, 'main', root, false, 'pull-only');
    const original = outside(['--git-dir', remote, 'rev-parse', 'main']).trim();
    const name = kind === 'untracked' ? 'local.md' : 'note0.md';
    await fs.writeFile(path.join(root, 'files', name), 'Preserve local ' + kind);
    if (kind === 'staged') await git(root, config, ['add', '--', name]);
    await assert.rejects(cycle(root, config), { code: 'CONFLICT' });
    assert.equal(await fs.readFile(path.join(root, 'files', name), 'utf8'), 'Preserve local ' + kind);
    assert.equal((await git(root, config, ['rev-parse', 'HEAD'])).stdout.trim(), original);
    assert.equal(outside(['--git-dir', remote, 'rev-parse', 'main']).trim(), original);
    if (kind === 'staged') assert.match((await git(root, config, ['show', ':' + name])).stdout, /Preserve local staged/);
  }
});

test('pull-only rejects ahead and divergent local history without resetting or merging', async t => {
  for (const diverged of [false, true]) {
    const { root, remote, external, outside, publish } = await setup(t);
    const { config } = await gitAdopt(root, remote, 'main', root, false, 'pull-only');
    await fs.writeFile(path.join(root, 'files/local.md'), 'Preserve local commit');
    await git(root, config, ['add', '--', 'local.md']);
    await git(root, config, ['commit', '-m', 'Local work']);
    const head = (await git(root, config, ['rev-parse', 'HEAD'])).stdout.trim();
    if (diverged) { await fs.writeFile(path.join(external, 'remote.md'), 'External work'); publish(); }
    const remoteHead = outside(['--git-dir', remote, 'rev-parse', 'main']).trim();
    await assert.rejects(cycle(root, config), { code: 'CONFLICT' });
    assert.equal((await git(root, config, ['rev-parse', 'HEAD'])).stdout.trim(), head);
    assert.equal(outside(['--git-dir', remote, 'rev-parse', 'main']).trim(), remoteHead);
    assert.equal((await git(root, config, ['rev-parse', '--verify', 'MERGE_HEAD'])).code, 128);
  }
});

test('an existing two-way Git binding can switch to revision-guarded pull-only sync', async t => {
  const { root, remote } = await setup(t);
  await gitAdopt(root, remote);
  const before = await syncStatus(root);
  const after = await syncPolicy(root, { expected: before.revision, mode: 'pull-only', intervalSeconds: 30 });
  assert.equal(after.config.mode, 'pull-only');
  await cycle(root, after.config);
  await assert.rejects(syncPolicy(root, { expected: before.revision, mode: 'two-way' }), { code: 'CONFLICT' });
});

test('pull-only adoption preserves and refuses extra local originals', async t => {
  const { root, remote } = await setup(t);
  await put(root, 'local.md', Readable.from(['Keep this original']), { expected: 'new', key: 'local' });
  await assert.rejects(gitAdopt(root, remote, 'main', root, false, 'pull-only'), { code: 'CONFLICT' });
  assert.equal(await fs.readFile(path.join(root, 'files/local.md'), 'utf8'), 'Keep this original');
  assert.equal((await syncStatus(root)).config.mode, 'paused');
});

test('pull-only advances an explicitly adopted existing checkout without creating commits', async t => {
  const { root, remote, external, outside, publish } = await setup(t);
  await fs.mkdir(root); outside(['clone', remote, path.join(root, 'files')]);
  const { config } = await gitAdopt(root, remote, 'main', root, true, 'pull-only');
  await fs.writeFile(path.join(external, 'incoming.md'), 'External checkout update'); publish();
  const expected = outside(['--git-dir', remote, 'rev-parse', 'main']).trim();
  assert.equal((await cycle(root, config)).commit, expected);
  assert.equal(outside(['-C', path.join(root, 'files'), 'rev-parse', 'HEAD']).trim(), expected);
  assert.equal(outside(['-C', path.join(root, 'files'), 'rev-parse', 'origin/main']).trim(), expected);
});

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

test('a stalled Git transport ends the cycle UNAVAILABLE, releases the writer lock and the next sync succeeds', async t => {
  const { base, root, remote, outside } = await setup(t);
  const { config } = await gitAdopt(root, remote);
  // A transport that connects, then never answers.
  const stall = path.join(base, 'stall.sh');
  await fs.writeFile(stall, '#!/bin/sh\nexec sleep 120\n', { mode: 0o755 });
  await git(root, config, ['config', 'remote.origin.uploadpack', stall]);
  await put(root, 'stalled.md', Readable.from(['# Stalled\nMarigold ledger.']), { expected: 'new', key: 'stalled' });
  const previous = process.env.EZ_LIBRARY_GIT_TIMEOUT_MS;
  process.env.EZ_LIBRARY_GIT_TIMEOUT_MS = '1500';
  t.after(() => { if (previous === undefined) delete process.env.EZ_LIBRARY_GIT_TIMEOUT_MS; else process.env.EZ_LIBRARY_GIT_TIMEOUT_MS = previous; });
  const started = Date.now();
  await assert.rejects(syncRun(root), { code: 'UNAVAILABLE', message: /timed out/ });
  assert(Date.now() - started < 30000, 'the stalled fetch was stopped, not waited for');
  const failed = (await syncStatus(root)).status;
  assert.equal(failed.state, 'sync-error');
  assert.equal(failed.step, 'fetch');
  assert.equal(failed.error.code, 'UNAVAILABLE');
  // The writer lock is free: another writer is not BUSY.
  await put(root, 'after.md', Readable.from(['# After\nHeron.']), { expected: 'new', key: 'after' });
  await git(root, config, ['config', '--unset', 'remote.origin.uploadpack']);
  // The next cycle takes the same writer lock and transfers both files.
  const result = await cycle(root, config);
  assert.equal(result.remoteVerified, true);
  assert.match(outside(['--git-dir', remote, 'show', 'main:stalled.md']), /Marigold/);
  assert.match(outside(['--git-dir', remote, 'show', 'main:after.md']), /Heron/);
});

test('a bounded call that exits in time settles even while a grandchild still holds its pipes', async t => {
  const { native } = await import('../src/native.mjs');
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ez-library-native-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await native(root, '/bin/sh', ['-c', 'sleep 2 & exit 0'], { timeout: 500 });
  assert.equal(result.code, 0);
});

test('a read by key says whether the remote holds the write and names the commit, with no network call', async t => {
  const { root, remote, outside } = await setup(t);
  const { config } = await gitAdopt(root, remote);
  const saved = await put(root, 'agent.md', Readable.from(['# Agent\nSaffron notebook.']), { expected: 'new', key: 'receipt:put' });
  const receipt = async key => remoteReceipt(root, config, await operation(root, key));
  assert.deepEqual(await receipt('receipt:put'), { state: 'pending', commit: null });
  // Break the remote: a read by key must still answer from local Git.
  const url = (await git(root, config, ['remote', 'get-url', 'origin'])).stdout.trim();
  await git(root, config, ['remote', 'set-url', 'origin', remote + '-gone']);
  assert.deepEqual(await receipt('receipt:put'), { state: 'pending', commit: null });
  await git(root, config, ['remote', 'set-url', 'origin', url]);
  const result = await cycle(root, config);
  const pushed = await receipt('receipt:put');
  assert.equal(pushed.state, 'pushed');
  assert.equal(pushed.commit, outside(['--git-dir', remote, 'log', '-n', '1', '--format=%H', 'main', '--', 'agent.md']).trim());
  assert.equal(pushed.commit, result.commit);
  // A newer local version is pending again, and a move or remove follows its own destination.
  const next = await put(root, 'agent.md', Readable.from(['# Agent\nSecond.']), { expected: saved.sha256, key: 'receipt:edit' });
  assert.equal((await receipt('receipt:edit')).state, 'pending');
  await cycle(root, config);
  assert.equal((await receipt('receipt:edit')).state, 'pushed');
  await organize(root, { path: 'agent.md', to: 'moved/agent.md', expected: next.sha256, key: 'receipt:move' });
  assert.equal((await receipt('receipt:move')).state, 'pending');
  await cycle(root, config);
  assert.equal((await receipt('receipt:move')).state, 'pushed');
  await organize(root, { path: 'moved/agent.md', expected: next.sha256, key: 'receipt:remove' });
  assert.equal((await receipt('receipt:remove')).state, 'pending');
  await cycle(root, config);
  assert.deepEqual(await receipt('receipt:remove'), { state: 'pushed', commit: null });
  // A deletion made before this write is not this write's: only absence at the tip counts, and it has no commit.
  await put(root, 'again.md', Readable.from(['x']), { expected: 'new', key: 'receipt:again' });
  await cycle(root, config);
  const again = await digest(path.join(root, 'files/again.md'));
  await organize(root, { path: 'again.md', expected: again.sha256, key: 'receipt:again-remove' });
  assert.deepEqual(await receipt('receipt:again-remove'), { state: 'pending', commit: null });
});

test('receipt paths are literal names, never pathspec patterns', async t => {
  const { root, remote, outside } = await setup(t);
  const { config } = await gitAdopt(root, remote);
  const same = await fs.readFile(path.join(root, 'files/note0.md'));
  const receipt = async key => remoteReceipt(root, config, await operation(root, key));
  // Same bytes as the remote's note0.md, under names that a pathspec would resolve to it.
  for (const [i, name] of [':note0.md', 'note[0].md', 'note?.md', '*.md'].entries()) {
    await put(root, name, Readable.from([same]), { expected: 'new', key: `literal:${i}` });
    assert.deepEqual(await receipt(`literal:${i}`), { state: 'pending', commit: null }, name);
  }
  await cycle(root, config);
  for (const [i, name] of [':note0.md', 'note[0].md', 'note?.md', '*.md'].entries()) {
    const done = await receipt(`literal:${i}`);
    assert.equal(done.state, 'pushed', name);
    assert.equal(done.commit, outside(['--literal-pathspecs', '--git-dir', remote, 'log', '-n', '1', '--format=%H', 'main', '--', name]).trim(), name);
  }
});

test('operation --key does not depend on the sync status or text mirror files', async t => {
  const { root, remote } = await setup(t);
  const cli = new URL('../bin/ez-library.mjs', import.meta.url).pathname;
  await gitAdopt(root, remote);
  await put(root, 'a.md', Readable.from(['a']), { expected: 'new', key: 'k' });
  await fs.writeFile(path.join(root, 'sync/text-mirror.json'), '{ not json');
  await fs.writeFile(path.join(root, 'sync/status.json'), '{ not json');
  const out = JSON.parse(execFileSync(process.execPath, [cli, 'operation', '--key', 'k'], { encoding: 'utf8', env: { ...process.env, EZ_LIBRARY_STATE: root } })).data;
  assert.equal(out.state, 'stored'); assert.equal(out.git.state, 'pending');
});

test('operation --key adds the Git receipt only on a Git-bound Library', async t => {
  const { base, root, remote } = await setup(t);
  const cli = new URL('../bin/ez-library.mjs', import.meta.url).pathname;
  const read = (state, key) => JSON.parse(execFileSync(process.execPath, [cli, 'operation', '--key', key], { encoding: 'utf8', env: { ...process.env, EZ_LIBRARY_STATE: state } })).data;
  const plain = path.join(base, 'plain');
  await put(plain, 'a.md', Readable.from(['a']), { expected: 'new', key: 'k' });
  assert.equal(read(plain, 'k').git, undefined);
  const { config } = await gitAdopt(root, remote);
  await put(root, 'a.md', Readable.from(['a']), { expected: 'new', key: 'k' });
  assert.equal(read(root, 'k').git.state, 'pending');
  await cycle(root, config);
  const after = read(root, 'k');
  assert.equal(after.state, 'stored'); assert.equal(after.git.state, 'pushed'); assert.match(after.git.commit, /^[a-f0-9]{40}$/);
});
