import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyPublishingSettings} from '../scripts/publish-settings.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const workflow = `
jobs:
  publish:
    if: github.repository == 'jdorado/ez-library' && github.ref == 'refs/heads/main'
    permissions:
      id-token: write
    uses: jdorado/ez-agents/.github/workflows/npm-beta-shared.yml@fed05b9c88a5d96a801436a36983254758f03389
    with:
      package: '@jc_stack/ez-library'
      publisher-sha: 'fed05b9c88a5d96a801436a36983254758f03389'
`;

test('publishing settings match the public trusted-publisher workflow', () => {
  const settings = verifyPublishingSettings(pkg, workflow);
  assert.equal(settings.package.private, false);
  assert.equal(settings.package.access, 'public');
  assert.equal(settings.package.tag, 'latest');
  assert.equal(settings.workflow.package, pkg.name);
});

test('publishing settings reject private packages', () => {
  assert.throws(
    () => verifyPublishingSettings({...pkg, private: true}, workflow),
    /must not set private:true/,
  );
});

test('publishing settings reject non-public npm access', () => {
  assert.throws(
    () => verifyPublishingSettings({...pkg, publishConfig: {...pkg.publishConfig, access: 'restricted'}}, workflow),
    /publishConfig\.access must be public/,
  );
});
