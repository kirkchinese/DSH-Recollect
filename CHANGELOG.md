# Changelog

All notable changes to Recollect. Versions are listed with the DSH host line they target.

## 0.1.0 — 2026-10-25

Targets DSH `0.2.0-rc.2` (including the official Desktop), `0.2.1-alpha.1` through `0.2.1-alpha.5`, `0.2.1-rc.1` and `0.2.1-rc.2`.

First release.

- Claude-Code-compatible instruction files: Managed, User, Project (root to cwd) and Local layers, `@import` up to depth 4, recursive `.claude/rules` and `.agents/rules`, path-conditional rules, `AGENTS.md` alongside `CLAUDE.md`, and exclusion globs.
- Persistent memory with the complete writing guidance for every model, in Chinese or English (`language`), plus a `MEMORY.md` index truncated at 200 lines / 25 000 characters with a warning.
- Refresh on resume (diff), after compaction (full) and on directory change or pause/resume. Subdirectory discovery when files are touched.
- Sandbox-aware writing: built-in `write`/`edit` when allowed, otherwise dedicated `memory_*` tools. Post-write checks for index size, recall limit, missing description and continuation files.
- Optional recall (independent BM25F with CJK support, or a model selector), background extraction, and dream consolidation with a lock. Optional per-preset agent memory.
- Commands `/memory`, `/pause-memory`, `/remember`, `/dream`.
