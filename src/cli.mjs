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
import { rclone } from './native.mjs';
import { gitKey, gitAdopt, git } from './git-sync.mjs';

const version = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url))).version;
const emit = data => process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
const help = `ez-library ${version}
Local library files, QMD retrieval, and persistence settings.

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
  return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: path.join(root, 'qmd'),
    XDG_CONFIG_HOME: path.join(root, 'qmd', 'config'), XDG_CACHE_HOME: path.join(root, 'qmd', 'cache'),
    QMD_CONFIG_DIR: path.join(root, 'qmd', 'config', 'qmd'), LANG: 'C.UTF-8' };
}
async function runQmd(root, args) {
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
    const [command, ...rest] = argv;
    const root = process.env.EZ_LIBRARY_STATE || '/state';
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
      'git-key': ['repository'], 'git-adopt': ['repository', 'branch'],
      'sync-policy': ['expected', 'mode', 'interval'] }[command];
    if (!allowed) fail('INVALID', 'Unknown command; use --help');
    const { values: opts } = parseArgs({ args: rest, options: Object.fromEntries([...allowed, 'json'].map(k => [k, { type: ['json', 'raw'].includes(k) ? 'boolean' : 'string' }])), strict: true });
    if (command === 'sync-plan') { emit(await syncPlan(root, opts.remote)); return; }
    if (command === 'git-key') { emit(await gitKey(root, opts.repository)); return; }
    if (command === 'git-adopt') { emit(await gitAdopt(root, opts.repository, opts.branch)); return; }
    if (command === 'sync-adopt') { emit(await syncAdopt(root, opts.remote)); return; }
    if (command === 'sync-status') { emit(await syncStatus(root)); return; }
    if (command === 'sync-run') { emit(await syncRun(root)); return; }
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
        folderSync: await syncStatus(root),
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
