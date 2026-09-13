import * as fs from 'node:fs/promises';
import path from 'node:path';
import { atomic, fail, hash, jsonBytes, locked, safePath } from './store.mjs';
import { inventory, refreshIndex } from './indexer.mjs';
import { rclone, succeeded } from './native.mjs';
import { mirrorTransfer, mirrorStatus } from './git-mirror.mjs';
import { gitTransfer } from './git-sync.mjs';

const marker = 'LIBRARY_SYNC_ACCESS';
const filters = '- .*\n- .*/**\n';
const common = ['--drive-skip-gdocs', '--drive-skip-shortcuts', '--retries', '1', '--contimeout', '15s', '--timeout', '60s'];
const readJSON = async file => {
  const root = path.dirname(path.dirname(file));
  await safePath(root, path.relative(root, file));
  return fs.readFile(file, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
};
const location = root => path.join(root, 'sync/config.json');

async function prepare(root) {
  for (const dir of ['sync', 'sync/bisync', 'sync/history']) {
    await fs.mkdir(path.join(root, dir), { recursive: true, mode: 0o700 });
    if ((await fs.lstat(path.join(root, dir))).isSymbolicLink()) fail('UNSAFE_PATH', 'Sync directories cannot be symlinks');
  }
  const file = path.join(root, 'sync/filters');
  try { await fs.writeFile(file, filters, { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}

async function remoteIdentity(root, remote, stateRoot = root) {
  if (typeof remote !== 'string' || !remote || /[\x00-\x1f\\]/.test(remote)) fail('INVALID', 'Supply a native rclone remote:path or absolute folder');
  if (path.isAbsolute(remote)) {
    const real = await fs.realpath(remote);
    stateRoot = await fs.realpath(stateRoot);
    if (real !== remote || real === stateRoot || real.startsWith(stateRoot + '/') || stateRoot.startsWith(real + '/')) fail('UNSAFE_PATH', 'Sync folder must be real and outside Library state');
    const stat = await fs.lstat(real);
    if (!stat.isDirectory()) fail('UNSAFE_PATH', 'Expected an existing folder');
    return `local:${stat.dev}:${stat.ino}`;
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]*:[^:]+$/.test(remote) || remote.split(':')[1].split('/').some(p => !p || p.startsWith('.'))) fail('INVALID', 'Use a named remote and a non-hidden folder path, without inline options');
  const name = remote.split(':')[0];
  // Inspect native configuration in memory only. Do not expose tokens, accept
  // aliases, or resolve a Drive root ID that could hide a trashed ancestor.
  const profile = JSON.parse(succeeded(await rclone(root, ['config', 'dump']), 'Native connection inspection'))[name];
  if (!profile || !['drive', 'dropbox'].includes(profile.type)) fail('INVALID', 'This binding supports native Drive or Dropbox profiles');
  if (profile.root_folder_id || profile.trashed_only === 'true' || profile.team_drive) fail('INVALID', 'Use an account-root profile and the visible folder path; rooted/shared-drive profiles require separate validation');
  // A backend-root stat can be synthetic and omit its ID (notably Drive).
  // Resolve every component from its parent, also rejecting ambiguous ancestors.
  let parent = name + ':', stat;
  for (const part of remote.slice(parent.length).split('/')) {
    const entries = JSON.parse(succeeded(await rclone(root, ['lsjson', parent, '--dirs-only', ...common]), 'Folder identity'));
    const matches = entries.filter(entry => entry.IsDir && entry.Path === part);
    if (matches.length !== 1 || !matches[0].ID) fail('CONFLICT', 'Mapped folder is missing, ambiguous, or has no provider identity');
    stat = matches[0];
    parent += (parent.endsWith(':') ? '' : '/') + part;
  }
  return `${profile.type}:${stat.ID}`;
}

async function inspect(root, remote, stateRoot) {
  const identity = await remoteIdentity(root, remote, stateRoot);
  const entries = JSON.parse(succeeded(await rclone(root, ['lsjson', remote, '--recursive', '--hash', '--exclude', '.*', '--exclude', '.*/**', ...common]), 'Folder inventory'));
  const seen = new Set();
  for (const file of entries) {
    await safePath(root, 'files/' + file.Path + (file.IsDir ? '/path-check' : ''));
    if (seen.has(file.Path)) fail('CONFLICT', 'Duplicate provider paths must be resolved before adoption');
    seen.add(file.Path);
  }
  return { remote, identity, files: entries.filter(file => !file.IsDir) };
}

export async function syncStatus(root) {
  const config = await readJSON(location(root));
  return { config, revision: config ? hash(jsonBytes(config)) : null,
    status: await readJSON(path.join(root, 'sync/status.json')),
    textMirror: await mirrorStatus(root),
    index: await readJSON(path.join(root, 'sync/index.json')) };
}

export async function syncPlan(root, remote, stateRoot = root) {
  return locked(root, async root => {
    await prepare(root);
    const plan = await inspect(root, remote, stateRoot);
    const local = await inventory(path.join(root, 'files'));
    const check = local.length ? await rclone(root, ['check', path.join(root, 'files'), remote, '--one-way', '--download', '--exclude', marker, ...common]) : { code: 0 };
    return { remote, identity: plan.identity, remoteFiles: plan.files.length, localFiles: local.length,
      localMatchesRemote: check.code === 0, policy: 'two-way', intervalSeconds: 60,
      excluded: ['hidden files/directories', 'Google-native documents', 'Drive shortcuts'],
      ready: check.code === 0, note: 'Adoption requires every existing local file to match the selected folder. Conflicts stop adoption.' };
  });
}

function bisyncArgs(root, config, initial = false) {
  return ['bisync', path.join(root, 'files'), config.remote,
    '--workdir', path.join(root, 'sync/bisync'), '--filters-file', path.join(root, 'sync/filters'),
    '--check-access', '--check-filename', marker, '--compare', 'size,modtime,checksum',
    '--conflict-resolve', 'none', '--conflict-loser', 'num', '--conflict-suffix', 'conflict-local,conflict-remote',
    '--create-empty-src-dirs', '--resilient', '--recover', '--max-delete', '50',
    '--backup-dir1', path.join(root, 'sync/history', new Date().toISOString().replaceAll(':', '-')),
    ...(initial ? ['--resync-mode', 'path2'] : []), ...common];
}

export async function syncAdopt(root, remote, stateRoot = root) {
  return locked(root, async root => {
    await prepare(root);
    if (await readJSON(location(root))) fail('CONFLICT', 'A folder is already bound; inspect sync-status rather than replacing it');
    const plan = await inspect(root, remote, stateRoot);
    const files = path.join(root, 'files');
    if ((await inventory(files)).some(f => f.path !== marker)) {
      const check = await rclone(root, ['check', files, remote, '--one-way', '--download', '--exclude', marker, ...common]);
      if (check.code !== 0) fail('CONFLICT', 'Existing local files differ from the folder. Preserve and reconcile them before adopting');
    }
    // Import first, with no replacement of local originals. Initial bisync is
    // allowed only here; the recurring worker never resets its baseline.
    succeeded(await rclone(root, ['copy', remote, files, '--ignore-existing', '--create-empty-src-dirs', '--exclude', '.*', '--exclude', '.*/**', ...common]), 'Initial folder import');
    succeeded(await rclone(root, ['check', remote, files, '--one-way', '--download', '--exclude', '.*', '--exclude', '.*/**', ...common]), 'Imported byte verification');
    if (await remoteIdentity(root, remote, stateRoot) !== plan.identity) fail('CONFLICT', 'Folder identity changed during adoption');
    if (!plan.files.some(f => f.Path === marker)) {
      await fs.writeFile(path.join(files, marker), 'Library sync access marker. Removing this file pauses synchronization.\n', { mode: 0o600, flag: 'wx' });
      succeeded(await rclone(root, ['copyto', path.join(files, marker), remote + '/' + marker, '--immutable', ...common]), 'Sync access marker');
    }
    const config = { schemaVersion: 1, remote, identity: plan.identity, mode: 'paused', intervalSeconds: 60 };
    // Persist the binding before the first remote mutation by bisync. An
    // interrupted adoption stays paused and needs deliberate recovery.
    await atomic(location(root), jsonBytes(config));
    succeeded(await rclone(root, [...bisyncArgs(root, config, true), '--dry-run']), 'Initial sync preview');
    succeeded(await rclone(root, bisyncArgs(root, config, true)), 'Initial sync');
    config.mode = 'two-way';
    await atomic(location(root), jsonBytes(config));
    await atomic(path.join(root, 'sync/status.json'), jsonBytes({ state: 'synced', syncedAt: new Date().toISOString(), indexing: 'pending' }));
    return { ...await syncStatus(root), imported: plan.files.length };
  });
}

export async function syncPolicy(root, { expected, mode, intervalSeconds = 60 }) {
  if (!['paused', 'two-way'].includes(mode) || !Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 3600) fail('INVALID', 'Use paused or two-way, and an interval from 30 to 3600 seconds');
  return locked(root, async root => {
    const current = await syncStatus(root);
    if (!current.config || current.revision !== expected) fail('CONFLICT', 'Read the current sync revision before changing policy');
    await atomic(location(root), jsonBytes({ ...current.config, mode, intervalSeconds }));
    return syncStatus(root);
  });
}

export async function syncRun(root, stateRoot = root) {
  return locked(root, async root => {
    await prepare(root);
    const config = await readJSON(location(root));
    const mirror = (await mirrorStatus(root)).config;
    if (config?.mode === 'paused') return { state: 'paused' };
    if (!config && mirror?.mode !== 'one-way') return { state: mirror ? 'paused' : 'unconfigured' };
    let status = { state: 'syncing', startedAt: new Date().toISOString() };
    await atomic(path.join(root, 'sync/status.json'), jsonBytes(status));
    try {
      if (config?.backend === 'git') status.git = await gitTransfer(root, config);
      else if (config) {
        if (await remoteIdentity(root, config.remote, stateRoot) !== config.identity) fail('CONFLICT', 'Mapped folder disappeared or changed identity; no automatic recreation');
        succeeded(await rclone(root, bisyncArgs(root, config)), 'Native bisync');
      }
      status = { ...status, state: 'indexing', syncedAt: new Date().toISOString() };
      await atomic(path.join(root, 'sync/status.json'), jsonBytes(status));
      try { status.textMirror = await mirrorTransfer(root); }
      catch (error) { status.textMirror = { state: 'pending', error: { code: error.code || 'UNAVAILABLE', message: error.message } }; }
      const index = await refreshIndex(root);
      status = { ...status, state: index.conflicts?.length ? 'synced-with-conflicts' : index.pending.length ? 'indexed-with-pending-extraction' : 'synced-and-indexed', indexedAt: index.indexedAt, embedded: index.embedded };
    } catch (error) {
      status = { ...status, state: status.syncedAt ? 'index-pending' : 'sync-error', error: { code: error.code || 'UNAVAILABLE', message: error.message } };
      await atomic(path.join(root, 'sync/status.json'), jsonBytes(status));
      throw error;
    }
    await atomic(path.join(root, 'sync/status.json'), jsonBytes(status));
    if (status.textMirror?.state === 'pending') fail('UNAVAILABLE', 'GitHub text mirror pending: ' + status.textMirror.error.message);
    return status;
  });
}
