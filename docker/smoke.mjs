// Explicit Docker integration with synthetic data; no provider accounts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';

const image = process.env.EZ_LIBRARY_IMAGE || 'ez-library:local';
const volume = 'ez-library-qa-' + randomUUID();
const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
const models = process.env.EZ_LIBRARY_MODELS_DIR;
const lastCpu = Math.max(0, Math.min(4, Number(docker(['info', '--format', '{{.NCPU}}']).trim())) - 1);
const call = (args, input) => docker(['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--cpuset-cpus', `0-${lastCpu}`, '--memory', '4g', '-i', '-v', volume + ':/state',
  ...(models ? ['-v', models + ':/state/qmd/cache/qmd/models:ro'] : []),
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
  parsed(['put', '--path', 'notes/reading.txt', '--expected', 'new', '--key', 'txt'], 'A quasar reading list.\n');
  call(['qmd', 'collection', 'add', '/state/files', '--name', 'library', '--mask', '**/*.{md,txt}']);
  assert.match(call(['qmd', 'search', 'passport', '-c', 'library', '--json']), /travel\.md/);
  assert.match(call(['qmd', 'search', 'quasar', '-c', 'library', '--json']), /reading\.txt/);
  assert.match(call(['qmd', 'get', 'qmd://library/notes/travel.md']), /Passport, charger and toothbrush/);
  if (models) {
    call(['qmd', 'embed', '--no-gpu', '--max-docs-per-batch', '8']);
    assert.match(call(['qmd', 'query', 'vec: What should I pack for a trip?', '-c', 'library', '--no-rerank', '--json', '-n', '5']), /travel\.md/);
  }
  console.log(JSON.stringify({ ok: true, checks: ['help-without-state', 'configuration', 'intake-readback', 'idempotency', 'restart-persistence', 'attachment-bytes', 'native-qmd-keyword', ...(models ? ['offline-qmd-semantic'] : [])] }));
} finally { docker(['volume', 'rm', volume]); }
