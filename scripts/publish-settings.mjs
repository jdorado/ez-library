import assert from 'node:assert/strict';

const sharedWorkflowPattern = /uses:\s+jdorado\/ez-agents\/\.github\/workflows\/npm-beta-shared\.yml@([0-9a-f]{40})/;
const publisherShaPattern = /publisher-sha:\s*'([0-9a-f]{40})'/;
const packageInputPattern = /^\s+package:\s*'([^']+)'\s*$/m;

// This is a generated caller, not arbitrary YAML. Compare its complete contract
// so comments, duplicate keys, other jobs and expression suffixes cannot satisfy
// checks for the actual publishing job. Formatting changes require review.
const callerContract = `name: Publish verified npm beta
on:
  workflow_dispatch:
    inputs:
      release-id:
        description: 'Numeric ID of the staged draft prerelease'
        required: true
        type: string
      version:
        description: 'Reviewed beta version staged as draft release vVERSION'
        required: true
        type: string
      source-sha:
        description: 'Full tested commit SHA; must be current main'
        required: true
        type: string
      artifact-sha256:
        description: 'SHA-256 of the exact independently verified candidate.tgz'
        required: true
        type: string
permissions: {}
jobs:
  publish:
    if: github.repository == 'jdorado/ez-library' && github.ref == 'refs/heads/main'
    permissions:
      contents: write
      checks: read
      actions: read
      pull-requests: read
      id-token: write
    uses: jdorado/ez-agents/.github/workflows/npm-beta-shared.yml@PUBLISHER_SHA
    with:
      package: '@jc_stack/ez-library'
      publisher-sha: 'PUBLISHER_SHA'
      required-checks: '["verify (22)","verify (24)","docker"]'
      release-id: \${{ inputs.release-id }}
      version: \${{ inputs.version }}
      source-sha: \${{ inputs.source-sha }}
      artifact-sha256: \${{ inputs.artifact-sha256 }}`;
const normalizeCaller = text => text.split(/\r?\n/).map(line => line.trimEnd())
  .filter(line => line.trim() && !line.trimStart().startsWith('#')).join('\n');

export function verifyPublishingSettings(pkg, workflow) {
  workflow = normalizeCaller(workflow);
  const publishConfig = pkg.publishConfig ?? {};
  assert.notEqual(pkg.private, true, 'package.json must not set private:true for public npm publication');
  assert.equal(publishConfig.access, 'public', 'package.json publishConfig.access must be public');
  assert.equal(publishConfig.tag, 'latest', 'package.json publishConfig.tag must be latest');
  assert.equal(
    pkg.repository?.url,
    'git+https://github.com/jdorado/ez-library.git',
    'package.json repository.url must point to jdorado/ez-library',
  );

  assert.match(
    workflow,
    /if: github\.repository == 'jdorado\/ez-library' && github\.ref == 'refs\/heads\/main'/,
    'publish workflow must be restricted to jdorado/ez-library main',
  );
  assert.match(workflow, /^\s+id-token:\s+write\s*$/m, 'publish workflow must request OIDC identity tokens');

  const sharedWorkflow = workflow.match(sharedWorkflowPattern);
  const publisherSha = workflow.match(publisherShaPattern);
  const packageInput = workflow.match(packageInputPattern);
  assert.ok(sharedWorkflow, 'publish workflow must pin the shared publisher to a full commit SHA');
  assert.ok(publisherSha, 'publish workflow must pin publisher-sha to a full commit SHA');
  assert.equal(sharedWorkflow[1], publisherSha[1], 'shared workflow SHA and publisher-sha must match');
  assert.equal(packageInput?.[1], pkg.name, 'publish workflow package must match package.json name');

  assert.equal(
    workflow.replaceAll(sharedWorkflow[1], 'PUBLISHER_SHA'),
    callerContract,
    'publish workflow must match the reviewed generated caller contract',
  );

  return {
    package: {
      name: pkg.name,
      version: pkg.version,
      private: pkg.private === true,
      access: publishConfig.access,
      tag: publishConfig.tag,
      repository: pkg.repository.url,
    },
    workflow: {
      repository: 'jdorado/ez-library',
      branch: 'main',
      package: packageInput[1],
      publisherSha: publisherSha[1],
    },
  };
}
