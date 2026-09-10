import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants } from 'node:fs';
import { fail, rootDir, locked, settings, validateSettings, put, operation, organize, list, safePath, digest, jsonBytes, defaults } from './store.mjs';
import { syncPlan, syncAdopt, syncPolicy, syncRun, syncStatus } from './sync.mjs';
import { rclone, environment } from './native.mjs';
import { indexStatus } from './indexer.mjs';
import { embeddingStatus } from './embedding-client.mjs';
import { addLibrary, selectLibrary, sources, searchLibraries } from './libraries.mjs';
import { mirrorAdopt, mirrorStatus, mirrorPolicy } from './git-mirror.mjs';
import { gitKey, gitAdopt, git } from './git-sync.mjs';

const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url))).version;
const emit = data => process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
const help = `ez-library ${version}
Local library files, QMD retrieval, and persistence settings.

  sources                         List names, purposes, destinations and sync status
  source-add --name NAME --description TEXT  Add an isolated local library
  search QUERY [--library NAME | --all] [--limit 5]  QMD keyword results by library
  COMMAND --library NAME ...       Select a library (required when more than one)
  qmd|git|rclone --library NAME ... Selector must precede native arguments
  doctor                          Read-only local readiness; no remote proof
  settings                        Show settings and revision hash
  configure --expected HASH|new --key KEY < settings.json
  put --path RELATIVE --expected HASH|new --key KEY < file
  get --path RELATIVE [--raw]      Metadata/hash, or exact binary stdout
  pdf-text --path RELATIVE         Poppler text to stdout, page breaks retained
  list [--prefix TEXT] [--limit 100]
  operation --key KEY             Recover write outcome from current bytes
  move --path SOURCE --to DEST --expected HASH --key KEY
  remove --path SOURCE --expected HASH --key KEY  Retain recoverable original
  qmd ...                        Native QMD CLI with private index/cache
  rclone ...                     Native connection CLI; private config in /state/sync
  sync-plan --remote REMOTE:PATH  Inspect an existing folder without changing it
  sync-adopt --remote REMOTE:PATH Import matching originals; enable two-way sync
  sync-status                    Binding, last sync, extraction and embedding status
  sync-run                       Reconcile now and refresh the index
  sync-policy --expected HASH --mode paused|two-way [--interval 60]
  git-mirror-adopt --repository OWNER/REPO [--branch main] [--extensions .md,.txt] [--exclude-directories private,archive]
  git-mirror-status              Text-only GitHub history destination and revision
  git-mirror-policy --expected HASH --mode paused|one-way
  git-key --repository OWNER/REPO  Create a repository key; return public key only
  git-adopt --repository OWNER/REPO [--branch main] Import and enable native Git sync
  git ...                        Native Git in the bound Library working tree

Local commands emit JSON (--json is also accepted); get --raw and qmd preserve
native output. Files are limited to 512 MiB. Existing files require their current
SHA-256. Stable operation keys cannot be reused for different writes.
State: EZ_LIBRARY_STATE (absolute), default /state. Production uses the agent's
registered Docker plugin. Credentials belong to provider tools, never settings.
Legacy persistence settings alone do not start sync. sync-adopt enables native
bisync, checked every 60 seconds plus transfer/index time while the service runs.
Exit: 0 success, 2 invalid input, 3 conflict/busy, 4 unavailable/uncertain.
QMD returns its native exit code. See the packaged library skill for onboarding.
`;

export function qmdEnvironment(root) {
  return environment(root);
}
async function runQmd(root, args) {
  if (args.includes('pull')) fail('INVALID', 'Library does not download per-agent models; enable shared embeddings through Ez');
  const cli = fileURLToPath(new URL('./cli/qmd.js', import.meta.resolve('@tobilu/qmd')));
  return locked(root, root => runNative(root, process.execPath, [cli, ...args]));
}
async function runNative(root, executable, args, stdio = 'inherit') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: path.join(root, 'files'), env: qmdEnvironment(root), stdio });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    const cleanup = () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal ? 130 : 4)); });
  });
}
async function readSettingsInput() {
  const parts = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length; if (bytes > 65536) fail('TOO_LARGE', 'Settings exceed 64 KiB');
    parts.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { fail('INVALID', 'Settings must be valid JSON'); }
  return validateSettings(parsed);
}
export async function main(argv = process.argv.slice(2)) {
  try {
    if (!argv.length || argv[0] === '--help' || argv[0] === 'help') { process.stdout.write(help); return; }
    if (argv[0] === '--version') { process.stdout.write(version + '\n'); return; }
    const [command, ...args] = argv;
    const base = process.env.EZ_LIBRARY_STATE || '/state';
    if (command === 'sources') {
      parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true });
      emit(await sources(base)); return;
    }
    if (command === 'source-add') {
      const { values } = parseArgs({ args, options: { name: { type: 'string' }, description: { type: 'string' } }, strict: true });
      emit(await addLibrary(base, values.name, values.description)); return;
    }
    // Native argv is otherwise untouched; never consume a provider's own flags.
    let name;
    const rest = [...args];
    if (['qmd', 'git', 'rclone'].includes(command)) {
      if (rest[0] === '--library') { rest.shift(); name = rest.shift(); if (!name) fail('INVALID', 'Supply --library NAME'); }
      else if (rest[0]?.startsWith('--library=')) name = rest.shift().slice(10);
    } else {
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--') break;
        if (rest[i] === '--library' || rest[i].startsWith('--library=')) {
          if (name !== undefined) fail('INVALID', 'Supply --library only once');
          const token = rest.splice(i, 1)[0];
          name = token === '--library' ? rest.splice(i, 1)[0] : token.slice(10);
          if (!name || name.startsWith('--')) fail('INVALID', 'Supply --library NAME');
          i--;
        }
      }
    }
    if (name === '') fail('INVALID', 'Supply --library NAME');
    if (command === 'search') {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { all: { type: 'boolean' }, limit: { type: 'string' }, json: { type: 'boolean' } }, strict: true });
      if (positionals.length !== 1) fail('INVALID', 'Supply one quoted search query');
      const result = await searchLibraries(base, { name, all: values.all, query: positionals[0], limit: values.limit === undefined ? 5 : Number(values.limit) });
      process.stdout.write(JSON.stringify({ ok: result.complete, data: result }) + '\n');
      if (!result.complete) process.exitCode = 4;
      return;
    }
    const { root } = await selectLibrary(base, name);
    if (command === 'qmd') { process.exitCode = await runQmd(root, rest); return; }
    if (command === 'git') {
      process.exitCode = await locked(root, async root => {
        const { config } = await syncStatus(root);
        if (config?.backend !== 'git') fail('INVALID', 'No Git library is bound');
        return (await git(root, config, rest, { inherit: true })).code;
      }); return;
    }
    if (command === 'rclone') {
      process.exitCode = await locked(root, async root => {
        await fs.mkdir(path.join(root, 'sync'), { recursive: true, mode: 0o700 });
        return (await rclone(root, rest, { inherit: true })).code;
      }); return;
    }
    const allowed = { doctor: [], settings: [], configure: ['expected', 'key'], put: ['path', 'expected', 'key'],
      get: ['path', 'raw'], 'pdf-text': ['path'], list: ['prefix', 'limit'], operation: ['key'],
      'sync-plan': ['remote'], 'sync-adopt': ['remote'], 'sync-status': [], 'sync-run': [],
      move: ['path', 'to', 'expected', 'key'], remove: ['path', 'expected', 'key'],
      'git-mirror-adopt': ['repository', 'branch', 'extensions', 'exclude-directories'], 'git-mirror-status': [], 'git-mirror-policy': ['expected', 'mode'],
      'git-key': ['repository'], 'git-adopt': ['repository', 'branch'],
      'sync-policy': ['expected', 'mode', 'interval'] }[command];
    if (!allowed) fail('INVALID', 'Unknown command; use --help');
    const { values: opts } = parseArgs({ args: rest, options: Object.fromEntries([...allowed, 'json'].map(k => [k, { type: ['json', 'raw'].includes(k) ? 'boolean' : 'string' }])), strict: true });
    if (command === 'sync-plan') { emit(await syncPlan(root, opts.remote, base)); return; }
    if (command === 'git-mirror-adopt') { emit(await mirrorAdopt(root, opts.repository, opts.branch, opts.extensions, base, opts['exclude-directories'])); return; }
    if (command === 'git-mirror-status') { emit(await mirrorStatus(root)); return; }
    if (command === 'git-mirror-policy') { emit(await mirrorPolicy(root, opts.expected, opts.mode)); return; }
    if (command === 'git-key') { emit(await gitKey(root, opts.repository)); return; }
    if (command === 'git-adopt') { emit(await gitAdopt(root, opts.repository, opts.branch)); return; }
    if (command === 'sync-adopt') { emit(await syncAdopt(root, opts.remote, base)); return; }
    if (command === 'sync-status') { emit(await syncStatus(root)); return; }
    if (command === 'sync-run') { emit(await syncRun(root, base)); return; }
    if (command === 'sync-policy') { emit(await syncPolicy(root, { expected: opts.expected, mode: opts.mode, intervalSeconds: opts.interval === undefined ? 60 : Number(opts.interval) })); return; }
    if (['move', 'remove'].includes(command)) {
      if (!opts.path || (command === 'move' && !opts.to)) fail('INVALID', 'Supply source and, for move, destination paths');
      emit(await organize(root, opts)); return;
    }
    if (command === 'configure') {
      const data = jsonBytes(await readSettingsInput());
      emit(await put(root, 'settings.json', Readable.from([data]), { key: opts.key, expected: opts.expected, kind: 'settings', maxBytes: 65536 })); return;
    }
    if (command === 'put') {
      if (!opts.path) fail('INVALID', 'Supply --path');
      emit(await put(root, opts.path, process.stdin, { key: opts.key, expected: opts.expected })); return;
    }
    if (command === 'doctor') {
      let configured = false; let value = { settings: defaults(), sha256: null };
      try { await rootDir(root); value = await settings(root); configured = value.sha256 !== null; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let qmdAvailable = true;
      try { import.meta.resolve('@tobilu/qmd'); } catch { qmdAvailable = false; }
      emit({ version, state: root, configured, qmdAvailable, storageMode: value.settings.storage.mode,
        folderSync: await syncStatus(root), embeddings: { service: await embeddingStatus(), index: await indexStatus(root) },
        cloudPersistence: value.settings.storage.mode === 'local' ? 'disabled' : 'configured-not-verified',
        backup: value.settings.backup.mode === 'off' ? 'disabled' : 'configured-not-verified' }); return;
    }
    if (command === 'settings') {
      try { await rootDir(root); emit(await settings(root)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; emit({ settings: defaults(), sha256: null }); }
      return;
    }
    await rootDir(root);
    if (command === 'operation') { emit(await operation(root, opts.key)); return; }
    if (command === 'list') { emit(await list(root, opts.prefix, opts.limit === undefined ? 100 : Number(opts.limit))); return; }
    if (command === 'pdf-text') {
      if (!opts.path) fail('INVALID', 'Supply --path');
      const file = await safePath(root, 'files/' + opts.path);
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile()) fail('UNSAFE_PATH', 'Expected a regular file');
        process.exitCode = await runNative(root, '/usr/bin/pdftotext',
          ['-layout', '-enc', 'UTF-8', '/proc/self/fd/3', '-'], ['ignore', 'inherit', 'inherit', handle.fd]);
      } finally { await handle.close(); }
      return;
    }
    if (command === 'get') {
      if (!opts.path) fail('INVALID', 'Supply --path');
      const file = await safePath(root, 'files/' + opts.path);
      if (opts.raw) {
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!(await handle.stat()).isFile()) fail('UNSAFE_PATH', 'Expected a regular file');
          await pipeline(handle.createReadStream({ autoClose: false }), process.stdout);
        } finally { await handle.close(); }
      } else emit({ path: opts.path, ...await digest(file) });
    }
  } catch (error) {
    const code = error.code || (error instanceof SyntaxError ? 'INVALID' : 'UNAVAILABLE');
    const invalid = ['INVALID', 'UNSAFE_PATH', 'TOO_LARGE', 'KEY_REUSED'].includes(code) || code.startsWith('ERR_PARSE_ARGS');
    process.exitCode = invalid ? 2 : ['CONFLICT', 'BUSY'].includes(code) ? 3 : 4;
    process.stderr.write(JSON.stringify({ ok: false, error: { code, message: error.message } }) + '\n');
  }
}
