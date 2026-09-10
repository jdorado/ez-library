import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('per-library indexing policy controls native QMD embedding with explicit shared-worker enablement', () => {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `
    import { mock } from 'node:test';
    import assert from 'node:assert/strict';
    import * as fs from 'node:fs/promises';
    import path from 'node:path';
    import { tmpdir } from 'node:os';
    const native = await import('./src/native.mjs');
    const calls = [];
    mock.module('./src/native.mjs', { namedExports: { ...native,
      qmd: async (_, args) => { calls.push(args); return { code: 0, stdout: args[0] === 'collection' && args[1] === 'list' ? '' : '', stderr: '' }; }
    } });
    const { refreshIndex, indexStatus } = await import('./src/indexer.mjs');
    process.env.EZ_LIBRARY_EMBED_SOCKET = '/synthetic/worker.sock';
    const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'library-index-policy-')));
    try {
      async function run(name, indexing, globalEmbed = true) {
        const root = path.join(base, name);
        await fs.mkdir(path.join(root, 'files'), { recursive: true });
        await fs.mkdir(path.join(root, 'sync'));
        await fs.writeFile(path.join(root, 'files', 'note.md'), name);
        if (indexing) await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ schemaVersion: 1, storage: { mode: 'local' }, backup: { mode: 'off' }, indexing }));
        if (globalEmbed) delete process.env.EZ_LIBRARY_EMBED; else process.env.EZ_LIBRARY_EMBED = '0';
        const start = calls.length;
        const result = await refreshIndex(root);
        return { result, calls: calls.slice(start) };
      }
      const keyword = await run('keyword', { mode: 'keyword' });
      assert.equal(keyword.result.embedded, false);
      assert.equal(keyword.calls.some(args => args[0] === 'embed'), false);
      assert(keyword.calls.some(args => args[0] === 'update'));

      const semantic = await run('semantic', { mode: 'semantic' });
      assert.equal(semantic.result.embedded, true);
      assert(semantic.calls.some(args => args[0] === 'embed'));

      const semanticRoot = path.join(base, 'semantic');
      await fs.writeFile(path.join(semanticRoot, 'settings.json'), JSON.stringify({ schemaVersion: 1, storage: { mode: 'local' }, backup: { mode: 'off' }, indexing: { mode: 'keyword' } }));
      assert.equal((await indexStatus(semanticRoot)).state, 'off');
      let start = calls.length;
      const changedToKeyword = await refreshIndex(semanticRoot);
      assert.equal(changedToKeyword.embedded, false);
      assert.deepEqual(calls.slice(start), []);
      assert.equal(JSON.parse(await fs.readFile(path.join(semanticRoot, 'sync/index.json'))).embedded, false);

      start = calls.length;
      assert.equal((await refreshIndex(semanticRoot)).embedded, false);
      assert.deepEqual(calls.slice(start), []);

      await fs.writeFile(path.join(semanticRoot, 'settings.json'), JSON.stringify({ schemaVersion: 1, storage: { mode: 'local' }, backup: { mode: 'off' }, indexing: { mode: 'semantic' } }));
      start = calls.length;
      assert.equal((await refreshIndex(semanticRoot)).embedded, true);
      assert(calls.slice(start).some(args => args[0] === 'embed'));

      const legacy = await run('legacy');
      assert.equal(legacy.result.embedded, true);
      assert(legacy.calls.some(args => args[0] === 'embed'));

      delete process.env.EZ_LIBRARY_EMBED_SOCKET;
      assert.equal((await indexStatus(semanticRoot)).state, 'off');
      const defaultOff = await run('default-off');
      assert.equal(defaultOff.result.embedded, false);
      assert.equal(defaultOff.calls.some(args => args[0] === 'embed'), false);
      process.env.EZ_LIBRARY_EMBED_SOCKET = '/synthetic/worker.sock';
      const globallyDisabled = await run('global-off', { mode: 'semantic' }, false);
      assert.equal(globallyDisabled.result.embedded, false);
      assert.equal(globallyDisabled.calls.some(args => args[0] === 'embed'), false);
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  `], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});
