# Contributor instructions

Read CONTRIBUTING.md and docs/releasing.md before changes. One task, one branch/worktree from freshly fetched origin/main, one draft PR. Keep agent data and QA receipts outside this repository. No changes on main.

Reuse QMD and existing provider tools. No search engine, OAuth client or business workflow in this package. A single resident supervisor may invoke native rclone bisync and QMD under the Library writer lock for explicitly configured folder sync. Do not implement provider transports or conflict algorithms. The agent owns organization decisions and policy application. Provider tools own remote execution and receipts. Use Node built-ins for Library metadata; QMD owns its own index dependencies. Preserve literal argv and filter subprocess environments. One writer per state directory; fail closed on interrupted locks.

Run pnpm verify, npm run release:check, the Docker test/runtime checks and actual Ez manager smoke for packaging changes. Independent review, green required CI, applicable QA and maintainer authorization precede merge. Publication is separate. Keep worktree while PR/QA is open.
