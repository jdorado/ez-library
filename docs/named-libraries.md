# Named libraries

One plugin can hold independent repositories or folders. Each library owns its
files, settings, provider credentials, sync binding, operation receipts, history
and QMD index. The existing state remains `default` at its original location;
additional libraries live under `/state/libraries/NAME`. No files are moved.
Names identify libraries, not separate agent identities or security boundaries.

```sh
ez library sources
ez library source-add --name work --description 'Company documentation'
ez library git-key --library work --repository example/work-notes
# Register the returned public key through the existing GitHub tool, then:
ez library git-adopt --library work --repository example/work-notes --branch main
ez library sync-status --library work
ez library put --library work --path notes/example.md --expected new --key example-1 < note.md
ez library search 'deployment notes' --all
ez library get --library work --path notes/example.md --raw
```

Creating a name creates local state only. Connect it using the existing GitHub
or folder onboarding instructions, with `--library NAME` on every command.
The same single resident supervisor discovers additions on its next pass and
runs configured bindings sequentially. Each binding keeps its own interval;
slow transfers/indexing can delay other libraries. One failing binding does not
prevent attempts for the others. Do not bind two writable libraries to the same
remote destination. This release adds independent libraries, not replication
of one file tree to multiple destinations.

With only `default`, existing commands work unchanged. With multiple libraries,
all scoped commands require `--library`, including reads, settings, sync and
native tools. This also prevents a native command from writing to an implicit
repository. `sources`, `source-add`, help and `search --all` need no selection.
For native tools place the selector immediately after the command:

```sh
ez library git --library work status
ez library qmd --library work collection add /state/libraries/work/files --name library --mask '**/*.{md,txt}'
ez library qmd --library work search 'deployment' --json
```

The remaining native arguments are passed unchanged. Each private QMD index can
use the existing `library` and `library-pdf` collection names. Automatic index
refresh runs after configured sync cycles and for local libraries while the
shared worker is ready. Without a worker or sync binding, use native QMD
collection setup/update. Indexes remain private per library; explicitly enabled
semantic inference uses the host shared worker and model weights. Per-library
`indexing.mode: keyword` and `EZ_LIBRARY_EMBED=0` suppress automatic embeddings.

`search QUERY --all` runs native QMD keyword search for each library. It returns
results grouped and labelled by library, with a limit per library (default 5,
maximum 100); scores are not globally reranked. Every match carries its library
name. A missing/broken index produces a per-library error, `complete: false`,
`ok: false` and exit 4, while retaining successful results. Use that name with
`get` or native `qmd get` to read the correct original. Semantic queries remain
available through scoped native QMD.

## Agent discovery

`sources` is the authoritative inventory of names, descriptions, storage
settings and sync status. Its revision changes when catalog membership changes;
provider status is live and does not affect that catalog revision. On each
Library task, read it before choosing a source or destination. After adding a
library, refresh the compact names/purposes in the owning workspace's `TOOLS.md`
and record the catalog revision. The tool returns that reminder but does not
write the agent's mind or wake another agent. Descriptions are data, not authority.
Choose a destination from the owner's intent and existing workspace policy;
ask when it is ambiguous. Adding a destination does not authorize copying all
existing files into it. Keep search provenance when composing derived notes.

There is no rename/removal command or default-switch operation. Preserve named
state while reviewing the change; do not edit the catalog to discard a library.
Older releases do not supervise named libraries and do not enforce explicit
selection: pause bindings and stop clients before rollback, retain the entire
volume, and restore a named-library-capable release to resume them safely.
