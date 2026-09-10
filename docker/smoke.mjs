// Explicit Docker integration with synthetic data; no provider accounts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';

const image = process.env.EZ_LIBRARY_IMAGE || 'ez-library:local';
const volume = 'ez-library-qa-' + randomUUID();
const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
const ipc = process.env.EZ_LIBRARY_EMBED_IPC;
const lastCpu = Math.max(0, Math.min(4, Number(docker(['info', '--format', '{{.NCPU}}']).trim())) - 1);
const call = (args, input) => docker(['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--cpuset-cpus', `0-${lastCpu}`, '--memory', '4g', '-i', '-v', volume + ':/state',
  ...(ipc ? ['-v', ipc + ':/inference:ro', '-e', 'EZ_LIBRARY_EMBED_SOCKET=/inference/worker.sock'] : []),
  image, 'node', '/app/bin/ez-library.mjs', ...args], input);
const parsed = (args, input) => JSON.parse(call(args, input)).data;
try {
  docker(['volume', 'create', volume]);
  assert.match(call(['--help']), /Local library/);
  assert.equal(parsed(['doctor']).configured, false);
  parsed(['configure', '--expected', 'new', '--key', 'settings'], JSON.stringify({ schemaVersion: 1, storage: { mode: 'local' }, backup: { mode: 'off' } }));
  const note = '# Travel checklist\n\nPassport, charger and toothbrush.\n';
  const receipt = parsed(['put', '--path', 'notes/travel.md', '--expected', 'new', '--key', 'travel'], note);
  assert.equal(receipt.sha256, createHash('sha256').update(note).digest('hex'));
  assert.equal(call(['get', '--path', 'notes/travel.md', '--raw']), note);
  assert.equal(parsed(['put', '--path', 'notes/travel.md', '--expected', 'new', '--key', 'travel'], note).replay, true);
  // Separate command containers demonstrate persistent data, not process-local state.
  assert.equal(parsed(['operation', '--key', 'travel']).state, 'stored');
  const media = '%PDF-1.7\nSynthetic attachment fixture\n';
  parsed(['put', '--path', 'attachments/example.pdf', '--expected', 'new', '--key', 'pdf'], media);
  assert.equal(call(['get', '--path', 'attachments/example.pdf', '--raw']), media);
  // A real, synthetic one-page PDF exercises Poppler rather than just byte storage.
  const stream = 'BT /F1 12 Tf 40 100 Td (Synthetic lease: renewal is October 2030.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const original = parsed(['put', '--path', 'attachments/lease.pdf', '--expected', 'new', '--key', 'lease'], pdf);
  const extracted = call(['pdf-text', '--path', 'attachments/lease.pdf']);
  assert.match(extracted, /renewal is October 2030/); assert.match(extracted, /\f/);
  assert.equal(parsed(['get', '--path', 'attachments/lease.pdf']).sha256, original.sha256);
  parsed(['put', '--path', 'notes/lease.md', '--expected', 'new', '--key', 'lease-text'], '# Lease\nSource: attachments/lease.pdf\nPage 1\n' + extracted);
  assert.throws(() => call(['pdf-text', '--path', 'attachments/example.pdf']), error => error.status !== 0);
  parsed(['put', '--path', 'notes/reading.txt', '--expected', 'new', '--key', 'txt'], 'A quasar reading list.\n');
  call(['qmd', 'collection', 'add', '/state/files', '--name', 'library', '--mask', '**/*.{md,txt}']);
  assert.match(call(['qmd', 'search', 'renewal', '-c', 'library', '--json']), /lease\.md/);
  assert.match(call(['qmd', 'search', 'passport', '-c', 'library', '--json']), /travel\.md/);
  assert.match(call(['qmd', 'search', 'quasar', '-c', 'library', '--json']), /reading\.txt/);
  assert.match(call(['qmd', 'get', 'qmd://library/notes/travel.md']), /Passport, charger and toothbrush/);
  if (ipc) {
    call(['qmd', 'embed', '--no-gpu', '--max-docs-per-batch', '8']);
    assert.match(call(['qmd', 'query', 'vec: What should I pack for a trip?', '-c', 'library', '--no-rerank', '--json', '-n', '5']), /travel\.md/);
  }
  parsed(['source-add', '--name', 'work', '--description', 'Synthetic work notes']);
  assert.equal(parsed(['sources']).selectionRequired, true);
  assert.throws(() => call(['put', '--path', 'notes/travel.md', '--expected', 'new', '--key', 'ambiguous'], 'wrong'), error => error.status === 2);
  parsed(['put', '--library', 'work', '--path', 'notes/travel.md', '--expected', 'new', '--key', 'travel'], '# Work\nPassport approval policy.');
  call(['qmd', '--library', 'work', 'collection', 'add', '/state/libraries/work/files', '--name', 'library', '--mask', '**/*.{md,txt}']);
  const combined = parsed(['search', 'passport', '--all']);
  assert.equal(combined.complete, true);
  assert.deepEqual(combined.libraries.map(x => x.library), ['default', 'work']);
  for (const item of combined.libraries) {
    assert.equal(item.results[0].library, item.library);
    assert.match(item.results[0].file, /travel\.md/);
  }
  assert.equal(call(['get', '--library', 'default', '--path', 'notes/travel.md', '--raw']), note);
  assert.match(call(['get', '--library', 'work', '--path', 'notes/travel.md', '--raw']), /approval policy/);
  console.log(JSON.stringify({ ok: true, checks: ['help-without-state', 'configuration', 'intake-readback', 'idempotency', 'restart-persistence', 'attachment-bytes', 'pdf-extraction-and-retrieval', 'native-qmd-keyword', 'named-library-isolation-and-search', ...(ipc ? ['shared-qmd-semantic'] : [])] }));
} finally { docker(['volume', 'rm', volume]); }
