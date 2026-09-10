# Releasing

Use CONTRIBUTING.md for every change. The source repository is public and registered in the Ez catalog; the first public npm candidate is 0.1.0-beta.10. Publication requires the reviewed release preparation PR and maintainer authorization. Keep manifest and package versions equal. Versions are immutable once published.

1. Run `pnpm install --frozen-lockfile`, `pnpm verify`, `npm run release:check`, and `git diff --check`. The release check also verifies that `package.json` is not private, requests public npm access on the `latest` tag, matches the repository identity, and agrees with the pinned trusted-publisher caller. It does not prove npm package existence, npm trust enrollment, or registry delivery; read those back separately. Review dependency audit results and licenses without automatic fixes. After lockfile changes, copy `pnpm-lock.yaml` to `docker/pnpm-lock.yaml`.
2. Run `npm pack --ignore-scripts --pack-destination /absolute/temporary-directory`, inspect its file list, hash it, and extract into an empty directory. Rebuild Docker `test` and `runtime` targets from that extracted package. Restore `docker/pnpm-lock.yaml` to the extracted root for a frozen pnpm installation. Check CLI help without state.
3. Run `EZ_LIBRARY_IMAGE=ez-library:local node docker/smoke.mjs`. For installer/descriptor changes also run `EZ_MANAGER_MODULE=/absolute/released-ez/src/plugins/manager.mjs node docker/manager-smoke.mjs`. Also run `EZ_MANAGER_MODULE=/absolute/released-ez/src/plugins/manager.mjs node docker/shared-smoke.mjs` for the shared worker and real semantic retrieval. The latter is an explicit integration input, not a runtime dependency on a sibling repository. Use separate state and synthetic data. Verify install is inert, registered dispatch, restart persistence and data-preserving uninstall.
   For folder-sync changes also run `EZ_LIBRARY_IMAGE=ez-library:local node docker/sync-smoke.mjs`; it uses separate volumes and synthetic files with networking disabled. Native cloud authorization and provider readback remain separate required evidence for a live cloud binding.
   For text-mirror changes also run `EZ_LIBRARY_IMAGE=ez-library:local node docker/text-mirror-smoke.mjs`.
4. Before initial release, validate on a disposable fresh host from the exact package. Verify QMD search and source readback through the actual executor. Verify authorized provider identity, selected destination, file transfer and restore independently if claiming remote persistence. Record private receipts outside source; publish only sanitized outcomes.
5. Review Git history and npm contents for private data. Confirm package namespace, repository metadata and publisher access. Enable and verify private vulnerability reporting and required CI/review branch rules before public publication. Obtain independent review of the final commit, passing required CI, applicable QA and maintainer merge/release authorization. Merge and publication remain separate decisions. The manual [shared beta publisher](#shared-beta-publisher) does not bypass these gates or perform automatic releases.

## Shared beta publisher

`.github/workflows/publish-beta.yml` is a generated caller of the single
[core publisher](https://github.com/jdorado/ez-agents/blob/f5176f4eddbded50abf0d1bed48431c43a39bf1c/docs/trusted-publishing.md).
The reviewed latest-tag policy is merged in [core PR #44](https://github.com/jdorado/ez-agents/pull/44). Both the reusable workflow reference and `publisher-sha`
pin the same immutable core commit. To regenerate from that reviewed core checkout:

```sh
node scripts/generate-publish-caller.mjs jdorado/ez-library \
  @jc_stack/ez-library f5176f4eddbded50abf0d1bed48431c43a39bf1c \
  '["verify (22)","verify (24)","docker"]' > publish-beta.yml
```

Review the output before replacing this repository's caller. These are the
actual `.github/workflows/ci.yml` check names; update the caller through review
when required CI changes. It dispatches only on current `main`, runs on
GitHub-hosted Actions, and supports only `X.Y.Z-beta.N` on the npm `latest` tag.
The Mac performs independent review and isolated artifact tests. No test job
receives npm credentials and no package code runs in the publishing jobs.

Initial release preparation reconciles the private beta.7, beta.8 and beta.9
candidates as beta.10 with matching package/manifest versions. Before publishing,
inspect the exact packed contents, satisfy the fresh-host/provider QA above,
and verify repository protection and private reporting. Source preparation
and removal of the private flag do not establish registry delivery.

The npm package must exist before trusted-publisher enrollment. The account
owner must complete an authenticated, approved real initial beta publication
with exact artifact/registry readback; never publish a dummy version to probe
authentication. Account and trust enrollment stay with the existing installer.
Once the package exists, enroll `@jc_stack/ez-library` against owner `jdorado`,
repository `ez-library`, and caller filename `publish-beta.yml`, enabling direct
publication. npm checks the calling workflow identity for reusable workflows.
This caller uses no environment; if npm trust specifies one, review a matching
shared-workflow change first. Verify trust in the npm package's Trusted
Publishers settings; local package metadata and npm login state do not prove
that enrollment.
Do not add tokens, `NODE_AUTH_TOKEN`, or private npm profiles to Actions.

For subsequent betas, follow the pinned core publishing guide: after all release
gates and merge, wait for required push CI on the exact current `main` commit.
Stage a draft prerelease tagged `vVERSION` at that commit with `candidate.tgz`
(the exact independently tested bytes) and `release-receipt.json` binding the
repository, package, version, source SHA, SHA-256 and public review/test evidence.
Dispatch the caller with the numeric `release-id`, `version`, `source-sha` and
`artifact-sha256`; do not rebuild the candidate on Actions.

Preserve the Actions run and registry receipt, verify the downloaded tarball
hash and confirm `latest` identifies the approved version. On uncertain
publication inspect registry state before retrying; never overwrite a version
or silently repair tags. Complete and read back the GitHub prerelease only after
verified npm delivery, then verify clean-host installation/runtime as required
above. A merged caller, catalog entry or successful login proves no release.

Retain the worktree while review/QA is open. Back up the private data volume before upgrades. Schema 1 uses ordinary files plus JSON settings/operation receipts. No migration is currently needed; reject future unknown schemas. Roll back package code with the preserved compatible volume; do not delete data to solve installation or lock problems. A future state-breaking release requires an explicit migration and restore plan.

Approved beta publication updates latest automatically through the shared OIDC
publisher. No second tag write or local login is needed for enrolled packages.
The legacy beta tag is not advanced. Versions/GitHub releases remain prereleases;
stable-only deployment policies remain unchanged. Older Ez updaters need an
exact-version core update containing latest-aware discovery. This policy change
does not republish existing versions; prepare a new version for changed metadata.
