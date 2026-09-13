import * as fs from 'node:fs/promises';
import path from 'node:path';
import { atomic, digest, hash, jsonBytes, safePath, settings } from './store.mjs';
import { native, qmd, succeeded } from './native.mjs';

export async function inventory(directory, relative = '', { includeHidden = false } = {}) {
  const result = [];
  for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!includeHidden && item.name.startsWith('.')) continue;
    const name = relative + item.name, file = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...await inventory(file, name + '/', { includeHidden }));
    else if (item.isFile()) result.push({ path: name, ...(await digest(file)) });
    else throw Error('Unsupported symlink or special file in Library');
  }
  return result;
}

// Native Git selects tracked and eligible untracked paths. Never traverse
// ignored caches, dependency trees or symlinks while reading a host checkout.
export async function gitInventory(root) {
  const workTree = path.join(root, 'files');
  const result = await native(root, '/usr/bin/git', ['-C', workTree, '--git-dir=' + path.join(workTree, '.git'), '--work-tree=' + workTree,
    '-c', 'safe.directory=' + workTree, '-c', 'core.hooksPath=/dev/null', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  const files = [];
  for (const name of new Set(succeeded(result, 'List eligible checkout files').split('\0').filter(Boolean))) {
    const parts = name.split('/');
    if (/[\x00-\x1f\x7f\\]/.test(name) || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw Error('Unsafe Git path');
    let file = workTree, absent = false;
    for (let i = 0; i < parts.length; i++) {
      file = path.join(file, parts[i]);
      const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat) { absent = true; break; }
      if (stat.isSymbolicLink() || !(i === parts.length - 1 ? stat.isFile() : stat.isDirectory())) throw Error('Unsupported symlink or special file in Library');
    }
    if (!absent) files.push({ path: name, ...(await digest(file)) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// Derived text is a rebuildable cache, outside the mirrored originals. Never
// overwrite an owner's note to regenerate PDF extraction.
export async function refreshIndex(root) {
  const configured = await settings(root);
  const embed = process.env.EZ_LIBRARY_EMBED !== '0' && configured.settings.indexing?.mode !== 'keyword';
  const cache = path.join(root, 'index-text');
  await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(cache)).isSymbolicLink()) throw Error('Extraction cache cannot be a symlink');
  const binding = await fs.readFile(path.join(root, 'sync/config.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const files = binding?.backend === 'git' && binding.existingCheckout ? (await gitInventory(root)).filter(file => !file.path.split('/').some(part => part.startsWith('.'))) : await inventory(path.join(root, 'files'));
  const fingerprint = hash(jsonBytes(files));
  await fs.mkdir(path.join(root, 'sync'), { recursive: true, mode: 0o700 });
  const ledgerFile = path.join(root, 'sync/index.json');
  const before = await fs.readFile(ledgerFile, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
  const semantic = embed && Boolean(process.env.EZ_LIBRARY_EMBED_SOCKET);
  if (before.fingerprint === fingerprint) {
    if (semantic && before.embedded) return before;
    if (!semantic) {
      if (!before.embedded && before.embeddingState === 'off') return before;
      const indexed = { ...before, embedded: false, embeddingState: 'off' };
      await atomic(ledgerFile, jsonBytes(indexed));
      return indexed;
    }
  }
  const extracted = {}, pending = [];
  for (const file of files.filter(f => /\.pdf$/i.test(f.path))) {
    const target = await safePath(root, 'index-text/' + file.path + '.md', true);
    if (before.extracted?.[file.path] !== file.sha256) {
      const source = await safePath(root, 'files/' + file.path);
      const result = await native(root, '/usr/bin/pdftotext', ['-layout', '-enc', 'UTF-8', source, '-']);
      if (result.code !== 0 || !result.stdout.trim()) {
        pending.push({ path: file.path, reason: result.code ? 'pdf-extraction-failed' : 'ocr-required' });
        await fs.rm(target, { force: true }); continue;
      }
      const pages = result.stdout.split('\f').map((text, i) => `## Page ${i + 1}\n\n${text.trim()}\n`).join('\n');
      await atomic(target, `# ${file.path}\n\nOriginal Library path: ${JSON.stringify(file.path)}\nSHA-256: ${file.sha256}\n\n${pages}`);
    }
    extracted[file.path] = file.sha256;
  }
  for (const old of Object.keys(before.extracted || {})) {
    if (!extracted[old]) await fs.rm(await safePath(root, 'index-text/' + old + '.md'), { force: true });
  }
  const listed = succeeded(await qmd(root, ['collection', 'list']), 'QMD collection list');
  for (const [name, dir, mask] of [['library', 'files', '**/*.{md,txt}'], ['library-pdf', 'index-text', '**/*.md']]) {
    if (!listed.includes(`qmd://${name}/`)) succeeded(await qmd(root, ['collection', 'add', path.join(root, dir), '--name', name, '--mask', mask]), 'QMD collection add');
  }
  succeeded(await qmd(root, ['update']), 'QMD update');
  const conflicts = files.filter(f => /\.conflict-(local|remote)/.test(f.path)).map(f => f.path);
  const indexed = { fingerprint, extracted, pending, conflicts, indexedAt: new Date().toISOString(), embedded: false, embeddingState: semantic ? 'indexing' : 'off' };
  await atomic(ledgerFile, jsonBytes(indexed));
  if (!semantic) return indexed;
  try { succeeded(await qmd(root, ['embed', '--no-gpu', '--max-docs-per-batch', '8']), 'QMD embed'); }
  catch (error) { indexed.embeddingState = 'unavailable'; await atomic(ledgerFile, jsonBytes(indexed)); throw error; }
  indexed.embedded = true;
  indexed.embeddingState = 'ready';
  await atomic(ledgerFile, jsonBytes(indexed));
  return indexed;
}

export async function indexStatus(root) {
  const before = await fs.readFile(path.join(root, 'sync/index.json'), 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const configured = await settings(root);
  if (process.env.EZ_LIBRARY_EMBED === '0' || !process.env.EZ_LIBRARY_EMBED_SOCKET || configured.settings.indexing?.mode === 'keyword') return { state: 'off', indexedAt: before?.indexedAt || null };
  if (!before) return { state: 'pending', indexedAt: null };
  const fingerprint = hash(jsonBytes(await inventory(path.join(root, 'files'))));
  return { state: fingerprint === before.fingerprint ? before.embeddingState : 'pending', indexedAt: before.indexedAt };
}
