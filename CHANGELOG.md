# Changelog

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
