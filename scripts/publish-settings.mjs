import assert from 'node:assert/strict';

const sharedWorkflowPattern = /uses:\s+jdorado\/ez-agents\/\.github\/workflows\/npm-beta-shared\.yml@([0-9a-f]{40})/;
const publisherShaPattern = /publisher-sha:\s*'([0-9a-f]{40})'/;
const packageInputPattern = /^\s+package:\s*'([^']+)'\s*$/m;

export function verifyPublishingSettings(pkg, workflow) {
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
