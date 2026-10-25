# Model-facing text: behavioral specification

This file describes **what each piece of model-facing text must achieve**. It is written so that
the wording can be authored independently. Do not copy wording from any other product. Write
fresh prose and fresh examples. Two locales are required: `zh` (Simplified Chinese, the default)
and `en` (English). The two locales must be equivalent in meaning. Each is idiomatic in its own
language, not a literal translation of the other.

Target reader: any LLM (DeepSeek, GPT, Claude, Qwen…). Be explicit and operational: models
follow concrete rules, triggers and formats better than abstract advice. Keep the tone neutral and
never name a specific vendor or product.

Tool names that appear in text are passed in as parameters or listed below. Built-in file tools
are `read`, `write`, `edit`, `glob`, `grep`, `bash`. Dedicated memory tools are `memory_list`,
`memory_read`, `memory_write`, `memory_edit` and `memory_delete`. The index file is always
`MEMORY.md`. File names, frontmatter keys (`name`, `description`, `metadata.type`) and type
values (`user`, `feedback`, `project`, `reference`) stay in English in both locales. So do the
index-line format and the tag `<system-reminder>`.

## 1. Instruction block

- `preamble.strong`: tells the model that the following blocks are project and user instruction
  files, that it must adhere to them, and that they take priority over its default behavior and
  must be followed exactly.
- `preamble.soft`: same introduction, but framed as guidance. More specific files win over
  broader ones, and these files do not override system, developer or direct user instructions.
- `section(path, label)`: heading line put before one file's body, followed by a blank line.
  It must contain the absolute path and the label.
- `labels`: short parenthetical labels, each starting with one space, for `Managed`
  (organization policy), `User` (user's private instructions for every project), `Project`
  (checked into the repository), `Local` (user's private instructions for this project, not
  checked in) and `AutoMem` (the user's persistent memory index, kept across conversations).
- `refresh.when[reason]`: short clauses for when files were re-read. Reasons are
  `session_start`, `compaction`, `directory_changed`, `memory_paused`, `memory_resumed` and
  `turn`.
- `refresh.intro(when)`: says the files were re-read at that moment and differ from the copies
  shown earlier. Each file below replaces its earlier copy, and the earlier preamble still
  applies.
- `refresh.removed(path)`: says the file at path no longer exists, so its earlier instructions
  no longer apply.
- `nested(path)`: heading for an instruction file discovered later, in a subdirectory or as a
  path-conditional rule. Like `section`, but with no label.

## 2. Index truncation warning (`indexWarning`)

Parameters are `{ lineCount, maxLines, sizeKB, maxKB, kind, keptLines, cutLines, nextLineNo,
nextLineSnippet, keptChars }`. `kind` is `'lines' | 'size' | 'both'`. The warning is prefixed
with `> WARNING: ` in en and `> 警告：` in zh. It says that `MEMORY.md` exceeded its limit and
reports how large it is. It says only part was loaded and states exactly what was cut: the
number of lines and the first cut line with a snippet, or, when even line 1 is too long,
everything after the first N characters. It ends by telling the model to keep each index entry
to one line under about 200 characters and to move detail into topic files.

## 3. System-prompt guidance (`guidance(opts)`)

`opts` is `{ title, dir, mode: 'files'|'tools', readOnly, extraGuidelines: string[] }`.
`title` is `'persistent memory'` or `'Persistent Agent Memory'`. In zh, use the headings
`持久记忆` or `智能体持久记忆` for these. Output Markdown that starts with `# <title>`. It must
contain the following, in order, with `##` subsections:

1. **Where and how.** The memory system is file-based and lives at `dir`. The directory already
   exists, so the model must not create it or check for it. It writes there directly with
   `write`/`edit` (files mode) or with `memory_write`/`memory_edit` (tools mode). In tools mode,
   also say that the built-in file tools cannot reach this directory in this session. When
   `readOnly` is set, say instead that the memory is read-only this session and nothing new can
   be saved. Readers of a read-only memory still get the types, the "what not to save" list and
   the access rules, but not the saving procedure.
2. **Purpose** (omit when read-only). Over many conversations, build a complete picture of who
   the user is, how they like to collaborate, which behaviors to avoid or repeat, and the
   background of their work. This is an active, ongoing duty, not something optional.
3. **Explicit requests** (omit when read-only). When the user asks to remember something, save
   it at once with the best-fitting type. When the user asks to forget something, find the
   memory and remove it.
4. **Memory types**, one structured block per type. Use a clear repeated structure, such as XML
   tags or bold labels, with: what it holds, when to save it, how to use it, the body structure
   (feedback and project only) and **two or three fresh, concrete example exchanges** of the
   form `user: … / assistant: [saves X memory: …]`.
   - `user`: role, goals, responsibilities, expertise and preferences, so that work can be
     tailored to this user (for example, explain differently to an expert than to a beginner).
     Stay helpful and never judgmental. Do not record things irrelevant to the shared work.
   - `feedback`: how the user wants work done, both corrections ("don't do X") **and**
     confirmations that a non-obvious approach was right. Confirmations are quiet and easy to
     miss, so watch for them. Recording only corrections makes the assistant drift into
     overcaution. Save the reason, so edge cases can be judged later. Body: the rule, then a
     `**Why:**` line, then a `**How to apply:**` line.
   - `project`: ongoing work, goals, decisions, deadlines and incidents that cannot be derived
     from code or git history. These change quickly. Always convert relative dates into
     absolute dates. Body: the fact, then `**Why:**`, then `**How to apply:**`.
   - `reference`: pointers to information in external systems, such as issue trackers,
     dashboards, documents and chat channels, and what each is for.
5. **What not to save**, even when the user explicitly asks:
   - code structure, conventions, architecture or file paths (readable from the repo);
   - git history or who changed what;
   - fix recipes (the fix lives in the code and the commit);
   - anything already in `CLAUDE.md` or `AGENTS.md` instruction files;
   - temporary task state of the current conversation.
   When asked to save one of these, for example a list of PRs, ask the user what was surprising
   or non-obvious about it, and save that instead.
6. **How to save** (omit when read-only). Two steps.
   - Step 1: write one memory per file with a descriptive name (for example `feedback_xxx.md`),
     using a frontmatter template shown in a fenced `markdown` block with
     `name` (short kebab-case slug), `description` (one specific line that future sessions use
     to judge relevance) and `metadata: type:` (one of the four), followed by the body. Bodies
     may link other memories with `[[name]]`. Linking to a memory that does not exist yet is
     fine, because it marks something worth writing later.
   - Step 2: add one pointer line to `MEMORY.md` in the form `- [Title](file.md) — one-line hook`,
     under about 150 characters. `MEMORY.md` is an index, not a memory. It has no frontmatter
     and holds no memory content. It is loaded into every conversation, and lines after 200 are
     cut off.
   - Housekeeping: keep `name`, `description` and type current; organize by topic, not by date;
     fix or delete wrong or outdated memories (in tools mode, deletion uses `memory_delete`);
     check for an existing memory to update before creating a new one.
7. **When to access memories.** Access them when they look relevant or the user refers to
   earlier work. Access is **mandatory** when the user asks to check, recall or remember. When
   the user says to ignore memory, do not use, cite, compare against or mention it. Memories go
   stale, because they record what was true when written. Before relying on one, verify it
   against current files. When it conflicts with what you observe, trust the observation and
   update or delete the memory.
8. **Before recommending from memory.** A memory naming a file, function or flag only proves it
   existed when the memory was written. Check that the file exists, grep for the function or
   flag, and verify before the user acts on a recommendation. A memory that summarizes repo
   state is a snapshot. For questions about the current state, prefer git log or the code.
9. **Memory versus other persistence.** Memory is for information useful in future
   conversations. Use a plan to agree on an approach for the current task, and update the plan
   when the approach changes. Use a todo list to track steps within the current conversation.

Append the `extraGuidelines` lines at the end.

- `directorySentence(mode)`: the single "directory already exists…" sentence from item 1, for
  reuse by the extraction and consolidation prompts.
- `agent.scope[user|project|local]`: one bullet line each. User scope means keep learnings
  general because they apply to every project. Project scope means the memory is shared with
  the team through version control, so tailor it to this project. Local scope means it is not
  in version control, so tailor it to this project and this machine.
- `agent.indexHeading` (`## MEMORY.md`), `agent.indexEmpty` (the index is empty, and saved
  memories will appear here) and `agent.indexRefused` (the index was not loaded because it or
  its folder is a link, a special file or outside the working copy; treat this memory as
  read-only and do not write in that folder).
- `rememberPrompt(text)`: a user-side request asking the assistant to save `text` to persistent
  memory with the best-fitting type, updating an existing memory if one covers it, and to keep
  `MEMORY.md` current.

## 4. Recall (memories injected per turn)

- `recall.preamble`: one line that opens the first recalled block. These memories were
  retrieved because they might be relevant; use them only when they really apply to the
  question.
- `recall.age(days)`: shown when a memory is more than one day old. It says the memory is
  `days` days old, that a memory describes the moment it was written rather than the present, and that
  claims about code may be outdated and should be verified before being stated as fact.
- `recall.header(path)`: `Memory: <path>:` or its zh equivalent.
- `recall.truncated(byBytes, path)`: the file was shortened (by the 4096-byte limit or to the
  first 200 lines), and the full file can be read with `read` at `path`.
- `recall.selectorSystem`: the system prompt for a side model that picks memory files. The
  input is a list of files (with type, filename, mtime and description), followed by user
  queries. For each query, return at most 5 filenames that will **clearly** help answer it.
  When unsure, leave a file out; an empty list is fine. Be especially strict with `user` and
  `project` profile memories: match on what the question is about, not on surface word overlap
  with the user's profile. Do not re-select files already returned earlier in the
  conversation. The reply must be only JSON: `{"selected_memories": ["<filename>", ...]}`.
- `recall.selectorQuery(query)`: the per-query message, "Select memories relevant to:" plus a
  newline and the query.

## 5. Write checks (lint) after a memory write

All parameters are preformatted strings.
- `lint.indexOver({ path, size, cap, target })`: an error. The write succeeded, but the index is
  over its read limit, so entries past the limit are silently dropped each time it loads.
  Rewrite it now to under `target`: one line per entry, detail moved to topic files, stale
  entries merged or dropped.
- `lint.indexNear({ path, size, cap, target })`: the index is approaching the limit. Compact it
  to under `target` now.
- `lint.fileOver({ path, size, cap, shown, target })`: an error. The write succeeded, but recall
  only shows the first `shown` of a memory file, so the rest is invisible to other sessions.
  Rewrite it to under `target`: one fact per file, distinct facts split into their own files,
  logs summarized instead of appended. Do not continue it as a `-2` file.
- `lint.fileNear({ path, size, cap, target })`: the file is approaching the recall limit. Keep
  it to one fact under `target`.
- `lint.continuation({ file, base, cap })`: the file looks like a continuation of `base.md`.
  Recall treats each file independently and shows only `cap` of it, so chained parts are rarely
  found. Fold the durable facts back into `base.md`, or give this file its own one-fact name and
  description.
- `lint.noDescription`: the file has no frontmatter `description`, so recall cannot reliably
  pick it. Add the full frontmatter block.
- `lint.longDescription(n)`: the description is `n` characters long. Shorten it to one specific
  line of about 150 characters saying what question the file answers.

## 6. Memory tools

Descriptions are shown to the model and are tool-definition text.
- `tools.list`: lists memory files (optionally under a path prefix), sorted by path, with size
  and update time. Use `memory_read` for content.
- `tools.read`: reads one memory file by its path inside the memory directory (for example
  `/MEMORY.md`).
- `tools.write`: creates or overwrites a memory file with its **entire** content (omitted lines
  are deleted). It is for durable knowledge, following the persistent memory section of the
  system prompt, and the model must then update `MEMORY.md`. Secrets are refused. Then add a
  short "save triggers" paragraph: the model must save or update memory (a) whenever the user
  corrects it or gives durable knowledge it lacked, including "redo it this way" edits and
  skeptical questions, where it should record the preference behind the question; scope words
  like "for now" or "in this change" mark a one-off; and (b) when it learns something lasting
  about the environment. Writes happen in the same reply that handles the correction, not
  later.
- `tools.edit`: replaces an exact string in a memory file. The string must be unique unless
  `replace_all` is set.
- `tools.delete`: deletes a memory file (wrong, superseded, or forgotten at the user's request)
  and reminds the model to remove its pointer from `MEMORY.md`.
- `tools.params`: descriptions for `path_prefix`, `path` (list/read/write/edit/delete),
  `content`, `old_string`, `new_string` and `replace_all`.
- `tools.err`: `empty` (empty content is rejected; use `memory_delete` to remove a memory),
  `tooLarge(bytes, cap)`, `secrets(labels)` (no credentials in memory), `notFound(path)`,
  `notUnique(count, path)`, `editTooLarge(path, cap)`, `paused`, `readOnly`.
- `tools.ok`: `created(path, bytes)`, `updated(path, bytes)`, `edited(path, count)` and
  `deleted(path)`.

## 7. Background extraction (`extract.prompt({ messageCount, manifest, tools, toolsMode })`)

A prompt given to a forked helper that sees the main conversation. It says:
- You are the memory-extraction helper. Look only at the most recent ~`messageCount` messages
  and update persistent memory from them.
- The available tools are the string `tools`, and everything else is denied.
- The step budget is small. `edit` and overwriting with `write` require a prior `read` (in
  tools mode, read with `memory_read` first), so do all reads in one parallel step and all
  writes in the next. Do not interleave them.
- Use only those messages. Do not investigate or verify further: no grepping source, no reading
  code, no git.
- When `manifest` is not empty, show it under an "existing memory files" heading and say to
  update an existing file instead of creating a duplicate.
- When nothing is worth saving, reply with exactly the marker `extract.nothing`.
- Explicit remember and forget requests are handled as in the guidance.
- Apply the types, the "what not to save" rules and the frontmatter from the persistent memory
  section of the system prompt, which is already in context.
- `extract.tools(toolsMode)`: the tool list. In files mode: `read`, `grep`, `glob`, read-only
  `bash` (ls/find/cat/stat/wc/head/tail…), `write`/`edit` only for `.md` files inside the memory
  directory, and `bash rm` of such `.md` files only, with no flags except `-f`. In tools mode:
  `read`, `grep`, `glob`, read-only `bash`, and the memory tools.
- `extract.nothing`: the exact marker string `Nothing to save.` in both locales.

## 8. Consolidation (`dream.prompt({ memoryDir, sessionsDir, sessionIds, toolsMode, tools })`)

A prompt for a helper that tidies the memory directory. Its structure:
- Title and purpose: a reflective pass over the memory files, turning recent learning into
  durable, well-organized memories so that future sessions orient quickly.
- The memory directory (`memoryDir`), plus `directorySentence`.
- The session transcripts directory (`sessionsDir`). The files are large JSONL (DSH may store
  them as `session.v4.jsonl` or zstd-compressed `.jsonl.zstd`, which cannot be read here).
  Grep narrowly and never read whole files.
- Phase 1, orient: list the directory, read `MEMORY.md`, skim the topic files so as to improve
  them instead of duplicating them.
- Phase 2, gather: in priority order, first memories that drifted (they contradict what is in
  the code now), then narrow transcript greps for specific facts (show an example `grep -rn`
  command with `--include="*.jsonl" | tail -50`). Look only for things already suspected to
  matter.
- Phase 3, consolidate: write or update top-level memory files using the format from the system
  prompt's persistent memory section. Merge into existing files instead of near-duplicating,
  convert relative dates to absolute dates, and delete facts that were disproved.
- Phase 4, prune and index: keep `MEMORY.md` under 200 lines and about 25 KB. It is an index:
  one line per entry under about 150 characters, in the pointer format. Remove stale or
  superseded pointers, shorten lines over about 200 characters by moving the detail into the
  topic file, add pointers for new important memories, and resolve contradictions.
- Reconcile with instruction files (`CLAUDE.md` / `AGENTS.md`), which are in context.
  - When a feedback or project memory contradicts an instruction file on the same procedure,
    the checked-in file is authoritative: delete the memory or correct it, keeping any useful
    reason.
  - When the memory is clearly newer and explicitly corrects the file, do not edit the
    instruction file. Mark the memory as conflicting, to be verified, and mention it in the
    summary.
  - Added detail or a justified narrowing is not a conflict.
  - A memory saying "the user corrected me" does not prove it is newer than the file.
- End by returning a brief summary of what was merged, updated or pruned, or say that nothing
  needed changing.
- Additional context: the tool constraints (`tools`; anything else that writes is denied), then
  "sessions since last consolidation (N):" with one bullet per id.

## 9. Notices

- `memoryUpdate({ source: 'extract'|'dream', count, paths })`: returns `{ summary, text }`.
  `summary` is a short one-line account (under 120 characters), for example that N memories
  were saved or that only the index was updated. `text` is a `<system-reminder>` block saying
  that a background memory process (extraction or consolidation) updated the memory directory.
  It includes the summary and the changed files, and says this is ambient context that must not
  be narrated to the user unless they ask or it is directly relevant.
- `guardDenied`: one sentence saying the memory helper may only read files and change `.md`
  files inside the memory directory with the allowed tools.
- `emptyIndexNote`: unused, so it may be omitted.

## 10. Human-facing command text (UI, short)

`commands.memory.description`, `commands.pause.description`, `commands.remember.description`,
`commands.remember.hint`, `commands.dream.description`, and messages: `pausedOn`, `pausedOff`,
`rememberUsage`, `rememberQueued`, `memoryOff`, `dreamDisabled`, `dreamFailed(msg)`, plus
`status(fields)`. `status(fields)` takes `fields = { memory: 'on'|'off'|'paused', mode:
'files'|'tools'|'readonly', dir, recall, extract, dream, files: [{type, path, chars}], total,
warn }` and returns a short multi-line status report.
