// Real native-engine integration, synthetic files only, no cloud credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const image = process.env.EZ_LIBRARY_IMAGE || 'ez-library:local';
const models = process.env.EZ_LIBRARY_MODELS_DIR;
if (!models) throw Error('Set EZ_LIBRARY_MODELS_DIR to an existing QMD models directory for offline semantic QA');
const id = 'ez-library-sync-qa-' + randomUUID();
const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'] });
const call = (args, input) => docker(['exec', '-i', id, 'node', '/app/bin/ez-library.mjs', ...args], input);
const parsed = (args, input) => JSON.parse(call(args, input)).data;
const edit = script => docker(['exec', '-i', id, 'node', '--input-type=module', '-e', "import * as fs from 'node:fs/promises';\n" + script]);
const mounts = ['-v', id + ':/state', '-v', id + '-external:/external', '-v', models + ':/state/qmd/cache/qmd/models:ro'];
const start = (worker = false) => docker(['run', '-d', '--name', id, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '4', '--memory', '4g', ...mounts, image, ...(worker ? [] : ['sleep', 'infinity'])]);
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
try {
  docker(['volume', 'create', id]); docker(['volume', 'create', id + '-external']);
  docker(['run', '--rm', '--user', 'root', ...mounts, image, 'chown', '1000:1000', '/external']);
  start();
  edit(`await fs.mkdir('/external/existing'); await fs.mkdir('/external/empty-directory');
    for (let i=0;i<5;i++) await fs.writeFile('/external/existing/note'+i+'.md', '# Original note '+i+'\\nAmber telescopes record the night sky.');
    await fs.writeFile('/external/empty.txt','');`);
  edit(`await fs.writeFile('/external/lease.pdf',${JSON.stringify(pdf('Lease renewal: November 2032.'))});`);
  assert.equal(parsed(['sync-plan', '--remote', '/external']).remoteFiles, 7);
  parsed(['sync-adopt', '--remote', '/external']);
  assert.equal(parsed(['sync-run']).state, 'synced-and-indexed');
  assert.match(call(['qmd', 'query', 'vec: observing stars at night', '-c', 'library', '--no-rerank', '--json', '-n', '3']), /note/);
  assert.match(call(['qmd', 'search', 'November', '-c', 'library-pdf', '--json']), /lease\.pdf\.md/);
  assert.match(call(['qmd', 'query', 'vec: When does the lease renew?', '-c', 'library-pdf', '--no-rerank', '--json', '-n', '3']), /lease\.pdf\.md/);
  edit(`await fs.writeFile('/external/lease.pdf',${JSON.stringify(pdf('Lease renewal: December 2033.'))});`);
  parsed(['sync-run']);
  assert.match(call(['qmd', 'search', 'December', '-c', 'library-pdf', '--json']), /lease\.pdf\.md/);
  assert.doesNotMatch(call(['qmd', 'search', 'November', '-c', 'library-pdf', '--json']), /lease\.pdf\.md/);

  edit(`await fs.writeFile('/external/new.md', '# New arrival\\nA cobalt otter lives beside the river.');`);
  parsed(['sync-run']);
  assert.match(call(['qmd', 'search', 'cobalt', '--json']), /new\.md/);
  const saved = parsed(['put', '--path', 'agent.md', '--key', 'agent', '--expected', 'new'], '# Agent organization\nSaffron notebook.');
  parsed(['sync-run']);
  assert.match(edit(`process.stdout.write(await fs.readFile('/external/agent.md','utf8'));`), /Saffron/);
  parsed(['move', '--path', 'agent.md', '--to', 'organized/agent.md', '--key', 'organize', '--expected', saved.sha256]);
  parsed(['sync-run']);
  assert.match(edit(`process.stdout.write(await fs.readFile('/external/organized/agent.md','utf8'));`), /Saffron/);
  assert.throws(() => edit(`await fs.stat('/external/agent.md');`));

  // Simultaneous revisions must survive on both sides, without choosing a winner.
  edit(`await fs.writeFile('/external/new.md','Remote revision'); await fs.writeFile('/state/files/new.md','Local revision');`);
  parsed(['sync-run']);
  const conflictNames = JSON.parse(edit(`process.stdout.write(JSON.stringify((await fs.readdir('/external')).filter(x=>x.includes('conflict'))));`));
  assert.equal(conflictNames.length, 2);
  const versions = conflictNames.map(name => edit(`process.stdout.write(await fs.readFile('/external/'+${JSON.stringify(name)},'utf8'));`)).sort();
  assert.deepEqual(versions, ['Local revision', 'Remote revision']);

  // External deletion and rename update the searchable working tree.
  edit(`await fs.unlink('/external/existing/note0.md'); await fs.rename('/external/existing/note1.md','/external/renamed.md');`);
  parsed(['sync-run']);
  assert.throws(() => call(['get', '--path', 'existing/note0.md']));
  assert.match(call(['get', '--path', 'renamed.md', '--raw']), /Original note 1/);
  assert.doesNotMatch(call(['qmd', 'search', 'telescopes', '--json', '-n', '20']), /note0\.md|note1\.md/);

  // Run the actual resident worker, then restart it with the same volumes.
  docker(['rm', '-f', id]); start(true);
  edit(`await fs.writeFile('/external/watched.md','# Automatic arrival\\nTangerine satellites orbit Jupiter.');`);
  let ready = false;
  for (let i = 0; i < 45; i++) {
    await setTimeout(2000);
    const status = parsed(['sync-status']);
    if (['synced-and-indexed', 'synced-with-conflicts'].includes(status.status?.state)) {
      try { if (call(['qmd', 'search', 'Tangerine', '--json']).includes('watched.md')) { ready = true; break; } } catch {}
    }
  }
  assert(ready, 'Resident worker must discover and index an external addition');
  docker(['restart', id]);
  await setTimeout(3000);
  assert.equal(parsed(['sync-status']).config.mode, 'two-way');
  // Missing access marker must stop propagation, retaining local originals.
  edit(`await fs.unlink('/external/LIBRARY_SYNC_ACCESS');`);
  for (let i = 0; i < 40; i++) {
    await setTimeout(2000);
    if (parsed(['sync-status']).status?.state === 'sync-error') break;
  }
  assert.equal(parsed(['sync-status']).status.state, 'sync-error');
  assert.match(call(['get', '--path', 'watched.md', '--raw']), /Tangerine/);
  console.log(JSON.stringify({ ok: true, checks: ['existing-folder-adoption', 'empty-files-and-folders', 'native-semantic-index', 'pdf-automatic-extraction-and-semantic-index', 'pdf-replacement-removes-stale-text', 'external-add-and-index', 'agent-save-and-rename', 'preserve-both-conflicts', 'external-delete-and-rename', 'resident-auto-detection', 'restart-persistence', 'missing-marker-stops-sync'] }));
} finally {
  try { docker(['rm', '-f', id]); } catch {}
  docker(['volume', 'rm', id, id + '-external']);
}
