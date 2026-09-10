# Existing folders as working libraries

Folder sync is opt-in. Installation and legacy `configure` do not start it.
Use a selected existing folder, retaining its hierarchy and ordinary file bytes.
The container must have its own authorized native rclone profile; a Composio
connection is not that profile. Never export another plugin's credentials.

## Setup

1. Configure the native connection using `ez library rclone config` (or native
   non-interactive configuration for a headless runtime). The profile belongs in
   `/state/sync/rclone.conf`, outside the mirrored tree. Follow the upstream
   [remote setup](https://rclone.org/remote_setup/) and
   [Drive authorization](https://rclone.org/drive/#making-your-own-client-id).
   Drive now requires an application's own client ID for reliable continued
   use; its shared client is being retired. Do not put credentials in Library
   settings, notes, tool output logs or a Git repository.
2. Select a visible folder path under an account-root Drive/Dropbox profile:
   `ez library sync-plan --remote 'personal:My Library'`. This inventories the
   remote and checks any existing local files. It does not change either tree.
   A local absolute directory is also supported when already accessible inside
   the runtime; this package does not add arbitrary writable host mounts.
3. `ez library sync-adopt --remote 'personal:My Library'` imports and verifies
   originals, initializes native bisync once and enables the resident service.
   Every existing local file must already match the remote; differing or extra
   local files stop adoption. Preserve/reconcile them before retrying. Do not
   delete local data to get past this check.
4. `ez library sync-run` reconciles now and refreshes search. `sync-status`
   distinguishes transfer, extraction, indexing, embeddings and conflicts.
   Verify an actual query and original readback before reporting completion.

The small visible `LIBRARY_SYNC_ACCESS` file protects the mapping. Removing it,
the root folder, or changing folder identity blocks further transfers. Drive
bindings use visible paths from the account root, not a hidden root-folder-ID
override; duplicate paths are rejected during adoption. Shared Drive profiles,
Google-native documents, Drive shortcuts and hidden paths are excluded or
unsupported. This is not a full-fidelity Obsidian settings migration.

## Policy and cadence

The default is `two-way`, every 60 seconds **after the preceding cycle finishes**.
Transfers, model startup and indexing add time. This is polling, not a push
notification guarantee. The service must be running. No scheduled LLM job is
created. `sync-run` starts a cycle immediately when the writer is free.

Read the revision from `sync-status`, then use
`sync-policy --expected HASH --mode paused` to pause, or `--mode two-way
--interval 60` to resume/change the interval (30–3600 seconds). Paused stops
remote transfers and automatic indexing; it does not make local files read-only.
Organization is independent agent policy. Use guarded `move`, `remove` and
`put`, and let the sync engine propagate the resulting changes.

Once bound, disable manual Composio mirroring to this same folder. Do not run
two transport writers or keep a second parent-workspace mirror manifest. Native
bisync listings and Library status live under `/state/sync`, accessible through
the plugin from both main and child tasks. GitHub-only sync has a separate [native Git binding](github-sync.md). Hybrid
persistence continues through the agent's provider tools; automatic Hybrid sync
is not implemented.

## Conflicts, indexing and recovery

Native rclone bisync preserves both versions of a simultaneous edit with
conflict suffixes. Status surfaces their paths for agent/owner resolution.
These suffixed copies are retained but may not match QMD's text masks until
resolved. Native bulk-deletion and missing-access checks pause unsafe cycles;
large folder reorganizations can also trigger them. Never automatically force
a sync, reset its baseline or choose a conflict winner. Rclone retains its own
recovery listings. Replaced/deleted local bytes are retained under
`/state/sync/history`; remote version/trash behavior belongs to the provider.
This is a live copy, not a separately verified versioned backup.

Markdown/TXT are indexed from `/state/files`. Changed PDFs are extracted with
Poppler into `/state/index-text`, with original paths, SHA-256 and page labels;
QMD indexes that cache as `library-pdf`. This avoids overwriting authored notes.
Source deletion/replacement updates or removes cached text. Scans without text
are reported as `ocr-required`; image/video content needs separate vision or
transcription. Originals are still synchronized. QMD vectors and models remain
private/rebuildable, outside the external working folder.

All mutations and QMD refresh share the Library writer lock. A busy command
must wait/retry later, not remove an active lock. Abrupt shutdown can leave a
lock requiring an operator to verify no writer remains. An interrupted adoption
stays paused; inspect both trees and native state before an explicit dry-run
recovery. The recurring service never runs `--resync`. Transient failures keep
their error status and retry on the next cycle; a successful connection or
container health check is not proof of freshness.

## Verification

`docker build --target test` exercises native adoption and missing-root guards
with synthetic local folders. The runtime suite also verifies live polling,
conflict preservation, rename/delete, PDF text replacement and keyword search. Supply `EZ_LIBRARY_EMBED_IPC` with a running test worker IPC volume to include semantic search:

```sh
EZ_LIBRARY_IMAGE=ez-library:local node docker/sync-smoke.mjs
```

The suite has no cloud credentials or network. Native Drive/Dropbox consent,
folder identity, real remote mutations and reconnect must additionally pass
provider QA before claiming a live cloud binding.
