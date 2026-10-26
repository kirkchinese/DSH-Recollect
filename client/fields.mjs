// Settings page fields. `path` is the config path inside this plugin's row.
// kind: bool | enum (options) | text | number | list (comma separated strings).
export const ROW_ID = 'recollect';

export const FIELDS = [
  { section: 'memory', path: 'language', kind: 'enum', options: ['zh', 'en'] },
  { section: 'memory', path: 'memory.enabled', kind: 'bool' },
  { section: 'memory', path: 'memory.writeMode', kind: 'enum', options: ['auto', 'files', 'tools'] },
  { section: 'memory', path: 'memory.lint', kind: 'bool' },
  { section: 'memory', path: 'memory.shareWithClaudeCode', kind: 'bool' },
  { section: 'memory', path: 'memory.root', kind: 'text' },
  { section: 'memory', path: 'memory.directory', kind: 'text' },
  { section: 'memory', path: 'memory.claudeHome', kind: 'text' },

  { section: 'instructions', path: 'instructions.enabled', kind: 'bool' },
  { section: 'instructions', path: 'instructions.authority', kind: 'enum', options: ['strong', 'soft'] },
  { section: 'instructions', path: 'instructions.nested', kind: 'bool' },
  { section: 'instructions', path: 'instructions.refreshEachTurn', kind: 'bool' },
  { section: 'instructions', path: 'instructions.suppressBuiltin', kind: 'bool' },
  { section: 'instructions', path: 'instructions.dedupeContent', kind: 'bool' },
  { section: 'instructions', path: 'instructions.allowExternalImports', kind: 'bool' },
  { section: 'instructions', path: 'instructions.excludes', kind: 'list' },
  { section: 'instructions', path: 'instructions.warnTotalChars', kind: 'number' },

  { section: 'recall', path: 'recall.enabled', kind: 'bool' },
  { section: 'recall', path: 'recall.method', kind: 'enum', options: ['bm25', 'selector'] },
  { section: 'recall', path: 'recall.selector.provider', kind: 'text' },
  { section: 'recall', path: 'recall.selector.model', kind: 'text' },

  { section: 'extract', path: 'extract.enabled', kind: 'bool' },
  { section: 'extract', path: 'extract.everyNTurns', kind: 'number' },
  { section: 'extract', path: 'extract.maxTurns', kind: 'number' },
  { section: 'extract', path: 'extract.route.provider', kind: 'text' },
  { section: 'extract', path: 'extract.route.model', kind: 'text' },

  { section: 'dream', path: 'dream.enabled', kind: 'bool' },
  { section: 'dream', path: 'dream.minHours', kind: 'number' },
  { section: 'dream', path: 'dream.minSessions', kind: 'number' },
  { section: 'dream', path: 'dream.route.provider', kind: 'text' },
  { section: 'dream', path: 'dream.route.model', kind: 'text' },
];

export const SECTIONS = ['memory', 'instructions', 'recall', 'extract', 'dream'];
