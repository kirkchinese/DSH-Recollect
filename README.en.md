# Recollect

[中文](README.md) · [npm](https://www.npmjs.com/package/@kirkchinese/dsh-recollect) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/kirkchinese/DSH-Recollect/issues) · Sibling project: [CiteCiter](https://github.com/kirkchinese/CiteCiter)

![Recollect](assets/hero/recollect-hero.png)

**Switch models and keep your memory.**

Recollect is a plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) that provides a **Claude-Code-compatible memory system**. It follows Claude Code's conventions: layered `CLAUDE.md` files, `@import`, `.claude/rules`, and a persistent memory with `MEMORY.md` as its index. Every model (DeepSeek, GPT, Qwen, Claude, …) gets the same complete memory guidance, with no downgrade for models outside a vendor's own catalog.

## Why

In Claude Code, the memory-writing guidance depends on the model. Models outside its catalog get a short version that drops the long-term duty, the "save immediately when asked" rule and all examples, so they rarely write memories on their own. Recollect gives every model guidance written independently for this project (in Chinese and English) together with the same file conventions, so that any model:

- **records** who the user is, feedback on how they want work done, project context and pointers to external resources, at the right moments;
- sees the memory index in each new session and reads or recalls memory bodies when relevant;
- verifies a memory before recommending from it, because memories go stale.

Your existing `CLAUDE.md`, `CLAUDE.local.md` and `.claude/rules/` work unchanged, and `AGENTS.md` is read as well.

## Install

| DSH version | Recollect version |
| --- | --- |
| `0.2.0-rc.2` (including the official Desktop), `0.2.1-alpha.1` to `0.2.1-alpha.5`, `0.2.1-rc.1`, `0.2.1-rc.2` | `0.1.0` |

**Official Desktop:** on the Plugins page, install the npm package `@kirkchinese/dsh-recollect`, or enter `https://github.com/kirkchinese/DSH-Recollect.git` as the Git address, then restart when prompted.

**CLI and Web:**

```sh
dsh plugin --profile web add @kirkchinese/dsh-recollect@0.1.0
# or a release tag from the repository
dsh plugin --profile web add "git+https://github.com/kirkchinese/DSH-Recollect.git#v0.1.0"
```

Restart DSH and reload the page. New sessions use Recollect. It takes over instruction-file loading and filters out what DSH's built-in AGENTS.md loader injects, so no file is loaded twice.

## What it does

| Feature | Default | Notes |
| --- | --- | --- |
| Instruction files | on | Loaded in this order: organization policy (`/etc/claude-code`); the user level (`~/.claude/CLAUDE.md`, `~/.dsh/AGENTS.md`, `~/.agents/AGENTS.md`, `~/.claude/rules`); then every directory from `/` down to the working directory (`CLAUDE.md`/`AGENTS.md` with `@import` expanded in place up to 4 levels, then `.claude/CLAUDE.md`, then rules as recursive `.md` files, then `CLAUDE.local.md`/`AGENTS.local.md`). All files are concatenated without truncation; a single file over 4 MiB is skipped |
| Persistent memory | on | The system prompt carries the full writing guidance: four types, what not to save, the two-step save procedure, and access and verification rules. The first message carries the `MEMORY.md` index, truncated with a warning beyond 200 lines or 25 000 characters |
| Refresh | on | On resume only changed files are shown. When compaction summarizes the instructions away, they are re-injected in full. Directory changes and pause/resume also refresh them |
| Subdirectory discovery | on | Touching a file in a subdirectory injects that directory's instruction files and any rule whose `paths:` frontmatter matches the file |
| Write checks | on | Right after a memory write, the model is warned about an oversized index, a file over the recall limit, a missing `description`, or `-2` continuation files |
| Recall | off | Up to 5 relevant memory bodies per question. `bm25` searches locally (Chinese, English, Japanese and Korean); `selector` uses one model call |
| Background extraction | off | After each turn, a forked helper saves what the main conversation missed. It can only write inside the memory directory |
| Consolidation (dream) | off | Merges, fixes and prunes the memory directory after 24 h and 5 sessions; `/dream` runs it on demand |
| Agent memory | off | Per-preset memory with `user`, `project` or `local` scope |

Memories live in `~/.dsh/memory/projects/<slug of the git root>/`, shared by all subdirectories and worktrees of a repository.

**Writes adapt to the sandbox.** When the sandbox allows writing the memory directory, the model uses the built-in `write`/`edit`. When it does not (for example `workspace-write`, where the directory is outside the workspace), Recollect mounts `memory_list/read/write/edit/delete` and switches the guidance to match. These tools write only `.md` files inside the memory directory and refuse secrets. Nothing is written in a read-only sandbox.

## Commands

| Command | Purpose |
| --- | --- |
| `/memory` | Memory status, write mode, and every loaded instruction and memory file |
| `/pause-memory` | Pause or resume memory for this session (kept across restarts) |
| `/remember <text>` | Ask the model to save `text` to memory |
| `/dream` | Consolidate this project's memory now (requires dream to be enabled) |

## Configuration

Override in your profile's `cordis.patch.yml`. An override replaces the whole config object; omitted fields keep their defaults.

```yaml
- id: recollect
  name: '@kirkchinese/dsh-recollect'
  config:
    language: en          # language of model-facing memory text: zh / en
    recall: { enabled: true, method: bm25 }
    instructions:
      authority: strong   # strong: instruction files override default behavior (as in Claude Code); soft: guidance only
```

Every field is listed in [lib/config.js](lib/config.js) and shown on DSH's settings page. `DSH_RECOLLECT_DISABLE_MEMORY=1` turns memory off (`0` forces it on), and `DSH_RECOLLECT_DISABLE_INSTRUCTIONS=1` turns instruction files off.

## Differences from Claude Code

- Every model gets the same complete guidance. Memory is never shortened or disabled based on the model name.
- All prompts are written independently for this project, with no Claude Code text, in Chinese and English. Recall uses an independent BM25F implementation.
- `AGENTS.md`, `.agents/rules` and `AGENTS.local.md` load alongside the `CLAUDE.md` family. Files with identical content in one directory are shown once.
- Invisible and control characters are stripped, and `</system-reminder>` in file content or paths is escaped.
- Adds `/remember`. `/memory` reports status as text instead of opening a dialog.

## Known limitations

- On a context overflow, DSH compacts and retries within the same step without the injection hook, so that single retry lacks the instruction block. The next step restores it.
- Headless mode exits right after the turn, so background extraction does not run there.
- The consolidation lock writes a PID and reads it back; it is not atomic. Do not run two host processes on one DSH home.

Recollect is not affiliated with Anthropic. "Claude Code" is used only to describe compatible file conventions.

## License

[MIT](LICENSE)
