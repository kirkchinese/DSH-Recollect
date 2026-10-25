/**
 * Plugin configuration (schemastery). Defaults match Claude Code's
 * effective defaults: guidance + index + instruction files on;
 * recall, background extraction and dream implemented but off.
 * @module @kirkchinese/dsh-recollect/config
 */
import z from '@deepseek-ai/schemastery';

const route = z.object({
  provider: z.string().default('').description('LLM provider id; empty follows the current session.'),
  model: z.string().default('').description('Model id; empty follows the current session. Set provider and model together.'),
}).default({});

export const Config = z.object({
  language: z.union(['zh', 'en']).default('zh').description('Language of model-facing memory text (guidance, notices, prompts).'),
  instructions: z.object({
    enabled: z.boolean().default(true).description('Load CLAUDE.md / AGENTS.md instruction files (Managed → User → Project → Local).'),
    authority: z.union(['strong', 'soft']).default('strong').description('Preamble wording: strong = instruction files override default behavior (Claude Code compatible); soft = guidance that does not override system/user instructions.'),
    managedDirs: z.array(z.string()).default(['/etc/claude-code']).description('Organization policy directories (each: CLAUDE.md and .claude/rules/).'),
    userFiles: z.array(z.string()).default(['~/.claude/CLAUDE.md', '{dshHome}/AGENTS.md', '{agentsHome}/AGENTS.md']).description('User-level instruction files.'),
    userRulesDirs: z.array(z.string()).default(['~/.claude/rules']).description('User-level rules directories.'),
    projectFiles: z.array(z.string()).default(['CLAUDE.md', 'AGENTS.md']).description('Per-directory base files (with @import).'),
    projectDotFiles: z.array(z.string()).default(['.claude/CLAUDE.md', '.claude/AGENTS.md']).description('Per-directory files under dot folders.'),
    rulesDirs: z.array(z.string()).default(['.claude/rules', '.agents/rules']).description('Per-directory rules folders (recursive .md; `paths:` frontmatter makes a rule conditional).'),
    localFiles: z.array(z.string()).default(['CLAUDE.local.md', 'AGENTS.local.md']).description('Per-directory private overlays.'),
    excludes: z.array(z.string()).default([]).description('Absolute-path globs of User/Project/Local files to skip (Managed cannot be excluded).'),
    allowExternalImports: z.boolean().default(false).description('Allow project/local @imports outside the working directory.'),
    dedupeContent: z.boolean().default(true).description('Within one directory, inject files with identical trimmed content once.'),
    nested: z.boolean().default(true).description('Load instruction files of subdirectories and matching conditional rules when read/write/edit touch a file.'),
    refreshEachTurn: z.boolean().default(false).description('Re-read instruction files at every turn start and announce differences (default: only at resume/compaction/toggles).'),
    suppressBuiltin: z.boolean().default(true).description('Drop context injected by the built-in @deepseek-ai/dsh-agent-instructions so files are not loaded twice.'),
    warnTotalChars: z.number().default(120000).description('Log a warning when injected instructions exceed this many characters (never truncates).'),
  }).default({}),
  memory: z.object({
    enabled: z.boolean().default(true).description('Persistent memory: guidance in the system prompt and MEMORY.md index in context.'),
    root: z.string().default('{dshHome}/memory').description('Base directory; each project uses <root>/projects/<slug>/.'),
    directory: z.string().default('').description('Fixed memory directory for every project (overrides root).'),
    writeMode: z.union(['auto', 'files', 'tools']).default('auto').description('auto: built-in write/edit when the sandbox allows writing the memory directory, otherwise the dedicated memory tools.'),
    lint: z.boolean().default(true).description('After a memory write, remind the model about index/recall limits and missing frontmatter.'),
  }).default({}),
  recall: z.object({
    enabled: z.boolean().default(false).description('Inject up to 5 relevant memory files at each user turn.'),
    method: z.union(['bm25', 'selector']).default('bm25').description('bm25: local index; selector: one side LLM call that picks files by description.'),
    selector: route,
  }).default({}),
  extract: z.object({
    enabled: z.boolean().default(false).description('After a turn, a forked background agent saves memories the main conversation did not.'),
    everyNTurns: z.number().min(1).default(1).description('Run after every N eligible turns.'),
    maxTurns: z.number().min(1).default(5).description('Step budget of the extraction agent.'),
    route,
  }).default({}),
  dream: z.object({
    enabled: z.boolean().default(false).description('Background consolidation of the memory directory.'),
    minHours: z.number().default(24).description('Hours since the last consolidation.'),
    minSessions: z.number().default(5).description('Sessions touched since the last consolidation.'),
    route,
  }).default({}),
  agentMemory: z.dict(z.union(['user', 'project', 'local'])).default({}).description('Preset id → persistent agent memory scope (user / project / local).'),
});

/**
 * Validate a raw config.
 * @param raw - loader row config.
 */
export function resolveConfig(raw) {
  return Config(raw ?? {});
}
