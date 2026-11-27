# Changelog

## 0.1.0-beta.23

- `put` and `replace` that wait out the writer lock (60 seconds, including a running sync) now fail `BUSY` as JSON on stdout with `written: false` and, while a live writer or sync holds the lock, `retryAfterSeconds`, exit 3. Nothing was written and the same `--key` can be retried. Other commands keep errors on stderr.
- `operation --key` on a Git-bound Library adds `git: { state, commit }`: `pushed` with the last remote commit that changed the path (a removal is `pushed` without a commit once the path is absent at the remote tip), `pending`, or `unknown`. Paths are read literally. It reads local Git only; no network call.
- Tests: a non-ASCII character (en dash, accents, emoji) survives `put` byte for byte, including when split across stream chunks and pipe buffers.

## 0.1.0-beta.22

- Files and directories the Library creates under `files/` (`put`, `gzip`, `replace`, `organize` destinations) are now group read/write (`0660`/`0770`) instead of `0600`/`0700`. On a host where the content directory carries a default ACL for another account (the Stocks VM grants the agent's executor `ezrelay` this way), a `0600` file or `0700` directory made the ACL mask empty, so the executor got `Permission denied` on every new or rewritten file until the ACL was repaired by hand. Others still get nothing; receipts, history, locks and other state stay `0600`/`0700`.

## 0.1.0-beta.21

- Git sync can no longer hang forever holding the writer lock. The SSH command adds `ServerAliveInterval=15` and `ServerAliveCountMax=4`, and every remote-touching Git call (fetch, push, ls-remote, in sync, text mirror and adoption) is bounded at 5 minutes: on expiry the child is stopped (SIGTERM, then SIGKILL after 5 seconds) and the cycle fails `UNAVAILABLE`, so the lock is released and the next interval retries. Before this, a connection that stalled after connect left `sync-status` at `syncing` and every writer `BUSY` until the service was restarted (#53).
- `sync/status.json` records the current `step` while a cycle runs (`fetch`, `push`, `verify`, then `mirror-read`, `mirror-fetch`, `mirror-push` and `index`); a failed Git transfer or index keeps its step, so `sync-status` shows where it stopped. A text-mirror failure is reported in `textMirror.error`, naming the failed operation.
- Requires Ez core 0.1.0-beta.50 or newer (unchanged).

## 0.1.0-beta.20

- Reclaim a writer lock left by a dead process on the same host. The lock owner now records a per-process id; a same-host lock whose pid no longer exists, or that names this process's pid without its id (a restarted container reusing pid and hostname), is removed. Reclaimers take turns under an exclusive mutex and remove the lock only if it still names the same dead owner, so concurrent callers never take over a live lock. Before this, a restarted resident worker read the dead writer's lock as its own and failed `BUSY` on every cycle until the lock was removed by hand. Locks from other hosts, locks without an owner and an unreadable owner pid still fail closed; a reclaim mutex left by a crash makes writers wait and fail `BUSY` naming it. Same hostname is taken to mean the same pid namespace (Docker's default).
- Requires Ez core 0.1.0-beta.50 or newer (unchanged).

## 0.1.0-beta.19

- Writers wait up to 60 seconds for a live holder of the Library writer lock (named in its `owner` file) instead of failing `BUSY` at once, so concurrent agent writes and the resident sync no longer fail on a brief overlap. A lock without an owner still fails closed after a one-second grace; a lock held by the same process fails at once; the resident worker stops waiting when told to stop.
- Requires Ez core 0.1.0-beta.50 or newer (unchanged).

## 0.1.0-beta.18

- Reuse unchanged file digests in the resident sync worker: inventory scans skip rereading files whose device, inode, size, mtime and ctime are unchanged, and the text mirror rewrites only changed files and skips fetch, push and verification when the remote head already matches. Idle sync cycles no longer hash every original twice per minute.
- Add explicit pull-only Git sync for read-only repository keys: fetch, verify and fast-forward, followed by the existing indexing path, without staging, committing or pushing.
- Preserve and refuse local changes and non-fast-forward history. Existing Git bindings can switch with revision-guarded sync policy; two-way sync is unchanged.
- Reconcile existing checkout tracking refs with native Git's fetch/push updates, retaining the revision guard for unexpected changes.
- Includes the beta.17 scope below, which was never published to npm.

## 0.1.0-beta.17

- Add guarded in-Library gzip and scoped literal section/text updates, preserving originals, revision guards, operation receipts and the single writer.
- Retain the beta.16 Dockerfile and shared embedding implementation so existing shared-worker deployments remain compatible. The container build-policy upgrade remains separate.
- Add a representative manifest example for tool discovery; state and deployment schemas remain unchanged.
- Requires Ez core 0.1.0-beta.50 or newer for the manifest example.
  Older cores refuse the update and retain the installed version.

## 0.1.0-beta.16

- Preserve atomic Library intake when originals use a separate filesystem mount.
- Read large originals through revision-checked, binary-safe bounded ranges with
  source and chunk hashes, contiguous offsets and EOF metadata.
- Existing raw reads, guarded writes, data schema and deployment layout remain
  compatible.

## 0.1.0-beta.15

- Declare the full Library command's external-content, outbound, record-change
  and review exposure contract, and validate command exposure metadata during
  release checks.

## 0.1.0-beta.14

- Sync existing Git checkouts and normalize text-mirror destinations without
  renaming stored originals. Preserve native provider synchronization boundaries.
- Keep channel search read-only during writes and expose approved original-file
  readback. Sharing requests prefer the stored original over a derived export.

- Add a dedicated `library-query` alias that forces read-only Library search and
  declares the bounded channel-query exposure required by core public-channel
  grants. The existing full Library CLI remains owner-only.

## 0.1.0-beta.13

- Respect Git ignore rules during sync: ignored caches remain local without blocking valid files. Preserve merge-conflict and overwrite protections.

## 0.1.0-beta.12

- Prepare a new release with npm publishing-settings verification included. Package trust and registry delivery are verified separately from local release checks.

## 0.1.0-beta.11

- Prepare the initial public release with the corrected shared publisher. Include reviewed named libraries, Git text history and shared embedding support; requires schema-3-capable core beta.15 or newer.
- Testing beta; previously documented live-provider and fresh-host acceptance limits remain.

## 0.1.0-beta.10

- Opt-in shared embedding worker, capped at half a CPU core, with private per-agent indexes.
- Schema-3 manager support is required. Migration preserves the existing Library volume and compatible QMD vectors; deployment layout changes require explicit installation migration.

- Add one-way GitHub text history after successful folder sync, preserving Drive as the editable workspace.

- Respect global and per-library keyword-only indexing settings while keeping embeddings off until shared-worker enablement.
- Reject local Git sources inside any Library state, including symlink aliases.
- Add isolated named libraries, explicit command selection, source inventory and labelled cross-library QMD keyword search. Preserve existing state as default.

## 0.1.0-beta.6 — unreleased

- Add native GitHub-only two-way sync, remote commit verification and automatic QMD/PDF refresh.
- Bootstrap repository-specific SSH deploy keys through an already connected GitHub plugin; keep OAuth credentials in that provider.
- Retain native Git merge stages and pause on conflicts, unsupported trees, ignored originals or changed storage policy.
- Add isolated-branch live GitHub smoke coverage; existing Hybrid settings remain unchanged.

## 0.1.0-beta.5 — unreleased

- Adopt an existing folder with native rclone bisync, persistent binding/receipts, conflicts preserved and deletion safeguards.
- Supervise enabled sync every 60 seconds and refresh PDF extraction, QMD search and embeddings after changes.
- Add revision-guarded move/remove operations for agent organization, with recovery bytes and task-accessible receipts.
- Keep native connection consent explicit; GitHub/Hybrid automatic synchronization and OCR remain unsupported.

## 0.1.0-beta.4 — unreleased

- Default remote persistence to browsable ordinary files and stable paths, never archive workarounds.
- Clarify immediate save-batch mirroring, conflict preservation and the boundary to native continuous/two-way sync engines.

## 0.1.0-beta.3 — unreleased

- Interpret enabled provider backup as initial sync plus backup after each agent save; do not invent daily schedules.
- Document durable pending transfers, destination reuse and workspace routing for future intake.

## 0.1.0-beta.2 — unreleased

- Default owner attachment intake to preservation and verified indexing through the agent skill.
- Bundle native Poppler PDF text extraction with source/page-linked derived notes.

## 0.1.0-beta.1 — unreleased

- Introduce a separate Dockerized Library CLI and native QMD 2.8.3 command access.
- Store files with revision preconditions, operation keys, exact readback and local previous revisions.
- Add explicit Local, Drive, GitHub and Hybrid persistence settings, independently configured external backup intent.
- Package agent instructions for provider-owned persistence. Remote transfers, background sync, OCR and cloud restore verification are not implemented by this plugin.
