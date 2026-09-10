// Two real manager registries, one isolated shared worker, synthetic documents.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
const exec = promisify(execFile);
const modulePath = process.env.EZ_MANAGER_MODULE;
if (!modulePath || !path.isAbsolute(modulePath)) throw Error('Set EZ_MANAGER_MODULE');
const { snapshot, init } = await import(pathToFileURL(modulePath));
const bin = path.resolve(path.dirname(modulePath), '../../bin/ezenciel-agents-tools.mjs');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-shared-qa-'));
const source = path.join(root, 'source'), homes = [path.join(root, 'a'), path.join(root, 'b')];
const records = [];
const docker = async args => (await exec('docker', args, { maxBuffer: 16 * 1024 * 1024 })).stdout;
const call = async (home, args) => (await exec(process.execPath, [bin, '--home', home, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 1200000 })).stdout;
console.log(JSON.stringify({ qaRoot: root }));
const original = await snapshot(fileURLToPath(new URL('../', import.meta.url)));
for (const [name, f] of original.files) { const target = path.join(source, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, f.data, { mode: f.mode }); }
const descriptor = JSON.parse(await fs.readFile(path.join(source, 'ez-deployment.json')));
descriptor.sharedServices.embeddings.identity = 'embedding-qa-' + path.basename(root).toLowerCase();
await fs.writeFile(path.join(source, 'ez-deployment.json'), JSON.stringify(descriptor));
const shared = 'ez-shared-' + descriptor.sharedServices.embeddings.identity;
const candidate = await snapshot(source);
try {
  for (const [i, home] of homes.entries()) {
    const mind = home + '-mind'; await fs.mkdir(mind);
    await init(home, mind, undefined, undefined, true);
    await call(home, ['plugins', 'install', 'library', '--source', source, '--revision', candidate.revision]);
    const record = JSON.parse(await fs.readFile(path.join(home, 'registry.json'))).plugins.library; records.push(record);
    await call(home, ['plugins', 'start', 'library']);
    assert.equal(JSON.parse(await call(home, ['library', 'doctor'])).data.embeddings.service.state, 'off');
    // Synthetic files enter this agent's own volume; no shared document mount.
    const note = i === 0 ? '# Moonfruit\nThe orange cat sleeps on the warm windowsill.' : '# Starberry\nThe blue sailboat crosses the windy ocean.';
    await docker(['compose', '-p', record.project, '-f', record.compose, 'exec', '-T', 'library', 'node', '-e', 'require("fs").mkdirSync("/state/files",{recursive:true});require("fs").writeFileSync("/state/files/note.md",process.argv[1])', note]);
    await call(home, ['library', 'qmd', 'collection', 'add', '/state/files', '--name', 'library']);
    assert.match(await call(home, ['library', 'qmd', 'search', i === 0 ? 'Moonfruit' : 'Starberry', '--json']), /note.md/);
    assert.equal((await docker(['ps', '-aq', '--filter', `name=^/${shared}$`])).trim(), '');
  }
  await Promise.all(homes.map(home => call(home, ['plugins', 'shared-enable', 'library', 'embeddings'])));
  console.log('Both clients enabled; waiting for model and private indexes');
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const statuses = await Promise.all(homes.map(async home => JSON.parse(await call(home, ['library', 'doctor'])).data.embeddings));
    if (statuses.every(s => s.service.state === 'ready' && s.index.state === 'ready')) { ready = true; break; }
    if (attempt % 6 === 0) console.log(JSON.stringify({ attempt, statuses }));
    await setTimeout(10000);
  }
  assert(ready, 'Both indexes must become ready automatically');
  assert.equal((await docker(['ps', '-q', '--filter', `name=^/${shared}$`])).trim().split('\n').length, 1);
  const query = (home, text) => call(home, ['library', 'qmd', 'query', 'vec: ' + text, '-c', 'library', '--no-rerank', '--json']);
  const results = await Promise.all([query(homes[0], 'a resting pet'), query(homes[1], 'a vessel at sea')]);
  assert.match(results[0], /Moonfruit/); assert.doesNotMatch(results[0], /Starberry/);
  assert.match(results[1], /Starberry/); assert.doesNotMatch(results[1], /Moonfruit/);
  for (const record of records) {
    const models = await docker(['compose', '-p', record.project, '-f', record.compose, 'exec', '-T', 'library', 'node', '-e', 'console.log(require("fs").readdirSync("/state/qmd/cache/qmd/models"))']);
    assert(!models.includes('.gguf'));
  }
  await docker(['restart', shared]);
  for (let i = 0; i < 60; i++) {
    if (JSON.parse(await call(homes[1], ['library', 'doctor'])).data.embeddings.service.state === 'ready') break;
    await setTimeout(2000);
  }
  await call(homes[0], ['plugins', 'shared-disable', 'library', 'embeddings']);
  assert.equal(JSON.parse(await call(homes[0], ['library', 'doctor'])).data.embeddings.service.state, 'off');
  await call(homes[0], ['plugins', 'uninstall', 'library']);
  assert.match(await query(homes[1], 'ocean travel'), /Starberry/);
  await docker(['stop', shared]);
  assert.equal(JSON.parse(await call(homes[1], ['library', 'doctor'])).data.embeddings.service.state, 'unavailable');
  await assert.rejects(query(homes[1], 'ocean travel'));
  assert.match(await call(homes[1], ['library', 'qmd', 'search', 'Starberry', '--json']), /note.md/);
  console.log(JSON.stringify({ ok: true, sourceRevision: original.revision, checks: ['default-off', 'concurrent-single-worker', 'automatic-private-indexing', 'real-semantic-retrieval', 'private-corpora', 'no-client-model-download', 'worker-restart', 'detach-uninstall-preserves-other-agent', 'unavailable-with-keyword-search'] }));
} finally {
  for (const record of records) await docker(['compose', '-p', record.project, '-f', record.compose, 'down', '--volumes']).catch(() => {});
  await docker(['rm', '-f', shared]).catch(() => {});
  for (const suffix of ['ipc', 'models']) await docker(['volume', 'rm', `${shared}-${suffix}`]).catch(() => {});
}
