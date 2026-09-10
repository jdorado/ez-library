# Ez Library

A separate Dockerized plugin for an agent's files and QMD search. Preserve original Markdown and attachments, retrieve relevant notes, and record where the agent should persist them using its existing provider tools.

**Unreleased beta.** QMD supplies search; native rclone bisync supplies explicitly enabled folder synchronization. Existing-folder adoption, automatic indexing and guarded organization are implemented. Native Drive/Dropbox connections require separate authorization and remote QA. GitHub-only sync uses native Git and a repository-specific deploy key registered through the existing GitHub plugin. Hybrid remains an agent-owned persistence policy, not an automatic sync backend. OCR and versioned cloud backup/restore are not supplied. No relay changes are required.

See [existing-folder setup and sync policy](docs/folder-sync.md) and [GitHub-only two-way sync](docs/github-sync.md).

## Multiple libraries

Use [named libraries](docs/named-libraries.md) for independent repositories or
folders in one installation. `sources` lists names and destinations;
`source-add --name work --description 'Company documentation'` creates isolated
local state. Add `--library work` to onboarding and file commands. Once multiple
libraries exist, selection is required. `search 'query' --all` returns labelled
QMD results. Existing files remain in `default` without migration.

For Drive/Obsidian workspaces, add [GitHub text history](docs/text-mirror.md)
without moving attachments or changing the working folder.

## Requirements and installation

Use Node 22+, Docker with Compose, and an initialized agent-bound Ez plugin manager supporting deployment schema 3 with service CPU limits. The runtime is capped at 2 CPU cores and 4 GiB memory; optional shared embedding inference uses a separate 2 GiB memory ceiling, roughly 300 MB of model disk and a default half-core CPU limit. GitHub/Drive are optional, separately authorized connections.

Install a reviewed checkout or extracted package using the agent's bound `ez`:

```sh
ez plugins inspect library --source /absolute/ez-library
# Use the exact returned revision after reviewing that source.
ez plugins install library --source /absolute/ez-library --revision sha256:RETURNED_HASH
ez plugins start library
ez library --help
ez library doctor
```

Installation snapshots/builds the package without starting it. `start`, `stop`, `status` and `uninstall` are provided by `ez plugins`. Do not start a parallel standalone deployment for an installed agent. The manifest identifies plugin `library`, command `library`, and skill `skills/library/SKILL.md`.

## Default attachment intake

With the Library skill onboarded, owner-supplied attachments are saved and indexed by default, including when the owner asks only for a summary. The agent records this routing in its workspace tool instructions during onboarding. Explicit do-not-save requests override the default. This is agent guidance, not a relay upload hook.

`ez library pdf-text --path documents/example.pdf` runs bundled Poppler and emits UTF-8 text with page breaks. The agent preserves the original, saves source-linked Markdown, refreshes QMD, and verifies retrieval. Scanned PDFs require a separate OCR tool; an archived original alone is not content indexing. Provider uploads still follow the selected settings.

## First usable library

Choose local storage initially; `settings.json` here is a temporary input file in the owning workspace:

```json
{"schemaVersion":1,"storage":{"mode":"local"},"backup":{"mode":"off"}}
```

```sh
ez library configure --expected new --key setup-local-1 < settings.json
printf '# Travel checklist\n\nPassport, charger and toothbrush.\n' | ez library put --path notes/travel.md --expected new --key travel-1
ez library get --path notes/travel.md
ez library qmd collection add /state/files --name library --mask '**/*.{md,txt}'
ez library qmd search 'passport' -c library --json -n 5
ez library qmd get qmd://library/notes/travel.md
```

`get` returns the content hash and size; `get --raw` emits exact bytes, including binary attachments. Files enter on stdin, so the plugin does not mount the agent workspace or infer host file access. Readback proves local storage only. Each agent's registry provides a separate data volume; never share it across identities merely to share search.

Semantic embeddings are **off by default**. Enable them explicitly through the owning agent's host manager:

```sh
ez plugins shared-enable library embeddings
ez plugins shared-status library embeddings
ez library doctor
ez library qmd query 'vec: What should I pack for a trip?' -c library --no-rerank --json -n 5
```

The manager discovers or creates one compatible embedding worker per Docker daemon. Clients share a read-only Unix-socket mount; model weights stay in the worker's persistent volume. Each agent keeps its own files, QMD database and vectors. No public port or Docker socket is mounted in Library. Concurrent first enables converge on one named container.

Enablement returns while the worker loads its model. `doctor` reports service and private-index readiness separately. The existing resident service indexes local files once the worker is ready, then checks every 60 seconds; adopted folders refresh after sync. `qmd update` and `qmd embed --no-gpu --max-docs-per-batch 8` can request immediate refresh under the same writer lock. A busy lock means wait for its active writer. Keyword search works while semantic indexing is pending or unavailable.

Only embedding/tokenizer inference is shared. Use structured `vec:` queries with `--no-rerank`; query expansion, reranking and per-agent `qmd pull` are deliberately unavailable. There is no silent local-model fallback. The pinned QMD transport patch leaves chunking, prompt formatting, storage and retrieval in QMD; see [shared embeddings](docs/shared-embeddings.md).

`ez plugins shared-disable library embeddings` detaches this Library and preserves its files and index. Stopping or uninstalling a Library never stops or deletes the shared worker/models. Retrieval is a snapshot; `library get` checks current bytes.

## Browsable remote mirror

Drive and GitHub persistence keep ordinary files at their original relative paths: PDFs, Markdown and zero-byte files can be browsed directly. No archive or base64 bundle substitutes for the current tree. GitHub does not represent empty directories. Provider revision history remains separate from the visible current files.

For an adopted folder, the resident service runs native bisync and indexes changes. The default interval is 60 seconds after each completed cycle, so transfers and embedding add latency. For legacy provider-only settings, uploads or Git commits/pushes remain agent-owned after each save batch. Never run both writers against the same destination.

## Backup after each save

When the owner asks to enable Drive backup and sync, the onboarded agent copies the existing Library now and backs up subsequent saved originals and derived notes in their intake tasks. It preserves local primary storage and records the verified private destination. Daily schedules are not a substitute or an implicit default. Failed uploads remain pending and are reported separately from successful local saves. This guidance uses existing provider tools; it does not watch external filesystem writes.

## Persistence settings

`ez library settings` returns the current settings and revision hash. Replace settings with `configure --expected HASH --key NEW_KEY < settings.json`. Supported storage modes are `local`, `drive`, `github`, and `hybrid`. [Settings and provider handoff](docs/persistence.md) define their schema and verification boundary. `doctor` reports cloud settings as `configured-not-verified`; successful configuration is never presented as a remote save.

## File writes and recovery

`put --expected new` creates a file. Replacements require the current SHA-256 from `get`, a new operation key, and new bytes on stdin. A matching retry returns the recorded outcome only if current bytes still match. Reusing a key with different content or preconditions fails. `operation --key KEY` reports `stored`, `changed`, or `missing` from actual bytes, including after interruption. Previous content is retained in `/state/history/<sha256>`; an operator can export it from the private volume and restore through a new guarded `put`.

Maximum intake is 512 MiB per file. Hidden paths, traversal, symlinks and special files are unsupported. `move --path SOURCE --to DEST --expected HASH --key KEY` and `remove --path SOURCE --expected HASH --key KEY` preserve recovery bytes and reject stale revisions. Their operation receipts live in the plugin volume, so child tasks do not need to edit a parent workspace manifest. `list --prefix notes/ --limit 100` is bounded and reports truncation; it is not a full backup manifest. All local commands emit JSON except `get --raw`; errors use stderr. Exit codes: 2 invalid input, 3 conflict/busy, 4 unavailable/uncertain. QMD preserves its native codes.

## State, lifecycle and limits

The named `data` volume contains `/state/files`, `settings.json`, `operations`, `history`, `tmp`, and `qmd`. Private state is not encrypted at rest. Native rclone credentials belong only in `/state/sync/rclone.conf`, outside mirrored files and settings. Adopted-folder state and receipts live under `/state/sync`; extracted PDF text lives under `/state/index-text`. The service supervises enabled native sync; commands run through the manager's isolated client containers. Its health check proves the CLI loads, not search readiness or persistence.

Stop the plugin before an operator takes a volume snapshot using an existing backup tool. Preserve originals, settings, receipts and history together. QMD indexes/models are rebuildable. Uninstall removes the deployment and registry binding but preserves volumes. Account revocation is a separate action in the provider's plugin/account. See [release and rollback practices](docs/releasing.md).

An interrupted command may leave `/state/.writer-lock`, or QMD's own embed lock below `/state/qmd/cache/qmd`. Confirm no Library client/embedding command is active before removing only the stale lock. Never delete the index or originals as a lock workaround. Run `operation` to reconcile an interrupted file write. Concurrent writes directly to `/state/files` are unsupported. Edit the mapped external folder instead, or use guarded Library commands.

## Development

```sh
pnpm install --frozen-lockfile
pnpm verify
npm run release:check
docker build --target test -t ez-library-tests .
docker build --target runtime -t ez-library:local .
EZ_LIBRARY_IMAGE=ez-library:local node docker/smoke.mjs
```

CI uses synthetic files only. Real account transfer, clean-host/reboot acceptance and cloud restore must be verified separately before claiming those capabilities. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [QMD upstream](https://github.com/tobi/qmd).
