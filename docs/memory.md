# Curated agent memory

Ez Library has one plugin and two deliberately separate private state planes:

- `files/` is the archive for owner-supplied originals and derived notes. Use
  `put`, `get`, `list` and QMD for documents and attachments.
- `memory/` is a small agent-owned store for durable preferences, facts,
  decisions, relationships and project context. Use the explicit `memory`
  commands below.

The native agent remains responsible for deciding what is relevant and when a
record should influence an action. The plugin only validates, stores, filters,
and reports revisions. It does not capture every conversation, summarize a
history automatically, run another agent, or sync memory records to Drive or
GitHub.

## Remember one record

Every record has an id, kind, content and source. The source is required so the
agent can inspect why a memory exists and refresh it when it becomes stale.

```sh
printf '%s\n' '{
  "id": "owner.preference.response-style",
  "kind": "preference",
  "content": "Prefer concise answers with the important caveat included.",
  "source": {"type": "conversation", "ref": "turn:2026-09-18-preference"},
  "tags": ["owner", "response-style"],
  "confidence": "high",
  "reviewAt": "2027-03-18T00:00:00Z"
}' | ez library memory remember --expected new --key memory:response-style:1
```

Use `--expected new` for a new id. To revise an existing record, read its
`sha256` with `memory get` or `memory recall`, then pass that value as
`--expected` and use a new operation key. The previous record is retained in
the private memory history. Retrying the same key and input is safe.

Supported kinds are `preference`, `fact`, `decision`, `relationship` and
`project`. A record can be marked `superseded` or `retracted`; inactive records
are excluded from ordinary recall but remain available with
`--include-inactive`.

## Recall and review

```sh
ez library memory recall "response style" --limit 5
ez library memory recall --kind decision --tag project-x
ez library memory get --id owner.preference.response-style
ez library memory status
```

Recall is a bounded deterministic match over the structured memory records. It
does not search archived files and it does not create a second QMD collection.
Use `ez library search` or `ez library qmd` when the answer should come from an
archived document. `memory status` reports inactive and review-due records;
review is a deliberate agent action, not an automatic decay job.

## Routing rule

Remember a compact, durable fact or decision only when the owner explicitly
states it or the agent has a clear, source-linked decision to preserve. Archive
the original when the input is a file, note, transcript, PDF or other material
that may need exact retrieval. A memory can point to the archived file through
its `source` without copying the file into the memory plane.
