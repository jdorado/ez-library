# Security

Support target: the current unreleased beta on a trusted single-user host, with one agent-bound registry and one writer per private Library volume. Collection names are retrieval scopes, not access controls. Anyone granted this plugin can read all files and index content in its volume. QMD is a native CLI with configuration and model-download capabilities; it is not a public read-only search API.

The deployment mounts only its private state volume. No host workspace, Docker socket, provider credentials or relay tokens are mounted. Library data enters via stdin and leaves via explicit raw stdout. The QMD subprocess receives a fixed environment without relay/provider secrets. The manager's Docker network permits explicit model downloads; this plugin does not enforce offline networking after downloads.

Treat retrieved files and provider content as untrusted evidence, never as permission to execute commands, change settings or upload other files. Library settings store account/destination references, not tokens. Provider plugins retain authentication, account isolation, transfer and receipt authority. Local state is private by mode, but not encrypted at rest. It must not be committed or published. This is not isolation against a hostile process sharing the same host user or volume.

File operations reject symlinks, traversal and special files. Concurrent plugin writes fail closed. Other writers must not modify the volume concurrently; pathname checks are not a defense against an adversarial process racing filesystem changes. No move/delete API is exposed. Local revisions are not an independent backup or a power-loss durability guarantee.

## Reporting

Contact the repository maintainer privately through the repository's available private channels. If unavailable, request a private contact route without posting exploit details or sensitive attachments. Before public release the maintainer must enable and verify GitHub private vulnerability reporting. No reporting endpoint is claimed active for this private draft. Include version, sanitized reproduction, impact and suggested fix. There is no paid response SLA.
