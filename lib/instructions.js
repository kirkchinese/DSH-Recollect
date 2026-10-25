/**
 * Instruction-file discovery and assembly.
 *
 * Startup order: Managed → User → Project directories from
 * the filesystem root down to cwd (each: base files with in-place `@import`
 * expansion → `.claude/` files → unconditional rules → local files) →
 * memory index. Everything is concatenated; nothing overrides anything.
 * Conditional rules (frontmatter `paths:`) and directories below cwd load on
 * demand when a file is touched.
 * @module @kirkchinese/dsh-recollect/instructions
 */
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { INDEX_FILE, MAX_IMPORT_DEPTH, MAX_INSTRUCTION_FILE_BYTES, TEXT_EXTENSIONS } from './constants.js';
import { extractImports, rulePaths, splitFrontmatter, stripHtmlComments } from './markdown.js';
import { matchAbsolute, matchIgnoreStyle } from './glob.js';
import { truncateIndex } from './render.js';
import { cleanText } from './sanitize.js';
import { within } from './paths.js';

/**
 * @typedef {'Managed'|'User'|'Project'|'Local'|'AutoMem'} InstructionType
 * @typedef {{ path: string, type: InstructionType, content: string, globs?: string[], parent?: string }} InstructionFile
 */

/**
 * Read one candidate as text, or undefined when absent, not a regular file,
 * over the size cap or unreadable.
 * @param path - absolute path.
 * @param log - logger for skips.
 */
async function readCandidate(path, log) {
  let st;
  try {
    st = await stat(path);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP'].includes(error?.code)) log?.(`[instructions] cannot stat ${path}: ${error?.code ?? error}`);
    return undefined;
  }
  if (!st.isFile() || st.size > MAX_INSTRUCTION_FILE_BYTES) {
    if (st.isFile()) log?.(`[instructions] skipping ${path}: not a regular file or exceeds ${MAX_INSTRUCTION_FILE_BYTES} byte limit`);
    return undefined;
  }
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    log?.(`[instructions] cannot read ${path}: ${error?.code ?? error}`);
    return undefined;
  }
}

/**
 * Discovery engine bound to one configuration.
 */
export class InstructionLoader {
  /**
   * @param options - resolved instruction options:
   *   `{ managedDirs, userFiles, userRulesDirs, projectFiles, projectDotFiles,
   *      rulesDirs, localFiles, excludes, allowExternalImports, dedupeContent, log }`.
   */
  constructor(options) {
    this.o = options;
  }

  /**
   * Load one file and its imports depth-first.
   * @param path - absolute path.
   * @param type - instruction type.
   * @param ctx - `{ seen: Set<string>, cwd: string, includeExternal: boolean }`.
   * @param depth - import depth (0 for a top-level file).
   * @param parent - importing file.
   * @returns files in render order.
   */
  async loadFile(path, type, ctx, depth = 0, parent = undefined) {
    if (depth >= MAX_IMPORT_DEPTH) return [];
    const abs = resolve(path);
    let key = abs.normalize('NFC');
    const real = await realpath(abs).catch(() => abs);
    if (ctx.seen.has(key) || ctx.seen.has(real)) return [];
    if (type !== 'Managed' && this.o.excludes.length > 0 && (matchAbsolute(abs, this.o.excludes) || matchAbsolute(real, this.o.excludes))) return [];
    const ext = extname(abs).toLowerCase();
    if (depth > 0 && ext && !TEXT_EXTENSIONS.has(ext)) {
      this.o.log?.(`Skipping non-text file in @include: ${abs}`);
      return [];
    }
    const raw = await readCandidate(abs, this.o.log);
    if (raw === undefined) return [];
    ctx.seen.add(key);
    ctx.seen.add(real);
    const { frontmatter, body } = splitFrontmatter(raw);
    const globs = rulePaths(frontmatter.paths);
    const { content } = stripHtmlComments(body);
    if (content.trim() === '') return [];
    /** @type {InstructionFile} */
    const file = { path: abs, type, content, ...(globs ? { globs } : {}), ...(parent ? { parent } : {}) };
    const out = [file];
    if (content.includes('@')) {
      for (const target of extractImports(content, abs)) {
        if (!ctx.includeExternal && !within(ctx.cwd, target)) continue;
        out.push(...await this.loadFile(target, type, ctx, depth + 1, abs));
      }
    }
    return out;
  }

  /**
   * Load a rules directory recursively (`.md` only, name-sorted).
   * @param dir - absolute rules directory.
   * @param type - instruction type.
   * @param ctx - load context.
   * @param conditional - true to keep only rules with `paths:`, false for only unconditional ones.
   * @param visited - directory cycle guard.
   */
  async loadRules(dir, type, ctx, conditional, visited = new Set()) {
    const real = await realpath(dir).catch(() => undefined);
    if (real === undefined || visited.has(real)) return [];
    visited.add(real);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const out = [];
    for (const e of entries) {
      const p = join(dir, e.name);
      let isDirectory = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        const st = await stat(p).catch(() => null);
        isDirectory = st?.isDirectory() === true;
        isFile = st?.isFile() === true;
      }
      if (isDirectory) out.push(...await this.loadRules(p, type, ctx, conditional, visited));
      else if (isFile && e.name.endsWith('.md')) {
        // Conditional rules are probed without consuming the seen-set so a
        // later touch can still load them.
        // A rule and its imports form one group, kept or dropped together.
        const probe = await this.loadFile(p, type, { ...ctx, seen: new Set(ctx.seen) }, 0);
        if (probe.length === 0 || (probe[0].globs !== undefined) !== conditional) continue;
        // Imports of a conditional rule load with it: tag the whole group with the rule's globs.
        if (conditional) out.push(...probe.map(f => ({ ...f, ruleGlobs: probe[0].globs })));
        else out.push(...await this.loadFile(p, type, ctx, 0));
      }
    }
    return out;
  }

  /**
   * Files of one project directory, in load order.
   * @param dir - absolute directory.
   * @param ctx - load context.
   * @param includeLocal - load local overlays.
   */
  async loadDirectory(dir, ctx, includeLocal = true) {
    const groups = [];
    for (const name of this.o.projectFiles) groups.push(await this.loadFile(join(dir, name), 'Project', ctx));
    for (const rel of this.o.projectDotFiles) groups.push(await this.loadFile(join(dir, ...rel.split('/')), 'Project', ctx));
    for (const rel of this.o.rulesDirs) groups.push(await this.loadRules(join(dir, ...rel.split('/')), 'Project', ctx, false));
    if (includeLocal) for (const name of this.o.localFiles) groups.push(await this.loadFile(join(dir, name), 'Local', ctx));
    return this.dedupe(groups.flat());
  }

  /**
   * Drop top-level files whose trimmed content repeats an earlier file of the
   * same directory scan (e.g. a CLAUDE.md identical to AGENTS.md).
   * @param files - files of one scan.
   */
  dedupe(files) {
    if (!this.o.dedupeContent) return files;
    const seen = new Set();
    return files.filter(f => {
      const k = `${f.type}\0${f.content.trim()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /**
   * Directories from just below the filesystem root down to `cwd` (root excluded).
   * @param cwd - absolute directory.
   */
  static ancestors(cwd) {
    const dirs = [];
    let d = resolve(cwd);
    while (d !== dirname(d)) {
      dirs.unshift(d);
      d = dirname(d);
    }
    return dirs;
  }

  /**
   * Startup assembly.
   * @param params - `{ cwd, memoryIndexPath?: string }`; the index is loaded
   *   only when a path is given (auto memory on and not paused).
   * @returns `{ files: InstructionFile[], seen: Set<string> }`.
   */
  async loadStartup({ cwd, memoryIndexPath }) {
    const seen = new Set();
    const ctxFor = (includeExternal) => ({ seen, cwd, includeExternal });
    const files = [];
    if (this.o.enabled) {
      for (const dir of this.o.managedDirs) {
        files.push(...await this.loadFile(join(dir, 'CLAUDE.md'), 'Managed', ctxFor(true)));
        files.push(...await this.loadRules(join(dir, '.claude', 'rules'), 'Managed', ctxFor(true), false));
      }
      const user = [];
      for (const f of this.o.userFiles) user.push(...await this.loadFile(f, 'User', ctxFor(true)));
      for (const d of this.o.userRulesDirs) user.push(...await this.loadRules(d, 'User', ctxFor(true), false));
      files.push(...this.dedupe(user));
      for (const dir of InstructionLoader.ancestors(cwd)) {
        files.push(...await this.loadDirectory(dir, ctxFor(this.o.allowExternalImports)));
      }
    }
    if (memoryIndexPath !== undefined) {
      const index = await loadMemoryIndex(memoryIndexPath, this.o.log);
      if (index !== undefined) files.push(index);
    }
    return { files, seen };
  }

  /**
   * On-demand files for a touched path: project files of directories strictly
   * below cwd down to the file's directory, plus conditional rules whose
   * globs match the file.
   * @param params - `{ cwd, filePath }`.
   * @returns candidate files (callers drop ones already announced).
   */
  async loadForTouch({ cwd, filePath }) {
    if (!this.o.enabled) return [];
    const abs = resolve(cwd, filePath);
    const seen = new Set();
    const ctx = { seen, cwd, includeExternal: this.o.allowExternalImports };
    const out = [];
    const nestedDirs = [];
    if (within(cwd, abs)) {
      let d = dirname(abs);
      while (d !== resolve(cwd) && within(cwd, d)) {
        nestedDirs.unshift(d);
        d = dirname(d);
      }
    }
    for (const dir of nestedDirs) out.push(...await this.loadDirectory(dir, ctx));
    // Conditional rules: user-level rule dirs match relative to cwd, project
    // rule dirs relative to the directory that owns them.
    const matchFrom = (base, rules) => {
      const rel = relative(base, abs).split(sep).join('/');
      if (rel === '' || rel.startsWith('..')) return [];
      return rules.filter(r => matchIgnoreStyle(rel, r.ruleGlobs ?? r.globs ?? []));
    };
    for (const d of this.o.userRulesDirs) {
      out.push(...matchFrom(cwd, await this.loadRules(d, 'User', { ...ctx, includeExternal: true }, true)));
    }
    for (const dir of [...InstructionLoader.ancestors(cwd), ...nestedDirs]) {
      for (const rel of this.o.rulesDirs) {
        out.push(...matchFrom(dir, await this.loadRules(join(dir, ...rel.split('/')), 'Project', ctx, true)));
      }
    }
    return out;
  }
}

/**
 * Load the memory index as an AutoMem instruction file, truncated with the
 * truncation warning. Absent or blank index → undefined.
 * @param path - absolute MEMORY.md path.
 * @param log - logger.
 */
export async function loadMemoryIndex(path, log) {
  const raw = await readCandidate(path, log);
  if (raw === undefined || raw.trim() === '') return undefined;
  const { content } = stripHtmlComments(raw);
  return { path, type: 'AutoMem', content: cleanText(truncateIndex(content).content) };
}

export { basename, INDEX_FILE };
