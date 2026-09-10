import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { put, operation, settings, defaults, validateSettings, list, digest, hash } from '../src/store.mjs';
import { qmdEnvironment } from '../src/cli.mjs';

const cli = new URL('../bin/ez-library.mjs', import.meta.url).pathname;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ez-library-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
const input = value => Readable.from([Buffer.from(value)]);
const save = (root, value, options = {}) => put(root, 'notes/test.md', input(value), { key: 'test:1', expected: 'new', ...options });
const code = expected => error => error.code === expected;

test('intake preserves binary bytes, private modes, literal paths and replay across process state', async t => {
  const root = await fixture(t); const data = Buffer.from([0, 255, 10, 34, 128]);
  const relative = 'media/literal $(no-execution) file.pdf';
  const r = await put(root, relative, input(data), { key: 'binary:1', expected: 'new' });
  assert.equal(r.state, 'stored'); assert.equal(r.sha256, hash(data));
  assert.deepEqual(await fs.readFile(path.join(root, 'files', relative)), data);
  assert.equal((await fs.stat(path.join(root, 'files', relative))).mode & 0o777, 0o600);
  assert.equal((await put(root, relative, input(data), { key: 'binary:1', expected: 'new' })).replay, true);
  const read = spawnSync(process.execPath, [cli, 'get', '--path', relative, '--raw'], { env: { ...process.env, EZ_LIBRARY_STATE: root } });
  assert.equal(read.status, 0); assert.deepEqual(read.stdout, data);
});

test('replacement requires current revision; preserves history; stale replay never overwrites new content', async t => {
  const root = await fixture(t); const first = await save(root, 'original');
  await assert.rejects(save(root, 'bad', { key: 'second' }), code('CONFLICT'));
  const second = await save(root, 'revised', { key: 'second', expected: first.sha256 });
  assert.equal(await fs.readFile(path.join(root, 'history', first.sha256), 'utf8'), 'original');
  await assert.rejects(save(root, 'original'), code('CONFLICT'));
  assert.equal((await operation(root, 'test:1')).state, 'changed');
  assert.equal((await operation(root, 'second')).state, 'stored');
  assert.equal((await digest(path.join(root, 'files/notes/test.md'))).sha256, second.sha256);
});

test('operation keys bind content, target and revision', async t => {
  const root = await fixture(t); await save(root, 'first');
  await assert.rejects(save(root, 'different'), code('KEY_REUSED'));
  await assert.rejects(put(root, 'other.md', input('first'), { key: 'test:1', expected: 'new' }), code('KEY_REUSED'));
});

test('receipt can reconcile a missing installation and recover with matching input', async t => {
  const root = await fixture(t); await save(root, 'bytes');
  await fs.unlink(path.join(root, 'files/notes/test.md'));
  assert.equal((await operation(root, 'test:1')).state, 'missing');
  assert.equal((await save(root, 'bytes')).state, 'stored');
});

test('bounds and interrupted input leave no partial target or active lock', async t => {
  const root = await fixture(t);
  await assert.rejects(save(root, 'too big', { maxBytes: 2 }), code('TOO_LARGE'));
  const broken = Readable.from((async function* () { yield 'part'; throw Error('interrupted'); })());
  await assert.rejects(put(root, 'partial.md', broken, { key: 'broken', expected: 'new' }), /interrupted/);
  assert.deepEqual(await fs.readdir(path.join(root, 'tmp')), []);
  await assert.rejects(fs.stat(path.join(root, 'files/partial.md')), code('ENOENT'));
  await assert.rejects(fs.stat(path.join(root, '.writer-lock')), code('ENOENT'));
});

test('traversal, hidden files and symlink ancestors are rejected', async t => {
  const root = await fixture(t); await save(root, 'safe');
  for (const rel of ['../escape', '/etc/file', '.env', 'a/../b', 'a\\b', 'a//b']) {
    await assert.rejects(put(root, rel, input('x'), { key: 'path', expected: 'new' }), code('UNSAFE_PATH'));
  }
  const outside = await fixture(t);
  await fs.symlink(outside, path.join(root, 'files/link'));
  await assert.rejects(put(root, 'link/escape', input('x'), { key: 'link', expected: 'new' }), code('UNSAFE_PATH'));
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(list(root), code('UNSAFE_PATH'));
});

test('symlinked operation/history records do not follow outside targets', async t => {
  const root = await fixture(t); const first = await save(root, 'original');
  const outside = path.join(await fixture(t), 'outside'); await fs.writeFile(outside, 'untouched', { mode: 0o644 });
  await fs.symlink(outside, path.join(root, 'history', first.sha256));
  await assert.rejects(save(root, 'replacement', { key: 'next', expected: first.sha256 }), code('UNSAFE_PATH'));
  assert.equal((await fs.stat(outside)).mode & 0o777, 0o644);
  const record = path.join(root, 'operations', hash('test:1') + '.json');
  await fs.unlink(record); await fs.symlink(outside, record);
  await assert.rejects(operation(root, 'test:1'), code('UNSAFE_PATH'));
  assert.equal(await fs.readFile(outside, 'utf8'), 'untouched');
});

test('writer lock is fail-closed, including stale-looking locks', async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root, '.writer-lock'));
  await assert.rejects(save(root, 'blocked'), code('BUSY'));
  assert((await fs.stat(path.join(root, '.writer-lock'))).isDirectory());
});

test('list honors prefix and a bounded result size', async t => {
  const root = await fixture(t); await save(root, 'a');
  await put(root, 'notes/second.md', input('b'), { key: 'b', expected: 'new' });
  assert.equal((await list(root, 'notes/', 1)).truncated, true);
  assert.equal((await list(root, 'other/', 1)).files.length, 0);
  await assert.rejects(list(root, '', 1001), code('INVALID'));
});

test('all persistence modes are explicit policy; invalid destinations and credentials fail', () => {
  const github = { connection: 'github-personal', repository: 'example/library', branch: 'main' };
  const drive = { connection: 'drive-personal', folderId: 'folder-123' };
  for (const storage of [{ mode: 'local' }, { mode: 'github', github }, { mode: 'drive', drive },
    { mode: 'hybrid', github, drive, githubExtensions: ['.md', '.pdf'], maxGithubBytes: 10485760 }]) {
    assert.equal(validateSettings({ schemaVersion: 1, storage, backup: { mode: 'off' } }).storage.mode, storage.mode);
  }
  for (const storage of [{ mode: 'hybrid', github }, { mode: 'drive' }, { mode: 'local', token: 'secret' },
    { mode: 'hybrid', github, drive, githubExtensions: ['*'], maxGithubBytes: 1 },
    { mode: 'hybrid', github, drive, githubExtensions: ['.pdf'], maxGithubBytes: 104857600 }]) {
    assert.throws(() => validateSettings({ schemaVersion: 1, storage, backup: { mode: 'off' } }), code('INVALID'));
  }
});

test('indexing policy is explicit and legacy settings remain valid', () => {
  for (const mode of ['keyword', 'semantic']) {
    assert.equal(validateSettings({ ...defaults(), indexing: { mode } }).indexing.mode, mode);
  }
  for (const indexing of [{ mode: 'automatic' }, { mode: 'keyword', fallback: 'semantic' }, {}]) {
    assert.throws(() => validateSettings({ ...defaults(), indexing }), code('INVALID'));
  }
  assert.deepEqual(validateSettings(defaults()), defaults());
});

test('configuration survives restart and doctor never equates settings with cloud verification', async t => {
  const root = await fixture(t);
  const config = { ...defaults(), storage: { mode: 'drive', drive: { connection: 'account', folderId: 'folder' } } };
  const run = spawnSync(process.execPath, [cli, 'configure', '--expected', 'new', '--key', 'settings:1'], {
    env: { ...process.env, EZ_LIBRARY_STATE: root }, input: JSON.stringify(config), encoding: 'utf8'
  });
  assert.equal(run.status, 0, run.stderr); assert.deepEqual((await settings(root)).settings, config);
  const doctor = spawnSync(process.execPath, [cli, 'doctor'], { env: { ...process.env, EZ_LIBRARY_STATE: root }, encoding: 'utf8' });
  assert.equal(doctor.status, 0); assert.equal(JSON.parse(doctor.stdout).data.cloudPersistence, 'configured-not-verified');
});

test('help and doctor work without configuration; subprocess environment excludes secrets', async t => {
  const root = path.join(await fixture(t), 'absent');
  for (const args of [['--help'], ['doctor'], ['settings']]) {
    const run = spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, EZ_LIBRARY_STATE: root }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  }
  await assert.rejects(fs.stat(root), code('ENOENT'));
  process.env.TELEGRAM_BOT_TOKEN = 'synthetic-test-token';
  process.env.NODE_OPTIONS = '--trace-warnings';
  const env = qmdEnvironment('/state');
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined); assert.equal(env.NODE_OPTIONS, undefined);
  delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.NODE_OPTIONS;
});


test('PDF extraction rejects traversal, symlinks, directories and missing paths before launching Poppler', async t => {
  const root = await fixture(t); await save(root, 'safe');
  await fs.symlink('/etc/passwd', path.join(root, 'files/link.pdf'));
  for (const relative of ['../settings.json', 'link.pdf', 'notes']) {
    const result = spawnSync(process.execPath, [cli, 'pdf-text', '--path', relative], { env: { ...process.env, EZ_LIBRARY_STATE: root }, encoding: 'utf8' });
    assert.equal(result.status, 2); assert.match(result.stderr, /UNSAFE_PATH/); assert.equal(result.stdout, '');
  }
  const result = spawnSync(process.execPath, [cli, 'pdf-text'], { env: { ...process.env, EZ_LIBRARY_STATE: root }, encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /Supply --path/);
});
