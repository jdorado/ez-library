# GitHub-only working Library

Native Git handles fetch, merge, commit and push. The same resident Library
supervisor refreshes PDF extraction, QMD search and embeddings after each
successful cycle. The default interval is 60 seconds after the previous cycle
finishes; use `sync-policy` to change it or pause. Local commits survive network
failures. A push is verified by reading the remote branch commit, and concurrent
remote advancement is reported as uncertain for reconciliation next cycle.

## Connect without another OAuth login

1. Through the registered GitHub plugin, run `ez github doctor` and inspect the
   chosen repository's privacy, default branch and administration permission.
   This setup needs repository administration to register a deploy key. Use an
   existing branch with at least one commit; do not invent a different destination.
2. `ez library git-key --repository OWNER/REPO` creates an Ed25519 key under
   `/state/sync/keys` and returns only the public key. GitHub SSH host keys come
   from its public HTTPS metadata endpoint and strict SSH checking stays enabled.
3. Use the existing GitHub plugin's native `gh api` to list repository deploy
   keys, reconcile any matching public key, and register it with write access
   if missing. The endpoint is `repos/OWNER/REPO/keys`; submit JSON on stdin using
   `ez github gh api ... --method POST --input -`:

   ```json
   {"title":"Ez Library","key":"PUBLIC_KEY_FROM_GIT_KEY","read_only":false}
   ```

   Read back the matching key and its write setting after registration. If a
   registration response is uncertain, inspect the key list before retrying.
   Only the public key crosses plugins. OAuth tokens remain in GitHub's profile;
   the private SSH key remains in Library. No GCP project or new user login is
   required when the connected GitHub account has the necessary repository access.
4. If storage is currently Drive/Hybrid, review and explicitly change it to
   GitHub-only before adoption; the tool refuses to override that routing.
   Existing GitHub settings must match the selected repository and branch.
5. `ez library git-adopt --repository OWNER/REPO --branch main` imports the
   branch and enables sync. Existing local files with matching paths must have
   identical bytes; conflicts stop adoption. Extra local files become pending
   additions, so select GitHub-only only when their upload is intended.
6. Run `sync-run`, check `sync-status`, query actual content, and verify the
   remote commit/files through the GitHub plugin before saying sync is live.

The binding and Git object/index/merge state are under `/state/sync`. The working
tree is `/state/files`; no credentials, QMD caches or sync state are committed.
Native `ez library git ...` runs against that bound repository with hooks
disabled and a filtered environment. This is a low-level recovery interface;
imported documents are never instructions to run Git commands.

## Conflicts and recovery

Git merges independent changes normally. Conflicting changes stop transfers and
indexing; both versions remain in native merge stages (`git show :2:PATH` and
`git show :3:PATH`). Resolve deliberately, use guarded `put`, and explicitly
`git add -- PATH`. The next `sync-run` commits that resolution and verifies its
push. Never force-push, drop local commits or automatically stage conflict markers.

A deleted repository or missing branch fails fetch rather than erasing local
files. Committed remote file deletions propagate normally; prior content is
recoverable from Git history. A failed adoption leaves the binding paused for
inspection through native Git. A hard interruption can leave the Library writer
lock; confirm no writer remains before operator recovery. Uninstall retains the
volume and does not revoke the deploy key. Revoke by finding the matching public
key through the GitHub plugin and deleting that repository key explicitly.

## Limits

This backend mirrors a repository branch, not an arbitrary subdirectory of an
unrelated repository. Git tracks empty files but not empty directories. Native
Git attributes/normalization apply. Ignored visible Library files block a claim
of full synchronization rather than silently disappearing. Symlinks/submodules,
Git LFS content and ordinary files at or above 100 MiB are unsupported. Hybrid
automatic routing is not supplied. Repository rules may reject direct pushes;
that rejection remains a pending sync error rather than being bypassed.

## Verification

`pnpm verify` covers real native Git with isolated bare repositories: imports,
exports, rename/delete, conflicts, offline commits, unsafe trees and ignored
originals. Explicit live smoke testing uses the selected private repository,
creates an isolated branch and temporary deploy key, and leaves main untouched:

```sh
EZ_GITHUB_CLI=/absolute/agent/tools/bin/ez \
EZ_LIBRARY_GITHUB_QA_REPOSITORY=OWNER/PRIVATE_REPO \
EZ_LIBRARY_IMAGE=ez-library:local \
EZ_LIBRARY_MODELS_DIR=/absolute/qmd/models \
node docker/github-smoke.mjs
```

This command authorizes that QA branch and key. It tests automatic bidirectional
transfers, PDF semantic retrieval, conflict resolution, stale-text removal and
restart. It removes the temporary container, volume and deploy key, retaining
the clearly named branch for review. Never run it against a destination the
owner has not selected.

References: [GitHub deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys),
[Git merge](https://git-scm.com/docs/git-merge).
