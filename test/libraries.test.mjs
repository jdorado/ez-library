import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { addLibrary, catalog, selectLibrary, sources, searchLibraries } from '../src/libraries.mjs';
import { locked, put } from '../src/store.mjs';
import { gitAdopt, gitTransfer } from '../src/git-sync.mjs';
const cli = new URL('../bin/ez-library.mjs', import.meta.url);
async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'library-named-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return path.join(base, 'state');
}
const invoke = (root, args, input) => spawnSync(process.execPath, [cli.pathname, ...args], { env: { ...process.env, EZ_LIBRARY_STATE: root }, encoding: 'utf8', input });

test('legacy state stays in place; named files and operation receipts are isolated', async t => {
  const base = await setup(t);
  assert.equal((await selectLibrary(base)).root, base);
  assert.equal((await sources(base)).libraries.length, 1);
  const args = ['put', '--path', 'same.md', '--expected', 'new', '--key', 'same'];
  assert.equal(invoke(base, args, 'legacy').status, 0);
  const before = (await catalog(base)).revision;
  await addLibrary(base, 'work', 'Work documentation');
  assert.notEqual((await catalog(base)).revision, before);
  assert.equal((await addLibrary(base, 'work', 'Work documentation')).existing, true);
  assert.equal(invoke(base, args, 'ambiguous').status, 2);
  assert.equal(invoke(base, [...args, '--library', 'work'], 'work').status, 0);
  assert.equal(invoke(base, ['get', '--library', 'default', '--path', 'same.md', '--raw']).stdout, 'legacy');
  assert.equal(invoke(base, ['get', '--library=work', '--path', 'same.md', '--raw']).stdout, 'work');
  for (const name of ['default', 'work']) assert.equal(JSON.parse(invoke(base, ['operation', '--library', name, '--key', 'same']).stdout).data.state, 'stored');
  for (const args of [['qmd', 'search', 'x'], ['git', 'status'], ['rclone', 'listremotes'], ['get', '--path', 'same.md'], ['put', '--library', 'missing']]) assert.equal(invoke(base, args).status, 2);
  assert.equal((await sources(base)).selectionRequired, true);
});

test('invalid names, catalog corruption and intermediate symlinks fail closed', async t => {
  const base = await setup(t);
  for (const name of ['../escape', '/tmp/escape', 'a/b', '.hidden', 'default', 'UPPER']) await assert.rejects(addLibrary(base, name, 'Notes'));
  await addLibrary(base, 'work', 'Work');
  await assert.rejects(addLibrary(base, 'work', 'Different'), { code: 'CONFLICT' });
  await fs.rename(path.join(base, 'libraries'), path.join(base, 'saved'));
  await fs.symlink(path.join(base, 'saved'), path.join(base, 'libraries'));
  await assert.rejects(selectLibrary(base, 'work'), { code: 'UNSAFE_PATH' });
  await assert.rejects(addLibrary(base, 'extra', 'Extra'), { code: 'UNSAFE_PATH' });
  await fs.writeFile(path.join(base, 'libraries.json'), '{}');
  await assert.rejects(selectLibrary(base, 'default'), { code: 'INVALID' });
});

test('search preserves QMD matches and source names, reporting partial errors', async t => {
  const base = await setup(t);
  await addLibrary(base, 'work', 'Work');
  const query = 'literal $(echo no)';
  const response = await searchLibraries(base, { all: true, query }, async (root, args) => {
    assert.deepEqual(args, ['search', query, '--json', '-n', '5']);
    return { code: 0, stdout: JSON.stringify([{ file: 'qmd://library/same.md', score: 0.8 }]) };
  });
  assert.equal(response.complete, true);
  assert.deepEqual(response.libraries.map(x => x.results[0].library), ['default', 'work']);
  const partial = await searchLibraries(base, { all: true, query }, async root => {
    if (root !== base) throw Error('index unavailable');
    return { code: 0, stdout: '[]' };
  });
  assert.equal(partial.complete, false);
  assert.match(partial.libraries[1].error.message, /index unavailable/);
  await assert.rejects(searchLibraries(base, { query }));
  await assert.rejects(searchLibraries(base, { query, all: true, name: 'work' }));
});

test('two native Git repositories with identical paths transfer independently', async t => {
  const base = await setup(t);
  const git = args => execFileSync('/usr/bin/git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: path.dirname(base), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' } });
  await addLibrary(base, 'work', 'Work');
  for (const name of ['default', 'work']) {
    const remote = path.join(path.dirname(base), name + '.git');
    const checkout = path.join(path.dirname(base), name + '-checkout');
    git(['init', '--bare', '--initial-branch=main', remote]);
    git(['clone', remote, checkout]);
    await fs.writeFile(path.join(checkout, 'same.md'), name);
    git(['-C', checkout, 'add', '.']); git(['-C', checkout, 'commit', '-m', 'Seed']); git(['-C', checkout, 'push']);
    const { root } = await selectLibrary(base, name);
    const { config } = await gitAdopt(root, remote);
    await put(root, 'added.md', Readable.from([name]), { expected: 'new', key: 'same-key' });
    const result = await locked(root, () => gitTransfer(root, config));
    assert.equal(result.remoteVerified, true);
    assert.equal(git(['--git-dir', remote, 'show', 'main:added.md']), name);
    assert.equal(await fs.readFile(path.join(root, 'files/same.md'), 'utf8'), name);
  }
  assert.equal((await sources(base)).libraries.every(x => x.sync.config.backend === 'git'), true);
});

test('named folder sync rejects siblings and private state within the global volume', async t => {
  const base = await setup(t);
  await addLibrary(base, 'work', 'Work');
  await addLibrary(base, 'personal', 'Personal');
  await fs.mkdir(path.join(base, 'libraries/personal/sync'));
  for (const remote of [path.join(base, 'files'), path.join(base, 'libraries/personal/files'), path.join(base, 'libraries/personal/sync')]) {
    for (const command of ['sync-plan', 'sync-adopt']) {
      const result = invoke(base, [command, '--library', 'work', '--remote', remote]);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /outside Library state/);
    }
  }
  // A previously written binding cannot bypass the same boundary on a cycle.
  const { root } = await selectLibrary(base, 'work');
  await fs.writeFile(path.join(root, 'sync/config.json'), JSON.stringify({ schemaVersion: 1, remote: path.join(base, 'files'), identity: 'old', mode: 'two-way', intervalSeconds: 60 }));
  const result = invoke(base, ['sync-run', '--library', 'work']);
  assert.equal(result.status, 2, result.stderr);
});


test('resident supervisor attempts both bindings despite an individual failure', async t => {
  const base = await setup(t);
  await addLibrary(base, 'work', 'Work');
  for (const name of ['default', 'work']) {
    const { root } = await selectLibrary(base, name);
    await fs.mkdir(path.join(root, 'sync'), { recursive: true });
    await fs.writeFile(path.join(root, 'sync/config.json'), JSON.stringify({ schemaVersion: 1, remote: path.join(base, 'files'), identity: 'old', mode: 'two-way', intervalSeconds: 60 }));
  }
  const child = spawn(process.execPath, [new URL('../src/sync-worker.mjs', import.meta.url).pathname], { env: { ...process.env, EZ_LIBRARY_STATE: base }, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { child.kill('SIGTERM'); await closed; });
  await new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => reject(Error('Supervisor did not visit both libraries: ' + stderr)), 5000);
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.includes('"library":"default"') && stderr.includes('"library":"work"')) { clearTimeout(timeout); resolve(); }
    });
  });
});
