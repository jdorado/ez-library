// Synthetic folder <-> agent <-> Git history, no provider accounts or model downloads.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const image = process.env.EZ_LIBRARY_IMAGE || 'ez-library:local';
const id = 'ez-library-mirror-qa-' + randomUUID();
const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
const call = (args, input) => docker(['exec', '-i', id, 'node', '/app/bin/ez-library.mjs', ...args], input);
const parsed = (args, input) => JSON.parse(call(args, input)).data;
const edit = script => docker(['exec', id, 'node', '--input-type=module', '-e', "import * as fs from 'node:fs/promises';\n" + script]);
const git = args => docker(['exec', id, 'git', '--git-dir=/external/history.git', ...args]);
try {
  docker(['volume', 'create', id]); docker(['volume', 'create', id + '-external']);
  docker(['run', '--rm', '--user', 'root', '-v', id + '-external:/external', image, 'chown', '1000:1000', '/external']);
  docker(['run', '-d', '--name', id, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '4g', '-e', 'EZ_LIBRARY_EMBED=0', '-v', id + ':/state', '-v', id + '-external:/external', image, 'sleep', 'infinity']);
  edit("await fs.mkdir('/external/vault'); await fs.mkdir('/external/vault/_attachments'); await fs.writeFile('/external/vault/note.md', '# Telescope\\nOriginal PC note.'); await fs.writeFile('/external/vault/_attachments/image.png', 'synthetic bytes');");
  docker(['exec', id, 'git', 'init', '--bare', '--initial-branch=main', '/external/history.git']);
  parsed(['source-add', '--name', 'notes', '--description', 'Synthetic PC notes']);
  parsed(['sync-adopt', '--library', 'notes', '--remote', '/external/vault']);
  parsed(['git-mirror-adopt', '--library', 'notes', '--repository', '/external/history.git']);
  const first = parsed(['sync-run', '--library', 'notes']);
  assert.equal(first.textMirror.remoteVerified, true);
  assert.equal(git(['ls-tree', '-r', '--name-only', 'main']).trim(), 'note.md');
  edit("await fs.writeFile('/external/vault/note.md', '# Telescope\\nEdited on PC: amber telescope.');");
  const pc = parsed(['sync-run', '--library', 'notes']);
  assert.notEqual(pc.textMirror.commit, first.textMirror.commit);
  assert.match(git(['show', 'main:note.md']), /Edited on PC/);
  assert.match(call(['search', 'amber', '--library', 'notes']), /note\.md/);
  const note = parsed(['get', '--library', 'notes', '--path', 'note.md']);
  parsed(['move', '--library', 'notes', '--path', 'note.md', '--to', 'organized/note.md', '--expected', note.sha256, '--key', 'organize']);
  parsed(['sync-run', '--library', 'notes']);
  assert.match(edit("process.stdout.write(await fs.readFile('/external/vault/organized/note.md','utf8'));"), /Edited on PC/);
  assert.equal(git(['ls-tree', '-r', '--name-only', 'main']).trim(), 'organized/note.md');
  assert.match(git(['show', first.textMirror.commit + ':note.md']), /Original PC note/);
  assert.equal(edit("process.stdout.write(await fs.readFile('/external/vault/_attachments/image.png','utf8'));"), 'synthetic bytes');
  docker(['restart', id]);
  assert.equal(parsed(['git-mirror-status', '--library', 'notes']).config.lastCommit, git(['rev-parse', 'main']).trim());
  console.log(JSON.stringify({ ok: true, checks: ['pc-edit-to-git', 'agent-organize-to-folder', 'keyword-retrieval', 'media-exclusion', 'history-readback', 'restart-persistence'] }));
} finally {
  docker(['rm', '-f', id]);
  docker(['volume', 'rm', id, id + '-external']);
}
