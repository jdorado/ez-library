# Ez Library

A separate Dockerized plugin for an agent's files and QMD search. Preserve original Markdown and attachments, retrieve relevant notes, and record where the agent should persist them using its existing provider tools.

**Unreleased beta.** Local file operations and persistence settings are implemented. QMD is the search engine. This package does not upload to GitHub/Drive, run background synchronization, OCR media, or verify cloud backups. Those operations remain with the agent and its selected tools. No changes to the relay are required.

## Requirements and installation

Use Node 22+, Docker with Compose, and an initialized agent-bound Ez plugin manager supporting deployment schema 2. The runtime has a 4 GiB memory ceiling; semantic models additionally need roughly 2.1 GB disk and CPU time. GitHub/Drive are optional, separately authorized connections.

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

For semantic search, explicitly download models and embed:

```sh
ez library qmd pull
ez library qmd embed --no-gpu --max-docs-per-batch 8
ez library qmd query 'vec: What should I pack for a trip?' -c library --no-rerank --json -n 5
```

These are upstream QMD commands, passed as literal argv with its native output and exit codes. Structured `vec:` queries with `--no-rerank` avoid the CPU expense of local query expansion/reranking. QMD `vsearch` also performs expansion. Run `qmd update`, then `qmd embed` when needed after file changes; intake does not schedule indexing. QMD models/indexes live separately from originals in the private volume. Retrieval is a snapshot; `library get` checks current bytes.

## Browsable remote mirror

Drive and GitHub persistence keep ordinary files at their original relative paths: PDFs, Markdown and zero-byte files can be browsed directly. No archive or base64 bundle substitutes for the current tree. GitHub does not represent empty directories. Provider revision history remains separate from the visible current files.

Native provider uploads/updates or Git commits/pushes happen immediately after agent save batches. This is not a continuously running filesystem watcher. True unattended or bidirectional sync should reuse an established sync engine with a verified connection and conflict policy; the Library relay does not supply one.

## Backup after each save

When the owner asks to enable Drive backup and sync, the onboarded agent copies the existing Library now and backs up subsequent saved originals and derived notes in their intake tasks. It preserves local primary storage and records the verified private destination. Daily schedules are not a substitute or an implicit default. Failed uploads remain pending and are reported separately from successful local saves. This guidance uses existing provider tools; it does not watch external filesystem writes.

## Persistence settings

`ez library settings` returns the current settings and revision hash. Replace settings with `configure --expected HASH --key NEW_KEY < settings.json`. Supported storage modes are `local`, `drive`, `github`, and `hybrid`. [Settings and provider handoff](docs/persistence.md) define their schema and verification boundary. `doctor` reports cloud settings as `configured-not-verified`; successful configuration is never presented as a remote save.

## File writes and recovery

`put --expected new` creates a file. Replacements require the current SHA-256 from `get`, a new operation key, and new bytes on stdin. A matching retry returns the recorded outcome only if current bytes still match. Reusing a key with different content or preconditions fails. `operation --key KEY` reports `stored`, `changed`, or `missing` from actual bytes, including after interruption. Previous content is retained in `/state/history/<sha256>`; an operator can export it from the private volume and restore through a new guarded `put`.

Maximum intake is 512 MiB per file. Hidden paths, traversal, symlinks and special files are unsupported. There is no rename/delete API. `list --prefix notes/ --limit 100` is bounded and reports truncation; it is not a full backup manifest. All local commands emit JSON except `get --raw`; errors use stderr. Exit codes: 2 invalid input, 3 conflict/busy, 4 unavailable/uncertain. QMD preserves its native codes.

## State, lifecycle and limits

The named `data` volume contains `/state/files`, `settings.json`, `operations`, `history`, `tmp`, and `qmd`. Private state is not encrypted at rest. No provider secrets belong there. The service is a small resident lifecycle target; commands run through the manager's isolated client containers. Its health check proves the CLI loads, not search readiness or persistence.

Stop the plugin before an operator takes a volume snapshot using an existing backup tool. Preserve originals, settings, receipts and history together. QMD indexes/models are rebuildable. Uninstall removes the deployment and registry binding but preserves volumes. Account revocation is a separate action in the provider's plugin/account. See [release and rollback practices](docs/releasing.md).

An interrupted command may leave `/state/.writer-lock`, or QMD's own embed lock below `/state/qmd/cache/qmd`. Confirm no Library client/embedding command is active before removing only the stale lock. Never delete the index or originals as a lock workaround. Run `operation` to reconcile an interrupted file write. A concurrent non-plugin writer is unsupported.

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
