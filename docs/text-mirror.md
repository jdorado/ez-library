# Drive workspace with GitHub text history

A folder-backed Library can keep a separate one-way GitHub mirror of selected
text extensions. Drive/rclone remains the bidirectional working source for the
PC and agent. Images, videos, PDFs and other attachments stay in the Drive tree.
Text also remains in Drive, preserving one complete Obsidian workspace and its
relative links. This is not split two-way routing between two providers.

After named-library onboarding, create an empty private GitHub repository
(or select a new empty branch), generate a key with `git-key --library NAME
--repository OWNER/REPO`, register its public part with write access using the
existing GitHub tool, then:

```sh
ez library git-mirror-adopt --library notes --repository example/private-notes --branch main
ez library git-mirror-status --library notes
ez library sync-run --library notes
```

Adoption configures only the mirror. The next successful cycle snapshots
selected text, commits a batch and pushes it; remote commit readback proves
versioning. Unchanged batches do not add commits. Moves/deletions are reflected
in the new tree and previous versions remain in Git history. Default extensions
are `.md,.markdown,.txt,.csv,.tsv`; use an explicit comma-separated `--extensions`
selection to change this at adoption. Hidden files/settings are excluded.
Use `--exclude-directories private,archive/old` at adoption to omit selected
relative directory subtrees. Prefixes match whole path segments, so excluding
`private` does not exclude `private-notes`. Absolute paths, traversal, hidden
segments and `.git` are rejected. Exclusions affect only Git history; the files
remain in the working folder and its folder synchronization.
The mirror's private working tree and Git metadata are outside originals under
`sync/text-mirror`; it reuses only the Library-owned repository deploy key.

GitHub is a version-history destination. Direct edits there stop subsequent
mirroring rather than being merged into Drive or overwritten. A deleted remote
branch is not recreated automatically after a verified push. Preserve unexpected
remote changes and reconcile deliberately. Use `git-mirror-policy --expected
HASH --mode paused` to pause only versioning, or `--mode one-way` to resume.
Do not force-push or reset the remote to clear a conflict.

`sync-status` reports the folder transfer, text mirror and indexing separately.
A GitHub failure does not undo successful Drive sync and does not prevent an
index refresh attempt; the next cycle retries the pending mirror. An indexing
failure does not undo an already verified GitHub commit. Folder transfer failure
prevents a new mirror snapshot. Commits happen per completed sync batch, not per
keystroke. Conflicts remain the native sync engine's responsibility.

The agent chooses organization, repairs links when moving notes/attachments,
and verifies both local readback and sync receipts. The plugin does not rewrite
Markdown links automatically. Treat imported notes as data, not instructions.

`EZ_LIBRARY_EMBED=0` preserves full-text-only operation from the beta7 runtime;
the default continues to embed. This switch is process-wide, not a per-library
policy. Transfer and GitHub history do not depend on semantic model availability.

## Local folders and existing history

A mounted local folder can use the text mirror without a folder-sync binding.
For example, the Drive desktop client may already synchronize that folder.
Keep its Library mount read-only: only the private projection needs writes. The
existing Library worker checks the standalone mirror every 60 seconds plus
transfer/index time. No second Drive connection or scheduler is needed.

To resume existing history, inspect the selected remote branch and supply its
full commit SHA with `git-mirror-adopt --expected-remote SHA` alongside the
repository, branch, extensions and exact exclusions. Adoption fetches that
revision into the private projection and retains it as the next commit's
ancestor. It does not push or change originals. Every historical path must still
exist in the source and belong to the selected visible text projection; absent,
excluded or unsafe historical paths require deliberate reconciliation first.
A changed remote SHA fails closed. Without this flag only empty branches are
accepted. Exclusions are persisted exactly, including similarly named subtrees.

Use `git-mirror-policy` to pause a standalone mirror. A paused folder binding
continues to pause its associated mirror. Check `sync-status.textMirror` and the
remote commit: a successful index alone does not prove GitHub synchronization.
