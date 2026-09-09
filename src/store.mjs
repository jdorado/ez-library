import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class LibraryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const fail = (code, message) => { throw new LibraryError(code, message); };
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const defaults = () => ({ schemaVersion: 1, storage: { mode: 'local' }, backup: { mode: 'off' } });

function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('INVALID', 'Unknown or invalid settings fields');
}
function ref(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:@/-]{1,160}$/.test(value)) fail('INVALID', 'Expected an opaque connection or destination reference, not credentials');
}
export function validateSettings(s) {
  keys(s, ['schemaVersion', 'storage', 'backup']);
  if (s.schemaVersion !== 1) fail('INVALID', 'Unsupported settings schema');
  keys(s.storage, ['mode', 'github', 'drive', 'githubExtensions', 'maxGithubBytes']);
  const { mode, github, drive, githubExtensions, maxGithubBytes } = s.storage;
  if (!['local', 'github', 'drive', 'hybrid'].includes(mode)) fail('INVALID', 'Unknown storage mode');
  if (github !== undefined) {
    keys(github, ['connection', 'repository', 'branch']); ref(github.connection); ref(github.branch);
    if (typeof github.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(github.repository)) fail('INVALID', 'Expected owner/repository');
  }
  if (drive !== undefined) { keys(drive, ['connection', 'folderId']); ref(drive.connection); ref(drive.folderId); }
  if (['github', 'hybrid'].includes(mode) && !github) fail('INVALID', 'GitHub mode requires an explicit connection, repository and branch');
  if (['drive', 'hybrid'].includes(mode) && !drive) fail('INVALID', 'Drive mode requires an explicit connection and folder ID');
  if ((mode === 'local' && (github || drive)) || (mode === 'github' && drive) || (mode === 'drive' && github)) fail('INVALID', 'Destination does not match storage mode');
  if (mode === 'hybrid') {
    if (!Array.isArray(githubExtensions) || !githubExtensions.length || githubExtensions.some(x => typeof x !== 'string' || !/^\.[a-z0-9]{1,12}$/.test(x))) fail('INVALID', 'Hybrid mode requires explicit lowercase GitHub extensions');
    if (!Number.isSafeInteger(maxGithubBytes) || maxGithubBytes < 1 || maxGithubBytes >= 100 * 1024 * 1024) fail('INVALID', 'Hybrid GitHub ceiling must be below 100 MiB');
  } else if (githubExtensions !== undefined || maxGithubBytes !== undefined) fail('INVALID', 'Routing fields require hybrid mode');
  keys(s.backup, ['mode', 'connection', 'destination']);
  if (!['off', 'external'].includes(s.backup.mode)) fail('INVALID', 'Backup is off or an explicit external tool destination');
  if (s.backup.mode === 'external') { ref(s.backup.connection); ref(s.backup.destination); }
  else if (s.backup.connection !== undefined || s.backup.destination !== undefined) fail('INVALID', 'Disabled backup cannot specify a destination');
  return s;
}

export async function rootDir(root, create = false) {
  if (!path.isAbsolute(root)) fail('INVALID', 'State directory must be absolute');
  if (create) await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH', 'State must be a real private directory');
  return fs.realpath(root);
}
export async function safePath(root, relative, makeParents = false) {
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || /[\\\x00-\x1f\x7f]/.test(relative) || relative.split('/').some(p => !p || p.startsWith('.'))) fail('UNSAFE_PATH', 'Use a relative path without hidden, empty or parent components');
  const parts = relative.split('/');
  let target = root;
  for (let i = 0; i < parts.length; i++) {
    target = path.join(target, parts[i]);
    if (makeParents && i < parts.length - 1) await fs.mkdir(target, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const st = await fs.lstat(target).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (st && (st.isSymbolicLink() || (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()))) fail('UNSAFE_PATH', 'Symlinks and special files are unsupported');
  }
  return target;
}
export async function initialize(root) {
  root = await rootDir(root, true);
  for (const name of ['files', 'operations', 'history', 'tmp', 'qmd']) {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const st = await fs.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) fail('UNSAFE_PATH', 'Private state directories cannot be symlinks');
  }
  return root;
}
export async function locked(root, fn) {
  root = await rootDir(root, true);
  const lock = path.join(root, '.writer-lock');
  await fs.mkdir(lock, { mode: 0o700 }).catch(e => {
    if (e.code === 'EEXIST') fail('BUSY', 'Writer lock exists; confirm no command is active before recovering an interrupted operation');
    throw e;
  });
  try { return await fn(await initialize(root)); }
  finally { await fs.rmdir(lock); }
}
export async function digest(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile()) fail('UNSAFE_PATH', 'Expected a regular file');
    const sha = createHash('sha256'); let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { sha.update(chunk); bytes += chunk.length; }
    return { bytes, sha256: sha.digest('hex') };
  } finally { await handle.close(); }
}
async function current(file) { return digest(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; }); }
export async function atomic(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function operationPath(root, key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(key)) fail('INVALID', 'Supply a stable --key using letters, digits, colon, underscore or hyphen');
  return path.join(root, 'operations', hash(key) + '.json');
}
export async function settings(root) {
  const target = await safePath(root, 'settings.json');
  const data = await fs.readFile(target).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  return { settings: data ? validateSettings(JSON.parse(data)) : defaults(), sha256: data ? hash(data) : null };
}

// Receipts record intent before installation. Readback determines stored/changed/missing,
// including after interruption between the atomic receipt and file renames.
export async function put(root, relative, input, { key, expected, kind = 'file', maxBytes = MAX_FILE_BYTES } = {}) {
  if (expected !== 'new' && !/^[a-f0-9]{64}$/.test(expected || '')) fail('INVALID', 'Supply --expected new or the current SHA-256');
  if (!['file', 'settings'].includes(kind)) fail('INVALID', 'Unknown write kind');
  return locked(root, async root => {
    const receiptFile = operationPath(root, key);
    await safePath(root, path.relative(root, receiptFile));
    if (kind === 'file' && (typeof relative !== 'string' || !relative)) fail('INVALID', 'Supply a relative file path');
    const target = await safePath(root, kind === 'settings' ? 'settings.json' : 'files/' + relative, true);
    const temp = path.join(root, 'tmp', randomUUID());
    let bytes = 0; const sha = createHash('sha256');
    try {
      await pipeline(input, new Transform({ transform(chunk, encoding, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) return cb(new LibraryError('TOO_LARGE', `Input exceeds ${maxBytes} bytes`));
        sha.update(chunk); cb(null, chunk);
      } }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      const request = { kind, path: kind === 'settings' ? 'settings.json' : relative, bytes, sha256: sha.digest('hex'), expected };
      const oldReceipt = await fs.readFile(receiptFile, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (oldReceipt && JSON.stringify(oldReceipt) !== JSON.stringify(request)) fail('KEY_REUSED', 'Operation key was already used with different content or preconditions');
      const before = await current(target);
      if (oldReceipt && before?.sha256 === request.sha256) return { ...request, state: 'stored', replay: true };
      if (expected === 'new' ? before !== null : before?.sha256 !== expected) fail('CONFLICT', 'File changed; re-read before replacing');
      if (before) {
        const history = await safePath(root, 'history/' + before.sha256);
        await fs.copyFile(target, history, constants.COPYFILE_EXCL).catch(e => { if (e.code !== 'EEXIST') throw e; });
        await fs.chmod(history, 0o600);
      }
      await atomic(receiptFile, jsonBytes(request));
      await fs.rename(temp, target);
      const after = await digest(target);
      if (after.sha256 !== request.sha256) fail('UNCERTAIN', 'Write readback differs; inspect operation before retry');
      return { ...request, state: 'stored', replay: false };
    } finally { await fs.rm(temp, { force: true }); }
  });
}
export async function operation(root, key) {
  const receiptFile = await safePath(root, path.relative(root, operationPath(root, key)));
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  if (!['file', 'settings'].includes(receipt.kind)) fail('INVALID', 'Invalid operation receipt');
  const file = await safePath(root, receipt.kind === 'settings' ? 'settings.json' : 'files/' + receipt.path);
  const now = await current(file);
  return { ...receipt, state: !now ? 'missing' : now.sha256 === receipt.sha256 ? 'stored' : 'changed' };
}
export async function list(root, prefix = '', limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('INVALID', 'Limit must be 1..1000');
  if (prefix && (prefix.startsWith('/') || prefix.includes('..') || /[\\\x00-\x1f]/.test(prefix))) fail('UNSAFE_PATH', 'Invalid prefix');
  const files = []; let truncated = false;
  async function visit(dir, relative = '') {
    for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.')) continue;
      if (item.isSymbolicLink()) fail('UNSAFE_PATH', 'Symlink found in library');
      const rel = relative ? relative + '/' + item.name : item.name;
      if (item.isDirectory() && (rel.startsWith(prefix) || prefix.startsWith(rel + '/'))) await visit(path.join(dir, item.name), rel);
      else if (item.isFile() && rel.startsWith(prefix)) {
        if (files.length === limit) { truncated = true; return; }
        const st = await fs.stat(path.join(dir, item.name)); files.push({ path: rel, bytes: st.size });
      }
      if (truncated) return;
    }
  }
  const directory = path.join(await rootDir(root), 'files');
  if ((await fs.lstat(directory)).isSymbolicLink()) fail('UNSAFE_PATH', 'Library root cannot be a symlink');
  await visit(directory); return { files, truncated };
}
export { createReadStream, jsonBytes };
