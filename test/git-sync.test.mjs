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

test('adoption preserves mismatching local files and ignore rules cannot hide unsynced originals', async t => {
  const first = await setup(t);
  await put(first.root, 'note0.md', Readable.from(['Keep local']), { expected: 'new', key: 'local' });
  await assert.rejects(gitAdopt(first.root, first.remote), { code: 'CONFLICT' });
  assert.equal(await fs.readFile(path.join(first.root, 'files/note0.md'), 'utf8'), 'Keep local');
  const second = await setup(t);
  await fs.writeFile(path.join(second.external, '.gitignore'), '*.pdf\n'); second.publish();
  const { config } = await gitAdopt(second.root, second.remote);
  await put(second.root, 'original.pdf', Readable.from(['PDF fixture']), { expected: 'new', key: 'pdf' });
  await assert.rejects(cycle(second.root, config), { code: 'CONFLICT' });
  for (const invalid of ['https://token@github.com/owner/repo', 'owner/../repo', '-option', 'owner/.git']) assert.throws(() => repositoryURL(invalid), { code: 'INVALID' });
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
