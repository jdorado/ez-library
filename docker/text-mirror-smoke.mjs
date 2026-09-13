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
  // A second library resumes history directly from a local folder, without
  // rclone. The resident worker, not a manual sync-run, publishes its edit.
  parsed(['source-add', '--name', 'local', '--description', 'Local projection']);
  const historical = git(['rev-parse', 'main']).trim();
  git(['update-ref', 'refs/heads/local-history', historical]);
  edit("await fs.mkdir('/state/libraries/local/files/organized'); await fs.copyFile('/state/libraries/notes/files/organized/note.md', '/state/libraries/local/files/organized/note.md');");
  parsed(['git-mirror-adopt', '--library', 'local', '--repository', '/external/history.git', '--branch', 'local-history', '--expected-remote', historical]);
  edit("await fs.writeFile('/state/libraries/local/files/organized/note.md', '# Standalone\\nResident worker change.');");
  parsed(['source-add', '--name', 'checkout', '--description', 'Existing host checkout']);
  docker(['exec', id, 'git', 'clone', '--bare', '/external/history.git', '/external/checkout.git']);
  docker(['exec', id, 'git', 'clone', '/external/checkout.git', '/state/libraries/checkout/files']);
  edit("await fs.appendFile('/state/libraries/checkout/files/.git/info/exclude', '\\nnode_modules/\\n.local/\\n'); await fs.mkdir('/state/libraries/checkout/files/node_modules'); await fs.symlink('/absent-dependency', '/state/libraries/checkout/files/node_modules/dependency'); await fs.mkdir('/state/libraries/checkout/files/.local'); await fs.symlink('/absent-vault', '/state/libraries/checkout/files/.local/notes');");
  parsed(['git-adopt', '--library', 'checkout', '--repository', '/external/checkout.git', '--existing-checkout']);
  edit("await fs.writeFile('/state/libraries/checkout/files/outgoing.md', '# Checkout\\nResident Git change.');");
  docker(['exec', '-d', id, 'node', '/app/src/sync-worker.mjs']);
  const deadline = Date.now() + 60000;
  let automatic, checkoutStatus;
  while (Date.now() < deadline) {
    automatic = parsed(['sync-status', '--library', 'local']);
    checkoutStatus = parsed(['sync-status', '--library', 'checkout']);
    if (automatic.status?.textMirror?.remoteVerified && checkoutStatus.status?.git?.remoteVerified && checkoutStatus.status?.indexedAt) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(checkoutStatus.status?.git?.remoteVerified, true);
  assert.ok(checkoutStatus.status?.indexedAt);
  assert.match(docker(['exec', id, 'git', '--git-dir=/external/checkout.git', 'show', 'main:outgoing.md']), /Resident Git change/);
  assert.match(call(['search', 'Resident', '--library', 'checkout']), /outgoing.md/);
  assert.equal(automatic.config, null);
  assert.equal(automatic.status?.textMirror?.remoteVerified, true);
  assert.match(git(['show', 'local-history:organized/note.md']), /Resident worker change/);
  assert.equal(git(['rev-parse', 'local-history^']).trim(), historical);
  console.log(JSON.stringify({ ok: true, checks: ['pc-edit-to-git', 'agent-organize-to-folder', 'keyword-retrieval', 'media-exclusion', 'history-readback', 'restart-persistence', 'standalone-resident-mirror', 'adopt-existing-history', 'existing-checkout-resident-sync-and-index'] }));
} finally {
  docker(['rm', '-f', id]);
  docker(['volume', 'rm', id, id + '-external']);
}
