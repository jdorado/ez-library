import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { put, organize, operation, hash } from '../src/store.mjs';
import { syncAdopt, syncPlan, syncRun, syncStatus, syncPolicy } from '../src/sync.mjs';
import { environment } from '../src/native.mjs';

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'library-sync-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'state'), remote = path.join(base, 'external');
  await fs.mkdir(remote); return { base, root, remote };
}
const save = (root, name, text) => put(root, name, Readable.from([text]), { key: hash(name), expected: 'new' });
const nativeAvailable = existsSync('/usr/local/bin/rclone');

test('provider folder identity resolves real parent entries and rejects missing or ambiguous ancestors', async t => {
  const { root } = await fixture(t);
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';
    const native = await import('./src/native.mjs');
    let mode = 'valid';
    const visited = [];
    mock.module('./src/native.mjs', { namedExports: { ...native, rclone: async (_, args) => {
      if (args[0] === 'config') return { code: 0, stdout: JSON.stringify({ cloud: { type: 'drive' } }) };
      if (args.includes('--recursive')) return { code: 0, stdout: '[]' };
      assert(args.includes('--dirs-only'));
      visited.push(args[1]);
      const ancestor = args[1] === 'cloud:';
      const entry = { IsDir: true, Path: ancestor ? 'personal' : 'notes', ID: ancestor ? 'parent-id' : 'vault-id' };
      let entries = [entry];
      if (mode === 'missing' && !ancestor) entries = [];
      if (mode === 'duplicate' && ancestor) entries.push({ ...entry, ID: 'other-parent' });
      if (mode === 'no-id' && !ancestor) delete entry.ID;
      return { code: 0, stdout: JSON.stringify(entries) };
    } } });
    const { syncPlan } = await import('./src/sync.mjs');
    assert.equal((await syncPlan(${JSON.stringify(root)}, 'cloud:personal/notes')).identity, 'drive:vault-id');
    assert.deepEqual(visited, ['cloud:', 'cloud:personal']);
    for (mode of ['missing', 'duplicate', 'no-id']) {
      await assert.rejects(syncPlan(${JSON.stringify(root)}, 'cloud:personal/notes'), { code: 'CONFLICT' });
    }
  `], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});

test('organization preserves bytes/history and refuses stale or occupied paths', async t => {
  const { root } = await fixture(t);
  const original = await save(root, 'inbox/a.md', 'An original note');
  const request = { path: 'inbox/a.md', to: 'organized/a.md', expected: original.sha256, key: 'move-a' };
  assert.equal((await organize(root, request)).state, 'moved');
  assert.equal((await organize(root, request)).replay, true);
  assert.equal((await operation(root, 'move-a')).state, 'moved');
  await save(root, 'occupied.md', 'Do not replace');
  await assert.rejects(organize(root, { ...request, path: request.to, to: 'occupied.md', key: 'occupied' }), { code: 'CONFLICT' });
  await assert.rejects(organize(root, { path: request.to, expected: hash('stale'), key: 'stale' }), { code: 'CONFLICT' });
  const remove = { path: request.to, expected: original.sha256, key: 'remove-a' };
  assert.equal((await organize(root, remove)).state, 'removed');
  assert.equal((await organize(root, remove)).replay, true);
  assert.equal(await fs.readFile(path.join(root, 'history', original.sha256), 'utf8'), 'An original note');
});

test('sync is inert without binding; policy revisions and remote paths are guarded', async t => {
  const { root } = await fixture(t);
  assert.equal((await syncStatus(root)).config, null);
  assert.equal((await syncRun(root)).state, 'unconfigured');
  for (const remote of ['drive:', ':drive,token=secret:path', 'drive:../escape', root]) {
    await assert.rejects(syncPlan(root, remote));
  }
  await assert.rejects(syncPolicy(root, { mode: 'two-way', expected: 'old' }), { code: 'CONFLICT' });
  assert.equal(environment(root).TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(environment(root).NODE_OPTIONS, undefined);
  assert.equal(environment(root).RCLONE_CONFIG, path.join(root, 'sync/rclone.conf'));
});

test('native adoption preserves a populated folder, empty files and directories; conflicts stop adoption', { skip: !nativeAvailable }, async t => {
  const { root, remote } = await fixture(t);
  await fs.mkdir(path.join(remote, 'empty-dir'));
  await fs.writeFile(path.join(remote, 'existing.md'), 'Existing remote note');
  await fs.writeFile(path.join(remote, 'empty.txt'), '');
  await fs.writeFile(path.join(remote, '.private'), 'excluded');
  const plan = await syncPlan(root, remote);
  assert.equal(plan.remoteFiles, 2); assert.equal(plan.ready, true);
  const adopted = await syncAdopt(root, remote);
  assert.equal(adopted.config.mode, 'two-way');
  assert.equal(await fs.readFile(path.join(root, 'files/existing.md'), 'utf8'), 'Existing remote note');
  assert.equal((await fs.stat(path.join(root, 'files/empty.txt'))).size, 0);
  assert((await fs.stat(path.join(root, 'files/empty-dir'))).isDirectory());
  assert(!existsSync(path.join(root, 'files/.private')));
  await assert.rejects(syncAdopt(root, remote), { code: 'CONFLICT' });
  const paused = await syncPolicy(root, { expected: adopted.revision, mode: 'paused', intervalSeconds: 30 });
  assert.equal(paused.config.mode, 'paused');
  assert.equal((await syncRun(root)).state, 'paused');
  await assert.rejects(syncPolicy(root, { expected: adopted.revision, mode: 'two-way' }), { code: 'CONFLICT' });

  const other = await fixture(t);
  await fs.writeFile(path.join(other.remote, 'same.md'), 'remote');
  await save(other.root, 'same.md', 'local');
  assert.equal((await syncPlan(other.root, other.remote)).ready, false);
  await assert.rejects(syncAdopt(other.root, other.remote), { code: 'CONFLICT' });
  assert.equal(await fs.readFile(path.join(other.root, 'files/same.md'), 'utf8'), 'local');
  assert.equal(await fs.readFile(path.join(other.remote, 'same.md'), 'utf8'), 'remote');
});

test('a deleted or replaced mapped root blocks transfers without recreating it', { skip: !nativeAvailable }, async t => {
  const { root, remote } = await fixture(t);
  await fs.writeFile(path.join(remote, 'kept.md'), 'Preserve me');
  await syncAdopt(root, remote);
  await fs.rename(remote, remote + '-deleted');
  await assert.rejects(syncRun(root));
  assert(!existsSync(remote));
  await fs.mkdir(remote);
  await assert.rejects(syncRun(root), { code: 'CONFLICT' });
  assert.equal(await fs.readFile(path.join(root, 'files/kept.md'), 'utf8'), 'Preserve me');
});
