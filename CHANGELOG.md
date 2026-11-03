# Changelog

All notable changes to Recollect. Versions are listed with the DSH host line they target.

## 0.5.0 — 2026-11-03

Supports DSH `0.2.0-rc.2` and later, including the official Desktop; CI covers `0.2.1-rc.2` and `0.2.1-rc.5`.

- Open-ended DSH engine and peer ranges so newer release candidates are not rejected by version checks; Node requirements stay unchanged.
- Per-project Claude Code memory sharing via `memory.shareProjects`, alongside global sharing. Fixed memory directories take precedence; project aliases and worktrees resolve by Git root.
- The Memory panel shows Claude Code's source directory and topic count, adds a project-sharing switch, and offers preview/confirmed imports through the Recollect Remote API. Configuration or directory changes invalidate previews.
- `/memory-import` refuses disabled memory and shared current projects, skips per-project shares in all-project mode, and imports every project when a fixed directory overrides project sharing. Successful imports refresh matching root sessions, never subagents identified only by delegation depth. New command messages are available in Chinese and English.
- Recall prefers the current model route; sandbox additional writable roots allow direct memory writes. Repository roots require a valid HEAD (a regular `ref:`/40/64-hex file or a legacy `refs/...` symlink, including unborn and packed refs) plus objects and refs directories; gitfile targets require a valid HEAD and objects/refs in their own directory or the resolved `commondir`. Common-directory records strip only the line ending, preserving legal path whitespace. Missing or broken common directories are rejected so discovery can continue at the parent. Synchronous and asynchronous discovery share the same validity policy.
- Windows exclusion matching normalizes separators in both paths and patterns, including patterns expanded through the real configuration path; tests use native paths. CI adds a Windows/Node 22/DSH rc.5 job and Linux Node 22.19.0/24 across both host versions; installation notes document Windows shell limitations.
- `renderClient()` checks the generated browser bundle in memory without writing tracked files. Added sharing, import, locale and UI regressions; existing model-facing text remains unchanged.

## 0.4.0 — 2026-10-26

Targets the same DSH versions as 0.1.0.

- A **Memory** section in the Settings dialog, next to other plugins' sections, with the same form as the Plugins page.
- **What is loaded**: for a working directory, the injected instruction files and memory index (type and size) and the memory topic files (type, description, update time), served by a read-only Remote call.
- Shorter option labels so the form fits the Settings dialog.

## 0.3.0 — 2026-10-26

Targets the same DSH versions as 0.1.0.

- Settings page in the Web UI (Plugins → Recollect → `recollect` row) for every option, in Chinese and English, built on DSH's own settings components.
- Configuration is live: changes saved on the page apply without restarting DSH.

## 0.2.0 — 2026-10-26

Targets the same DSH versions as 0.1.0.

- `/memory-import [all] [--dry-run]` copies memories that Claude Code already wrote (`~/.claude/projects/<slug>/memory/`) into Recollect's own directory. The source is only read; existing files are never overwritten (conflicts are reported); index lines are merged by link.
- `memory.shareWithClaudeCode` (off by default) makes Recollect read and write Claude Code's memory directory directly. `memory.claudeHome` (default `$CLAUDE_CONFIG_DIR` or `~/.claude`) locates it.
- The README states the compatibility scope precisely: instruction files are shared, the memory format is the same, storage is separate unless sharing is turned on.

## 0.1.0 — 2026-10-25

Targets DSH `0.2.0-rc.2` (including the official Desktop), `0.2.1-alpha.1` through `0.2.1-alpha.5`, `0.2.1-rc.1` and `0.2.1-rc.2`.

First release.

- Claude-Code-compatible instruction files: Managed, User, Project (root to cwd) and Local layers, `@import` up to depth 4, recursive `.claude/rules` and `.agents/rules`, path-conditional rules, `AGENTS.md` alongside `CLAUDE.md`, and exclusion globs.
- Persistent memory with the complete writing guidance for every model, in Chinese or English (`language`), plus a `MEMORY.md` index truncated at 200 lines / 25 000 characters with a warning.
- Refresh on resume (diff), after compaction (full) and on directory change or pause/resume. Subdirectory discovery when files are touched.
- Sandbox-aware writing: built-in `write`/`edit` when allowed, otherwise dedicated `memory_*` tools. Post-write checks for index size, recall limit, missing description and continuation files.
- Optional recall (independent BM25F with CJK support, or a model selector), background extraction, and dream consolidation with a lock. Optional per-preset agent memory.
- Commands `/memory`, `/pause-memory`, `/remember`, `/dream`.
