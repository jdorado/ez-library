// Explicit live-provider QA. Only a new test branch is mutated. OAuth stays in
// the registered GitHub plugin. The temporary deploy key and volume are removed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import path from 'node:path';

const ez = process.env.EZ_GITHUB_CLI, repository = process.env.EZ_LIBRARY_GITHUB_QA_REPOSITORY;
const models = process.env.EZ_LIBRARY_MODELS_DIR, image = process.env.EZ_LIBRARY_IMAGE || 'ez-library:local';
if (!ez || !path.isAbsolute(ez) || !/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !models) throw Error('Set EZ_GITHUB_CLI, EZ_LIBRARY_GITHUB_QA_REPOSITORY and EZ_LIBRARY_MODELS_DIR; invoking this suite authorizes its isolated test branch and temporary deploy key');
const suffix = randomUUID().slice(0, 8), branch = 'library-sync-qa-' + suffix, folder = 'qa/' + suffix;
const container = 'ez-library-git-qa-' + suffix;
const invoke = (binary, args, input) => execFileSync(binary, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
const docker = (args, input) => invoke('docker', args, input);
const api = (endpoint, method = 'GET', body) => {
  const out = invoke(ez, ['github', 'gh', 'api', endpoint, '--method', method, ...(body ? ['--input', '-'] : [])], body ? JSON.stringify(body) : undefined);
  return out.trim() ? JSON.parse(out) : null;
};
const call = (args, input) => docker(['exec', '-i', container, 'node', '/app/bin/ez-library.mjs', ...args], input);
const parsed = (args, input) => JSON.parse(call(args, input)).data;
const remote = file => api(`repos/${repository}/contents/${folder}/${file}?ref=${branch}`);
const saveRemote = (file, content, sha) => api(`repos/${repository}/contents/${folder}/${file}`, 'PUT', { branch, message: 'Library sync QA fixture', content: Buffer.from(content).toString('base64'), ...(sha ? { sha } : {}) });
const bytes = result => Buffer.from(result.content, 'base64').toString('utf8');
const mounts = ['-v', container + ':/state', '-v', models + ':/state/qmd/cache/qmd/models:ro'];
const start = worker => docker(['run', '-d', '--name', container, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '4', '--memory', '4g', ...mounts, image, ...(worker ? [] : ['sleep', 'infinity'])]);
async function waitForCommit(commit) {
  for (let i = 0; i < 90; i++) {
    await setTimeout(2000);
    const s = parsed(['sync-status']).status;
    if (s?.state === 'synced-and-indexed' && s.git?.commit === commit) return s;
  }
  throw Error('Resident Git worker did not import/index the expected remote commit');
}
function pdf(text) {
  const stream = `BT /F1 12 Tf 40 100 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let content = '%PDF-1.4\n'; const offsets = [];
  for (const [i, object] of objects.entries()) { offsets.push(content.length); content += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = content.length;
  return content + `xref\n0 6\n0000000000 65535 f \n${offsets.map(n => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
let keyId, volume = false;
try {
  const repo = api(`repos/${repository}`);
  assert(repo.private && repo.permissions.admin, 'Live QA requires the selected private repository and deploy-key administration');
  const main = api(`repos/${repository}/git/ref/heads/${repo.default_branch}`).object.sha;
  api(`repos/${repository}/git/refs`, 'POST', { ref: 'refs/heads/' + branch, sha: main });
  saveRemote('stars.md', '# Stars\nAmber telescopes observe Jupiter at night.');
  saveRemote('conflict.md', '# Draft\nOriginal revision.');
  saveRemote('empty.txt', '');
  saveRemote('lease.pdf', pdf('Lease renewal: November 2032.'));
  docker(['volume', 'create', container]); volume = true; start(false);
  const key = parsed(['git-key', '--repository', repository]);
  keyId = api(`repos/${repository}/keys`, 'POST', { title: 'Ez Library smoke ' + suffix, key: key.publicKey, read_only: false }).id;
  parsed(['git-adopt', '--repository', repository, '--branch', branch]);
  const initial = parsed(['sync-run']);
  assert(initial.git.remoteVerified && initial.embedded);
  assert.match(call(['qmd', 'search', 'November', '-c', 'library-pdf', '--json']), /lease\.pdf\.md/);
  assert.match(call(['qmd', 'query', 'vec: When is the lease renewed?', '-c', 'library-pdf', '--no-rerank', '--json', '-n', '10']), /lease\.pdf\.md/);
  console.log(JSON.stringify({ stage: 'native-ssh-import-pdf-semantic', ok: true }));

  // Start the installed supervisor and prove provider->Library auto-discovery.
  docker(['rm', '-f', container]); start(true);
  const incoming = saveRemote('incoming.md', '# Incoming\nCobalt otters live by the river.');
  await waitForCommit(incoming.commit.sha);
  assert.match(call(['qmd', 'search', 'cobalt', '--json']), /incoming\.md/);
  let cfg = parsed(['sync-status']); parsed(['sync-policy', '--expected', cfg.revision, '--mode', 'two-way', '--interval', '30']);
  const local = parsed(['put', '--path', folder + '/agent.md', '--expected', 'new', '--key', 'agent'], '# Agent\nSaffron notebooks.');
  let exported = false;
  for (let i = 0; i < 60; i++) {
    await setTimeout(2000);
    const s = parsed(['sync-status']).status;
    if (s?.state === 'synced-and-indexed' && s.git?.commit !== incoming.commit.sha) {
      assert.match(bytes(remote('agent.md')), /Saffron/); exported = true; break;
    }
  }
  assert(exported, 'Agent save must be pushed by the resident worker');
  console.log(JSON.stringify({ stage: 'automatic-both-directions', ok: true }));

  // Pause recurring work while constructing a simultaneous conflict.
  cfg = parsed(['sync-status']); parsed(['sync-policy', '--expected', cfg.revision, '--mode', 'paused']);
  const name = folder + '/conflict.md';
  parsed(['put', '--path', name, '--expected', parsed(['get', '--path', name]).sha256, '--key', 'local-conflict'], 'LOCAL revision\n');
  saveRemote('conflict.md', 'REMOTE revision\n', remote('conflict.md').sha);
  cfg = parsed(['sync-status']); parsed(['sync-policy', '--expected', cfg.revision, '--mode', 'two-way']);
  assert.throws(() => call(['sync-run']), e => e.status === 3);
  assert.match(call(['git', 'show', ':2:' + name]), /LOCAL revision/);
  assert.match(call(['git', 'show', ':3:' + name]), /REMOTE revision/);
  parsed(['put', '--path', name, '--expected', parsed(['get', '--path', name]).sha256, '--key', 'resolve'], 'Reviewed resolution\n');
  call(['git', 'add', '--', name]); parsed(['sync-run']);
  assert.match(bytes(remote('conflict.md')), /Reviewed resolution/);
  parsed(['move', '--path', folder + '/agent.md', '--to', folder + '/organized.md', '--expected', local.sha256, '--key', 'move']);
  parsed(['sync-run']); assert.match(bytes(remote('organized.md')), /Saffron/);
  console.log(JSON.stringify({ stage: 'conflict-resolution-and-agent-rename', ok: true }));

  saveRemote('lease.pdf', pdf('Lease renewal: December 2033.'), remote('lease.pdf').sha);
  const deleted = api(`repos/${repository}/contents/${folder}/incoming.md`, 'DELETE', { branch, message: 'Library QA deletion', sha: remote('incoming.md').sha });
  await waitForCommit(deleted.commit.sha);
  assert.doesNotMatch(call(['qmd', 'search', 'cobalt', '--json']), /incoming\.md/);
  assert.match(call(['qmd', 'search', 'December', '-c', 'library-pdf', '--json']), /lease\.pdf\.md/);
  assert.doesNotMatch(call(['qmd', 'search', 'November', '-c', 'library-pdf', '--json']), /lease\.pdf\.md/);
  docker(['restart', container]);
  const restarted = saveRemote('restart.md', '# Restart\nTangerine satellites.');
  await waitForCommit(restarted.commit.sha);
  assert.match(call(['qmd', 'search', 'tangerine', '--json']), /restart\.md/);
  console.log(JSON.stringify({ ok: true, repository, branch, folder, url: `https://github.com/${repository}/tree/${branch}/${folder}`, checks: ['existing-provider-deploy-key', 'private-ssh-import', 'automatic-two-way-sync', 'pdf-semantic-index', 'native-conflicts-retained-and-resolved', 'agent-rename', 'external-delete', 'pdf-replacement-removes-stale-text', 'restart-auto-import'], mainBranchModifiedByQA: false }));
} finally {
  try { docker(['rm', '-f', container]); } catch {}
  if (volume) docker(['volume', 'rm', container]);
  if (keyId) api(`repos/${repository}/keys/${keyId}`, 'DELETE');
}
