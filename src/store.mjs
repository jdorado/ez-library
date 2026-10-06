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
export const MAX_READ_BYTES = 512 * 1024;
export const MAX_REPLACE_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
export const defaults = () => ({ schemaVersion: 1, storage: { mode: 'local' }, backup: { mode: 'off' } });

function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('INVALID', 'Unknown or invalid settings fields');
}
function ref(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:@/-]{1,160}$/.test(value)) fail('INVALID', 'Expected an opaque connection or destination reference, not credentials');
}
export function validateSettings(s) {
  keys(s, ['schemaVersion', 'storage', 'backup', 'indexing']);
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
  if (s.indexing !== undefined) {
    keys(s.indexing, ['mode']);
    if (!['keyword', 'semantic'].includes(s.indexing.mode)) fail('INVALID', 'Indexing mode must be keyword or semantic');
  }
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
export async function readRange(file, { offset, length, expected }) {
  if (!/^(0|[1-9][0-9]*)$/.test(offset ?? '') || !/^[1-9][0-9]*$/.test(length ?? '') ||
      !Number.isSafeInteger(Number(offset)) || !Number.isSafeInteger(Number(length)) ||
      Number(length) > MAX_READ_BYTES || !/^[a-f0-9]{64}$/.test(expected ?? '')) {
    fail('INVALID', 'Ranges require --offset BYTE, --length 1..524288 and --expected SHA256');
  }
  offset = Number(offset); length = Number(length);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) fail('UNSAFE_PATH', 'Expected a regular file');
    const sha = createHash('sha256'), chunks = []; let bytes = 0;
    // Hash and collect from one descriptor/pass: an atomic replacement cannot
    // make the returned range belong to a different source revision.
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      sha.update(chunk);
      const start = Math.max(0, offset - bytes), end = Math.min(chunk.length, offset + length - bytes);
      if (end > start) chunks.push(chunk.subarray(start, end));
      bytes += chunk.length;
    }
    const sha256 = sha.digest('hex');
    if (sha256 !== expected) fail('CONFLICT', 'File changed; re-read metadata before requesting ranges');
    if (offset > bytes) fail('INVALID', 'Offset exceeds file size');
    const data = Buffer.concat(chunks), nextOffset = offset + data.length;
    return { bytes, sha256, offset, length: data.length, chunkSha256: hash(data), encoding: 'base64',
      content: data.toString('base64'), nextOffset, eof: nextOffset === bytes };
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
export async function put(root, relative, input, { key, expected, kind = 'file', maxBytes = MAX_FILE_BYTES, source } = {}) {
  if (expected !== 'new' && !/^[a-f0-9]{64}$/.test(expected || '')) fail('INVALID', 'Supply --expected new or the current SHA-256');
  if (!['file', 'settings'].includes(kind)) fail('INVALID', 'Unknown write kind');
  return locked(root, async root => {
    const receiptFile = operationPath(root, key);
    await safePath(root, path.relative(root, receiptFile));
    if (kind === 'file' && (typeof relative !== 'string' || !relative)) fail('INVALID', 'Supply a relative file path');
    const target = await safePath(root, kind === 'settings' ? 'settings.json' : 'files/' + relative, true);
    // files may be a separate bind mount: stage on the destination filesystem.
    const temp = path.join(path.dirname(target), '.ez-library-put-' + randomUUID() + '.tmp');
    let bytes = 0; const sha = createHash('sha256');
    try {
      await pipeline(input, new Transform({ transform(chunk, encoding, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) return cb(new LibraryError('TOO_LARGE', `Input exceeds ${maxBytes} bytes`));
        sha.update(chunk); cb(null, chunk);
      } }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      const request = { kind, path: kind === 'settings' ? 'settings.json' : relative, bytes, sha256: sha.digest('hex'), expected,
        ...(source ? { source } : {}) };
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
  if (receipt.kind === 'replace') return replacementView(root, receipt);
  if (['move', 'remove'].includes(receipt.kind)) {
    const source = await current(await safePath(root, 'files/' + receipt.path));
    const target = receipt.to ? await current(await safePath(root, 'files/' + receipt.to)) : null;
    return { ...receipt, state: source ? 'source-present' : receipt.kind === 'remove' ? 'removed' : target?.sha256 === receipt.expected ? 'moved' : 'changed' };
  }
  if (!['file', 'settings'].includes(receipt.kind)) fail('INVALID', 'Invalid operation receipt');
  const file = await safePath(root, receipt.kind === 'settings' ? 'settings.json' : 'files/' + receipt.path);
  const now = await current(file);
  return { ...receipt, state: !now ? 'missing' : now.sha256 === receipt.sha256 ? 'stored' : 'changed' };
}

const uniquePosition = (text, part) => {
  const at = text.indexOf(part);
  return at >= 0 && text.indexOf(part, at + 1) < 0 ? at : -1;
};
function validateReplacement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['before', 'after'].includes(key)) ||
      typeof value.before !== 'string' || !value.before || typeof value.after !== 'string' ||
      !value.after || value.before === value.after ||
      Buffer.byteLength(JSON.stringify(value)) > MAX_REPLACE_BYTES) {
    fail('INVALID', 'Supply distinct nonempty before/after strings in at most 256 KiB of JSON');
  }
  for (const text of [value.before, value.after]) {
    if (Buffer.from(text).toString('utf8') !== text) fail('INVALID', 'Replacement must be valid UTF-8 text');
  }
}
async function readText(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail('UNSAFE_PATH', 'Expected a regular text file');
    if (stat.size > MAX_TEXT_BYTES) fail('TOO_LARGE', 'Text replacement is limited to 8 MiB files');
    const chunks = []; let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > MAX_TEXT_BYTES) fail('TOO_LARGE', 'Text replacement is limited to 8 MiB files');
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks), text = data.toString('utf8');
    if (!Buffer.from(text).equals(data)) fail('INVALID', 'Text replacement requires valid UTF-8');
    return { text, bytes, sha256: hash(data) };
  } finally { await handle.close(); }
}
async function replacementView(root, receipt) {
  validateReplacement({ before: receipt.before, after: receipt.after });
  const file = await safePath(root, 'files/' + receipt.path);
  const now = await readText(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return { kind: 'replace', path: receipt.path, beforeSha256: hash(receipt.before), afterSha256: hash(receipt.after),
    state: !now ? 'missing' : uniquePosition(now.text, receipt.after) >= 0 ? 'stored' : 'changed',
    ...(now ? { bytes: now.bytes, sha256: now.sha256 } : {}) };
}

// Exact literal replacement is a scoped compare-and-swap, not a Markdown merge.
// The caller supplies its complete unique block. Unrelated bytes are read under
// the existing writer lock and retained, including other callers' recent edits.
export async function replaceText(root, relative, replacement, { key } = {}) {
  validateReplacement(replacement);
  if (!relative || relative === 'LIBRARY_SYNC_ACCESS') fail('INVALID', 'Supply a non-reserved file path');
  return locked(root, async root => {
    const target = await safePath(root, 'files/' + relative);
    const receiptFile = await safePath(root, path.relative(root, operationPath(root, key)));
    const request = { kind: 'replace', path: relative, before: replacement.before, after: replacement.after };
    const old = await fs.readFile(receiptFile, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (old && JSON.stringify(old) !== JSON.stringify(request)) fail('KEY_REUSED', 'Operation key belongs to a different replacement');
    if (old) {
      const observed = await replacementView(root, old);
      if (observed.state === 'stored') return { ...observed, replay: true };
    }
    const before = await readText(target);
    const at = uniquePosition(before.text, replacement.before);
    if (at < 0) fail('CONFLICT', 'Expected text is absent or ambiguous; re-read the owning block');
    const next = before.text.slice(0, at) + replacement.after + before.text.slice(at + replacement.before.length);
    if (Buffer.byteLength(next) > MAX_TEXT_BYTES) fail('TOO_LARGE', 'Replacement exceeds the 8 MiB text limit');
    if (uniquePosition(next, replacement.after) < 0) fail('CONFLICT', 'Resulting text is ambiguous; use a larger unique block');
    const history = await safePath(root, 'history/' + before.sha256);
    await fs.copyFile(target, history, constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await fs.chmod(history, 0o600);
    await atomic(receiptFile, jsonBytes(request));
    await atomic(target, next);
    const after = await replacementView(root, request);
    if (after.state !== 'stored' || after.sha256 !== hash(next)) fail('UNCERTAIN', 'Replacement readback differs; inspect operation before retry');
    return { ...after, replay: false };
  });
}

export async function organize(root, { path: relative, to, expected, key }) {
  if (!/^[a-f0-9]{64}$/.test(expected || '')) fail('INVALID', 'Supply the current source SHA-256');
  if (relative === 'LIBRARY_SYNC_ACCESS' || to === 'LIBRARY_SYNC_ACCESS') fail('INVALID', 'The sync access marker is reserved');
  return locked(root, async root => {
    const source = await safePath(root, 'files/' + relative);
    const target = to === undefined ? null : await safePath(root, 'files/' + to, true);
    if (target === source) fail('INVALID', 'Source and destination must differ');
    const receipt = { kind: target ? 'move' : 'remove', path: relative, ...(target ? { to } : {}), expected };
    const file = await safePath(root, path.relative(root, operationPath(root, key)));
    const old = await fs.readFile(file, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (old && JSON.stringify(old) !== JSON.stringify(receipt)) fail('KEY_REUSED', 'Operation key belongs to a different request');
    if (old) {
      const observed = await operation(root, key);
      if (['moved', 'removed'].includes(observed.state)) return { ...observed, replay: true };
    }
    const before = await current(source);
    if (before?.sha256 !== expected || (target && await current(target))) fail('CONFLICT', 'Source changed or destination exists; read both paths before organizing');
    const history = await safePath(root, 'history/' + expected);
    await fs.copyFile(source, history, constants.COPYFILE_EXCL).catch(e => { if (e.code !== 'EEXIST') throw e; });
    await fs.chmod(history, 0o600);
    await atomic(file, jsonBytes(receipt));
    if (target) await fs.rename(source, target); else await fs.unlink(source);
    return { ...await operation(root, key), replay: false };
  });
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
