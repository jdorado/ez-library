// Integration against an explicitly selected released Ez manager, never a runtime import.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const modulePath = process.env.EZ_MANAGER_MODULE;
if (!modulePath || !path.isAbsolute(modulePath)) throw Error('Set EZ_MANAGER_MODULE to the absolute released src/plugins/manager.mjs');
const { snapshot, init } = await import(pathToFileURL(modulePath));
const source = fileURLToPath(new URL('../', import.meta.url));
const root = await fs.mkdtemp(path.join(tmpdir(), 'ez-library-manager-'));
const home = path.join(root, 'tools'), mind = path.join(root, 'mind');
const bin = path.resolve(path.dirname(modulePath), '../../bin/ezenciel-agents-tools.mjs');
let record;
function call(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, '--home', home, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
    child.on('error', reject); child.on('close', code => code ? reject(Error(stderr || stdout || `Exit ${code}`)) : resolve(stdout));
    child.stdin.end(input);
  });
}
const parse = async (args, input) => JSON.parse(await call(args, input));
try {
  await fs.mkdir(mind); const catalog = path.join(root, 'catalog.json'); await fs.writeFile(catalog, '{}');
  await init(home, mind, catalog);
  const inspected = await snapshot(source);
  const installed = await parse(['plugins', 'install', 'library', '--source', source, '--revision', inspected.revision]);
  assert.equal(installed.started, false);
  record = JSON.parse(await fs.readFile(path.join(home, 'registry.json'))).plugins.library;
  await call(['plugins', 'start', 'library']);
  const note = '# Registry proof\n\nA synthetic violet bicycle.\n';
  const put = await parse(['library', 'put', '--path', 'notes/registry.md', '--expected', 'new', '--key', 'registry-1'], note);
  assert.equal(put.data.state, 'stored');
  assert.equal(await call(['library', 'get', '--path', 'notes/registry.md', '--raw']), note);
  await call(['library', 'qmd', 'collection', 'add', '/state/files', '--name', 'library']);
  assert.match(await call(['library', 'qmd', 'search', 'violet', '--json']), /registry\.md/);
  await call(['plugins', 'stop', 'library']); await call(['plugins', 'start', 'library']);
  assert.equal((await parse(['library', 'operation', '--key', 'registry-1'])).data.state, 'stored');
  assert.equal((await parse(['library', 'put', '--path', 'notes/registry.md', '--expected', 'new', '--key', 'registry-1'], note)).data.replay, true);
  await call(['plugins', 'uninstall', 'library']);
  const volumes = execFileSync('docker', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${record.project}`, '--format', '{{.Name}}'], { encoding: 'utf8' }).trim();
  assert(volumes); console.log(JSON.stringify({ ok: true, revision: inspected.revision, checks: ['inert-install', 'registered-dispatch', 'stdin-raw-readback', 'qmd-retrieval', 'restart-persistence', 'idempotency', 'data-preserving-uninstall'] }));
} finally {
  if (record) {
    execFileSync('docker', ['compose', '-p', record.project, '-f', record.compose, 'down', '--volumes'], { stdio: 'ignore' });
    execFileSync('docker', ['image', 'rm', `${record.project}-library:${record.revision.slice(7, 23)}`], { stdio: 'ignore' });
  }
  await fs.rm(root, { recursive: true, force: true });
}
