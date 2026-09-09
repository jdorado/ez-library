# Persistence policy and provider handoff

Settings are agent-readable policy. Applying them is agent-owned work through existing provider tools. Legacy settings do not start synchronization. The separate [folder binding](folder-sync.md) enables native rclone bisync; it is authoritative when present, and the agent must stop manual uploads to that same destination. GitHub-only settings can be activated through the separate [Git binding](github-sync.md); Hybrid settings do not activate native sync. The default is local storage with backup off. Setting a mode does not move existing files or authorize publication outside the selected library.

Example Hybrid settings (replace the example account and destination references):

```json
{
  "schemaVersion": 1,
  "storage": {
    "mode": "hybrid",
    "github": {"connection": "github-personal", "repository": "example/private-library", "branch": "main"},
    "drive": {"connection": "drive-personal", "folderId": "selected-folder-id"},
    "githubExtensions": [".md", ".txt", ".csv", ".json", ".pdf", ".docx"],
    "maxGithubBytes": 10485760
  },
  "backup": {"mode": "off"}
}
```

For `github` or `drive`, supply only the matching destination and omit the two routing fields. For `local`, supply only `mode`. Account references are opaque identifiers for already available tools; they are not OAuth tokens. Unknown fields are rejected. Hybrid requires explicit lowercase extensions and a ceiling below GitHub's ordinary 100 MiB per-file limit. The 10 MiB example is a conservative policy choice, not a provider limit. File type rules use the intended format, not permission to publish a file merely because its extension matches. PDF and DOCX are binary formats whose revisions can grow Git history.

The agent interprets Hybrid as selected extensions below the ceiling going to the chosen private GitHub repository; images, audio, video and remaining attachments go to the selected Drive folder. First verify access, account and destination identity using that provider's tools. Persisting to GitHub includes push and remote commit readback, not only a local commit. A Drive connection through Composio provides individual upload/update/download/change tools, not automatic folder synchronization. A Gmail connection is not proof of Drive access. Never copy provider credentials into a different transfer utility.

Maintain a portable manifest alongside authored notes when persisting: logical relative path, content hash, size, destination and remote object ID/revision (or Git commit and path). Export current bytes using `get --raw`, verify the provider result against those bytes, and record provenance as evidence. Library does not attest externally supplied receipts. Git and Drive cannot be committed atomically together: report partial persistence honestly, read back uncertain operations, and use provider idempotency/reconciliation to avoid duplicate uploads. No blind retries or default remote deletions. QMD indexes and model downloads do not belong in publication.

Hybrid distributes files across providers; it does not duplicate each file. Independently configure backup intent as either `{"mode":"off"}` or `{"mode":"external","connection":"backup-tool-profile","destination":"selected-backup-destination"}`. An existing tool must actually create versioned backups and demonstrate restore; these settings install or schedule nothing. Recover both storage destinations into a clean directory, reconstruct relative paths/attachment links, and compare content hashes before claiming full recovery.

## Browsable mirror and timing

Remote persistence defaults to ordinary files at matching relative paths, not an archive, base64 container or encrypted bundle. Preserve zero-byte files. Drive folders are real folders; GitHub stores ordinary files and history, but Git does not track empty directories. Preserve any previous archive separately during migration rather than treating it as the live tree.

Use recorded Drive IDs for in-place updates and commit/push GitHub save batches. Cloud edits that diverge from the last verified content are conflicts, not permission to overwrite. A verified two-way import/delete policy is separate from the default Library-to-provider mirror. Native Composio file staging can supply binary references to its Drive upload/update tools without exposing credentials.

Cadence is immediately after each completed agent save batch. This agent workflow is not an autonomous watcher, and no bounded latency or offline recovery guarantee is claimed. For unattended continuous/bidirectional synchronization, use an established engine such as rclone or an appropriate provider client with a separately verified binding and conflict policy. Composio and Git operations alone do not provide that service. Do not emulate it with a scheduled LLM loop.

## Initial copy and failures

An owner request to enable provider backup and sync authorizes an initial copy now and backup of subsequent agent saves within their intake/update tasks. Keep primary storage unchanged. The agent creates/reuses the requested private destination, verifies it, configures external backup and records the after-save policy in workspace tool instructions. No invented daily schedule or delay; a requested reconciliation schedule is additional protection.

For each changed original or derived note, preserve remote versions and relative paths, verify provider readback, and checkpoint hashes and remote IDs in the portable manifest. Skip verified unchanged content. Failed transfers stay pending with local originals preserved; report the gap rather than “synced.” This is agent-owned execution, not a background filesystem watcher. Writes outside this intake require explicit reconciliation. Connection alone activates neither behavior.

References:
- https://docs.composio.dev/toolkits/googledrive
- https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github
