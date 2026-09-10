import * as fs from 'node:fs/promises';
import path from 'node:path';
import { atomic, fail, hash, jsonBytes, locked, safePath } from './store.mjs';
import { inventory } from './indexer.mjs';
import { git, repositoryURL } from './git-sync.mjs';
import { native, succeeded } from './native.mjs';

const file = root => path.join(root, 'sync/text-mirror.json');
const mirrorGit = (root, config, args, options) => git(root, { ...config, textMirror: true }, args, options);
const validExcludedDirectory = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) &&
  !/[\x00-\x1f\\]/.test(value) && !value.endsWith('/') &&
  value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.') && part.toLowerCase() !== '.git');
function excludedDirectories(value = '') {
  const directories = value === '' || value === undefined ? [] : value.split(',').map(item => item.trim());
  if (directories.some(item => !validExcludedDirectory(item)) || new Set(directories).size !== directories.length) {
    fail('INVALID', 'Supply unique comma-separated relative directory prefixes without hidden or traversal segments');
  }
  return directories;
}
export async function mirrorStatus(root) {
  await safePath(root, 'sync/text-mirror.json');
  const config = await fs.readFile(file(root), 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (config && (config.schemaVersion !== 1 || !['paused', 'one-way'].includes(config.mode) || !Array.isArray(config.extensions) || !config.extensions.length || config.extensions.some(x => !/^\.[a-z0-9]{1,12}$/.test(x)) ||
    (config.excludeDirectories !== undefined && (!Array.isArray(config.excludeDirectories) || config.excludeDirectories.some(x => !validExcludedDirectory(x)) || new Set(config.excludeDirectories).size !== config.excludeDirectories.length)))) fail('INVALID', 'Invalid text mirror configuration');
  return { config, revision: config ? hash(jsonBytes(config)) : null };
}
export async function mirrorAdopt(root, repository, branch = 'main', extensions = '.md,.markdown,.txt,.csv,.tsv', stateRoot = root, excluded = '') {
  repositoryURL(repository);
  const exclusions = excludedDirectories(excluded);
  return locked(root, async root => {
    if (path.isAbsolute(repository)) {
      const real = await fs.realpath(repository), base = await fs.realpath(stateRoot);
      if (real !== repository || real === base || real.startsWith(base + '/') || base.startsWith(real + '/')) fail('UNSAFE_PATH', 'Mirror repository must be outside Library state');
    }
    const binding = JSON.parse(await fs.readFile(await safePath(root, 'sync/config.json'), 'utf8'));
    if (binding.backend === 'git') fail('CONFLICT', 'Text mirror requires a folder binding, not another Git writer');
    if ((await mirrorStatus(root)).config) fail('CONFLICT', 'Text mirror already configured; inspect git-mirror-status');
    const config = { schemaVersion: 1, repository, branch, extensions: extensions.split(','), mode: 'paused', ...(exclusions.length ? { excludeDirectories: exclusions } : {}) };
    if (!config.extensions.length || config.extensions.some(x => !/^\.[a-z0-9]{1,12}$/.test(x))) fail('INVALID', 'Supply comma-separated lowercase extensions');
    const dir = path.join(root, 'sync/text-mirror');
    await safePath(root, 'sync/text-mirror/files/probe', true);
    await fs.mkdir(path.join(dir, 'files'), { recursive: true, mode: 0o700 });
    succeeded(await mirrorGit(root, config, ['check-ref-format', '--branch', branch]), 'Validate mirror branch');
    await safePath(root, 'sync/text-mirror/git/probe', true);
    succeeded(await native(root, '/usr/bin/git', ['init', '--bare', path.join(dir, 'git')], { env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }), 'Initialize mirror');
    succeeded(await mirrorGit(root, config, ['config', 'core.bare', 'false']), 'Configure mirror');
    const expectedExclusions = JSON.stringify(exclusions);
    const recordedExclusions = await mirrorGit(root, config, ['config', '--get', 'ez-library.mirrorExcludeDirectories']);
    if (recordedExclusions.code === 0 && recordedExclusions.stdout.trim() !== expectedExclusions) fail('CONFLICT', 'Partial mirror setup uses different excluded directories');
    if (recordedExclusions.code !== 0) succeeded(await mirrorGit(root, config, ['config', 'ez-library.mirrorExcludeDirectories', expectedExclusions]), 'Record mirror exclusions');
    if ((await mirrorGit(root, config, ['rev-parse', '--verify', 'HEAD'])).code === 0) fail('CONFLICT', 'Unconfigured mirror has local history; preserve it for recovery');
    succeeded(await mirrorGit(root, config, ['symbolic-ref', 'HEAD', 'refs/heads/' + branch]), 'Select mirror branch');
    const origin = await mirrorGit(root, config, ['remote', 'get-url', 'origin']);
    if (origin.code === 0 && origin.stdout.trim() !== repositoryURL(repository)) fail('CONFLICT', 'Partial mirror setup belongs to another repository');
    if (origin.code !== 0) succeeded(await mirrorGit(root, config, ['remote', 'add', 'origin', repositoryURL(repository)]), 'Set mirror remote');
    // Only an empty remote branch can be adopted: never overwrite existing history.
    const existing = succeeded(await mirrorGit(root, config, ['ls-remote', 'origin', 'refs/heads/' + branch]), 'Check mirror destination');
    if (existing.trim()) fail('CONFLICT', 'Use a new empty mirror branch; existing history is not adopted or overwritten');
    config.mode = 'one-way';
    await atomic(file(root), jsonBytes(config));
    return mirrorStatus(root);
  });
}
export async function mirrorPolicy(root, expected, mode) {
  if (!['paused', 'one-way'].includes(mode)) fail('INVALID', 'Use paused or one-way');
  return locked(root, async root => {
    const current = await mirrorStatus(root);
    if (!current.config || current.revision !== expected) fail('CONFLICT', 'Read current git-mirror-status revision');
    await atomic(file(root), jsonBytes({ ...current.config, mode }));
    return mirrorStatus(root);
  });
}
// Caller holds the Library writer lock, after a successful folder transfer.
export async function mirrorTransfer(root) {
  const { config } = await mirrorStatus(root);
  if (!config || config.mode === 'paused') return { state: config ? 'paused' : 'disabled' };
  const run = (args, options) => mirrorGit(root, config, args, options);
  if (succeeded(await run(['remote', 'get-url', 'origin']), 'Check mirror remote').trim() !== repositoryURL(config.repository)) fail('CONFLICT', 'Mirror remote changed');
  const remote = succeeded(await run(['ls-remote', 'origin', 'refs/heads/' + config.branch]), 'Read mirror head').trim().split(/\s+/)[0];
  const local = await run(['rev-parse', '--verify', 'HEAD']);
  if (remote) {
    if (config.lastCommit && remote !== config.lastCommit && remote !== local.stdout.trim()) fail('CONFLICT', 'Mirror branch was changed externally');
    if (local.code !== 0) fail('CONFLICT', 'Mirror remote changed before first commit');
    succeeded(await run(['fetch', '--no-tags', 'origin', 'refs/heads/' + config.branch]), 'Fetch mirror head');
    if ((await run(['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'])).code !== 0) fail('CONFLICT', 'GitHub mirror was edited externally; preserve and reconcile it before resuming');
  } else if (config.lastCommit) fail('CONFLICT', 'Mirror branch disappeared; no automatic recreation');
  const exclusions = config.excludeDirectories || [];
  const selected = (await inventory(path.join(root, 'files'))).filter(x => config.extensions.includes(path.extname(x.path).toLowerCase()) &&
    !exclusions.some(directory => x.path === directory || x.path.startsWith(directory + '/')));
  if (selected.some(x => x.bytes >= 100 * 1024 * 1024)) fail('TOO_LARGE', 'Text mirror file exceeds GitHub ordinary-file limit');
  const target = path.join(root, 'sync/text-mirror/files');
  const selectedPaths = new Set(selected.map(x => x.path));
  for (const old of await inventory(target)) {
    if (!selectedPaths.has(old.path)) await fs.unlink(await safePath(root, 'sync/text-mirror/files/' + old.path));
  }
  for (const item of selected) {
    const destination = await safePath(root, 'sync/text-mirror/files/' + item.path, true);
    await fs.copyFile(await safePath(root, 'files/' + item.path), destination);
  }
  // Projection is outside originals; neither repository metadata nor ignore rules
  // can affect intake. Native Git records adds, edits and deletions as one batch.
  succeeded(await run(['add', '--all', '--force', '--', '.']), 'Stage text mirror');
  const diff = await run(['diff', '--cached', '--quiet']);
  if (![0, 1].includes(diff.code)) succeeded(diff, 'Inspect mirror changes');
  if (diff.code === 1 || local.code !== 0) succeeded(await run(['commit', '--allow-empty', '--no-gpg-sign', '-m', 'Version Library text changes']), 'Commit text mirror');
  const commit = succeeded(await run(['rev-parse', 'HEAD']), 'Read mirror commit').trim();
  succeeded(await run(['push', 'origin', 'HEAD:refs/heads/' + config.branch]), 'Push text mirror');
  const verified = succeeded(await run(['ls-remote', 'origin', 'refs/heads/' + config.branch]), 'Verify text mirror').trim().split(/\s+/)[0];
  if (verified !== commit) fail('UNCERTAIN', 'Mirror advanced during verification');
  await atomic(file(root), jsonBytes({ ...config, lastCommit: commit }));
  return { state: 'mirrored', repository: config.repository, branch: config.branch, commit, files: selected.length, remoteVerified: true };
}
