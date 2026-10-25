/**
 * Limits and fixed strings, Units matter:
 * index limits are UTF-16 code units, recall limits are UTF-8 bytes.
 * @module @kirkchinese/dsh-recollect/constants
 */

/** Single instruction file size cap; larger files are skipped whole (bytes). */
export const MAX_INSTRUCTION_FILE_BYTES = 4 * 1024 * 1024;
/** `@import` depth: top level is 0, depths 1..4 load, >= 5 stops. */
export const MAX_IMPORT_DEPTH = 5;
/** Memory index file name. */
export const INDEX_FILE = 'MEMORY.md';
/** Index line cap. */
export const INDEX_MAX_LINES = 200;
/** Index cap in UTF-16 code units. */
export const INDEX_MAX_UNITS = 25000;
/** Recall view cap: lines per memory file. */
export const RECALL_MAX_LINES = 200;
/** Recall view cap: UTF-8 bytes per memory file. */
export const RECALL_MAX_BYTES = 4096;
/** Fallback description length (first non-empty body line). */
export const DESCRIPTION_FALLBACK_CHARS = 120;
/** Memory scan cap. */
export const MAX_SCANNED_MEMORIES = 200;
/** Recall: at most this many memories per turn. */
export const RECALL_MAX_SELECTED = 5;
/** Recall: per-session gate in UTF-16 units (a gate before selection, not a slice). */
export const RECALL_SESSION_BUDGET = 61440;
/** Total instruction size soft-warning floor (chars). */
export const TOTAL_WARN_FLOOR = 120000;
/** Single instruction file soft-warning floor (chars). */
export const FILE_WARN_FLOOR = 40000;

/** Text extensions accepted by `@import` (files without extension are accepted too). */
export const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.text', '.json', '.yaml', '.yml', '.toml', '.xml', '.csv', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.pyi', '.pyw', '.rb', '.erb', '.rake', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.cs', '.swift', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.env', '.ini', '.cfg', '.conf', '.config', '.properties', '.sql', '.graphql', '.gql', '.proto', '.vue', '.svelte', '.astro', '.ejs', '.hbs', '.pug', '.jade', '.php', '.pl', '.pm', '.lua', '.r', '.dart', '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.cljc', '.edn', '.hs', '.lhs', '.elm', '.ml', '.mli', '.f', '.f90', '.f95', '.for', '.cmake', '.make', '.makefile', '.gradle', '.sbt', '.rst', '.adoc', '.asciidoc', '.org', '.tex', '.latex', '.lock', '.log', '.diff', '.patch']);

/** Message source kind of everything this plugin injects. */
export const SOURCE_KIND = 'recollect';
