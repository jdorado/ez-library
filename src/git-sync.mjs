import * as fs from 'node:fs/promises';
import path from 'node:path';
import { atomic, fail, hash, jsonBytes, locked, safePath, settings } from './store.mjs';
import { native, succeeded } from './native.mjs';
import { inventory } from './indexer.mjs';

const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const privateDir = (root, repo) => path.join(root, 'sync/keys', hash(repo));
export function repositoryURL(repository) {
  if (typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) && !repository.split('/').some(x => x.startsWith('.'))) return `git@github.com:${repository}.git`;
  if (typeof repository === 'string' && path.isAbsolute(repository) && !/[\x00-\x1f]/.test(repository)) return repository;
  fail('INVALID', 'Use owner/repository or an explicitly selected local bare repository');
}
export async function gitKey(root, repository) {
  if (path.isAbsolute(repositoryURL(repository))) fail('INVALID', 'Local Git needs no deploy key');
  return locked(root, async root => {
    const dir = privateDir(root, repository);
    await safePath(root, path.relative(root, dir) + '/key', true);
    const key = path.join(dir, 'key');
    try { await fs.access(key); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      succeeded(await native(root, '/usr/bin/ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'Ez Library repository sync', '-f', key]), 'Generate repository key');
    }
    // Public trust material is fetched over authenticated HTTPS, never TOFU.
    const response = await fetch('https://api.github.com/meta', { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'ez-library' } });
    if (!response.ok) fail('UNAVAILABLE', 'Cannot verify GitHub SSH host keys');
    const { ssh_keys: keys } = await response.json();
    if (!Array.isArray(keys) || !keys.length || keys.some(k => !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+$/.test(k))) fail('UNAVAILABLE', 'Unexpected GitHub host-key response');
    await atomic(path.join(dir, 'known_hosts'), keys.map(k => 'github.com ' + k).join('\n') + '\n');
    return { repository, publicKey: (await fs.readFile(key + '.pub', 'utf8')).trim(), registration: 'Register this public key with write access through the connected GitHub plugin. Private key stays in Library.' };
  });
}

export function git(root, config, args, options = {}) {
  const dir = privateDir(root, config.repository);
  const workTree = path.join(root, config.textMirror ? 'sync/text-mirror/files' : 'files');
  const gitDir = path.join(root, config.textMirror ? 'sync/text-mirror/git' : 'sync/git');
  return native(root, '/usr/bin/git', ['-C', workTree, '--git-dir=' + gitDir, '--work-tree=' + workTree,
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'core.filemode=false',
    '-c', 'user.name=Ez Library', '-c', 'user.email=library@localhost', ...args], {
    ...options, env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: path.isAbsolute(config.repository) ? 'file' : 'ssh',
      GIT_SSH_COMMAND: ['/usr/bin/ssh', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + path.join(dir, 'known_hosts'), '-i', path.join(dir, 'key')].map(quote).join(' ') } });
}

async function tree(root, config, ref) {
  const output = succeeded(await git(root, config, ['ls-tree', '-rz', '--full-tree', ref]), 'Read repository tree');
  const entries = [];
  for (const record of output.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
    if (!match) fail('UNSAFE_PATH', 'Git sync does not support symlinks or submodules');
    const name = match[3];
    // Git metadata paths may exist in the repository, but are never executable
    // workspace policy. Reject traversal/control paths and Git's own directory.
    if (/[\x00-\x1f\\]/.test(name) || name.split('/').some(x => !x || x === '.' || x === '..' || x.toLowerCase() === '.git')) fail('UNSAFE_PATH', 'Unsafe repository path');
    entries.push({ path: name, oid: match[2] });
  }
  return entries;
}

async function checkPolicy(root, repository, branch) {
  const storage = (await settings(root)).settings.storage;
  if (['hybrid', 'drive'].includes(storage.mode)) fail('CONFLICT', 'GitHub-only sync cannot override Drive/Hybrid policy; review and change storage policy before adopting');
  if (storage.mode === 'github' && (storage.github.repository !== repository || storage.github.branch !== branch)) fail('CONFLICT', 'Git binding must match configured repository and branch');
}

export async function gitAdopt(root, repository, branch = 'main') {
  const remote = repositoryURL(repository);
  return locked(root, async root => {
    await checkPolicy(root, repository, branch);
    if (path.isAbsolute(remote) && (remote === root || remote.startsWith(root + '/') || root.startsWith(remote + '/'))) fail('UNSAFE_PATH', 'Git source must be outside Library state');
    await fs.mkdir(path.join(root, 'sync'), { recursive: true, mode: 0o700 });
    const binding = await safePath(root, 'sync/config.json');
    try { await fs.access(binding); fail('CONFLICT', 'A sync binding already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // Local state can be preserved in-place only when the remote has the same
    // bytes at every existing path. Extra local files stay as pending additions.
    const local = await inventory(path.join(root, 'files'), '', { includeHidden: true });
    const config = { schemaVersion: 1, backend: 'git', repository, branch, mode: 'paused', intervalSeconds: 60 };
    succeeded(await git(root, config, ['check-ref-format', '--branch', branch]), 'Validate branch');
    const repoDir = await safePath(root, 'sync/git/probe', true);
    await fs.mkdir(path.dirname(repoDir), { recursive: true, mode: 0o700 });
    succeeded(await native(root, '/usr/bin/git', ['init', '--bare', path.join(root, 'sync/git')], { env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }), 'Initialize Git');
    succeeded(await git(root, config, ['config', 'core.bare', 'false']), 'Configure Git');
    succeeded(await git(root, config, ['remote', 'add', 'origin', remote]), 'Set Git remote');
    // A failed setup leaves the prepared binding paused, never silently rebound.
    await atomic(binding, jsonBytes(config));
    succeeded(await git(root, config, ['fetch', '--no-tags', 'origin', 'refs/heads/' + branch]), 'Fetch existing branch');
    const entries = await tree(root, config, 'FETCH_HEAD');
    const existing = new Map(local.map(f => [f.path, f]));
    for (const entry of entries) {
      if (!existing.has(entry.path)) continue;
      const oid = succeeded(await git(root, config, ['hash-object', '--no-filters', '--', path.join(root, 'files', entry.path)]), 'Check local original').trim();
      if (oid !== entry.oid) fail('CONFLICT', 'Existing local original differs from Git: ' + entry.path);
    }
    succeeded(await git(root, config, ['symbolic-ref', 'HEAD', 'refs/heads/' + branch]), 'Select branch');
    succeeded(await git(root, config, ['reset', '--mixed', 'FETCH_HEAD']), 'Initialize native index');
    const missing = entries.filter(e => !existing.has(e.path)).map(e => e.path + '\0').join('');
    if (missing) succeeded(await git(root, config, ['checkout-index', '-z', '--stdin'], { input: missing }), 'Import tracked files');
    config.mode = 'two-way';
    await atomic(binding, jsonBytes(config));
    return { config, imported: entries.length, indexing: 'pending' };
  });
}

export async function gitTransfer(root, config) {
  await checkPolicy(root, config.repository, config.branch);
  const actualRemote = succeeded(await git(root, config, ['remote', 'get-url', 'origin']), 'Check bound remote').trim();
  if (actualRemote !== repositoryURL(config.repository)) fail('CONFLICT', 'Git remote no longer matches the Library binding');
  const conflict = succeeded(await git(root, config, ['ls-files', '--unmerged']), 'Inspect merge state');
  if (conflict) fail('CONFLICT', 'Git merge unresolved; use native git status/show/add to resolve both retained versions before syncing');
  const files = await inventory(path.join(root, 'files'), '', { includeHidden: true });
  if (files.some(f => f.bytes >= 100 * 1024 * 1024)) fail('TOO_LARGE', 'GitHub ordinary files must be below 100 MiB; select another storage mode for larger media');
  succeeded(await git(root, config, ['add', '--all', '--', '.']), 'Stage Library changes');
  const stagedTree = succeeded(await git(root, config, ['write-tree']), 'Read staged tree').trim();
  await tree(root, config, stagedTree);
  const ignored = succeeded(await git(root, config, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']), 'Inspect ignored files').split('\0').filter(Boolean);
  if (ignored.some(name => files.some(file => file.path === name))) fail('CONFLICT', 'Library files are excluded by repository ignore rules; reconcile the rules before claiming synchronization');
  const diff = await git(root, config, ['diff', '--cached', '--quiet']);
  if (![0, 1].includes(diff.code)) succeeded(diff, 'Inspect staged changes');
  const merging = await git(root, config, ['rev-parse', '--verify', 'MERGE_HEAD']);
  if (diff.code === 1 || merging.code === 0) succeeded(await git(root, config, ['commit', '--no-gpg-sign', '-m', 'Sync Library changes']), 'Commit Library changes');
  succeeded(await git(root, config, ['fetch', '--no-tags', 'origin', 'refs/heads/' + config.branch]), 'Fetch remote changes');
  await tree(root, config, 'FETCH_HEAD');
  const head = succeeded(await git(root, config, ['rev-parse', 'HEAD']), 'Read local commit').trim();
  const merge = await git(root, config, ['merge', '--no-edit', '--no-gpg-sign', 'FETCH_HEAD']);
  if (merge.code !== 0) {
    if (succeeded(await git(root, config, ['ls-files', '--unmerged']), 'Inspect conflicts')) fail('CONFLICT', 'Both revisions retained in Git merge stages. Resolve the merge before sync/indexing resumes');
    succeeded(merge, 'Merge remote changes');
  }
  const commit = succeeded(await git(root, config, ['rev-parse', 'HEAD']), 'Read synchronized commit').trim();
  succeeded(await git(root, config, ['push', 'origin', 'HEAD:refs/heads/' + config.branch]), 'Push Library changes');
  const remote = succeeded(await git(root, config, ['ls-remote', '--exit-code', 'origin', 'refs/heads/' + config.branch]), 'Verify remote commit').trim().split(/\s+/)[0];
  if (remote !== commit) fail('UNCERTAIN', 'Remote advanced during verification; fetch/reconcile on the next cycle');
  return { commit, previousCommit: head, remoteVerified: true };
}
