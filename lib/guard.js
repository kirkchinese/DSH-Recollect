import { t } from './i18n.js';
import { isAbsolute, resolve, dirname, basename } from 'node:path';
import { realpathSync } from 'node:fs';
import { within, expandHome } from './paths.js';

export const MEMORY_TOOL_NAMES = ['memory_list', 'memory_read', 'memory_write', 'memory_edit', 'memory_delete'];
const READ_COMMANDS = new Set(['ls', 'find', 'grep', 'rg', 'cat', 'stat', 'wc', 'head', 'tail', 'sort', 'uniq', 'cut', 'file']);

/** Conservative shell tokenizer: no expansions, escaping, redirection or control operators. */
export function shellWords(command) {
  if (typeof command !== 'string' || /[><;&`$\\\n\r\0]/.test(command)) return null;
  const words = []; let word = '', quote = '', active = false;
  for (const c of command) {
    if (quote) { if (c === quote) quote = ''; else word += c; active = true; }
    else if (c === '"' || c === "'") { quote = c; active = true; }
    else if (/\s/.test(c)) { if (active) words.push(word); word = ''; active = false; }
    else { word += c; active = true; }
  }
  if (quote) return null;
  if (active) words.push(word);
  return words;
}

export function isMemoryMarkdownPath(file, memoryDir, cwd = process.cwd()) {
  if (typeof file !== 'string' || !file.endsWith('.md') || file.includes('\0')) return false;
  const p = resolve(cwd, expandHome(file));
  return within(memoryDir, p) && p !== resolve(memoryDir);
}

/** Resolve existing ancestors too, so a lexical descendant cannot escape through a symlink. */
export function canonicalMemoryPath(file, memoryDir, cwd = process.cwd()) {
  if (!isMemoryMarkdownPath(file, memoryDir, cwd)) return false;
  const canonical = p => {
    try { return realpathSync(p); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = dirname(p); if (parent === p) throw e;
      return resolve(canonical(parent), basename(p));
    }
  };
  try { return within(canonical(resolve(memoryDir)), canonical(resolve(cwd, expandHome(file)))); } catch { return false; }
}

export function isReadOnlyCommand(command) {
  if (typeof command !== 'string') return false;
  const segments = command.split('|');
  return segments.every(segment => {
    const w = shellWords(segment); if (!w?.length || !READ_COMMANDS.has(w[0])) return false;
    const args = w.slice(1);
    if (w[0] === 'find' && args.some(a => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)/.test(a))) return false;
    if (['grep', 'rg'].includes(w[0]) && args.some(a => /^--(?:pre|hostname-bin)(?:=|$)/.test(a))) return false;
    if (w[0] === 'sort' && args.some(a => /^-.*o|^--(?:output|compress-program)(?:=|$)/.test(a))) return false;
    // uniq accepts an output filename; allowing only options/stdin avoids that ambiguity.
    if (w[0] === 'uniq' && args.some(a => !/^-(?:[cduifsz]+|[0-9]+)$/.test(a))) return false;
    if (w[0] === 'file' && args.some(a => /^-[^-]*C|^--c/.test(a))) return false; // GNU long-option abbreviations can select --compile.
    return true;
  });
}

export function isMemoryRemoveCommand(command, memoryDir) {
  if (typeof command !== 'string' || command.includes('|') || /[*?\[\]{}~]/.test(command)) return false;
  const words = shellWords(command); if (!words || words[0] !== 'rm') return false;
  let flags = true; const files = [];
  for (const w of words.slice(1)) {
    if (flags && w === '--') { flags = false; continue; }
    if (flags && (w === '-f' || w === '--force')) continue;
    if (flags && w.startsWith('-')) return false;
    files.push(w);
  }
  return files.length > 0 && files.every(p => isAbsolute(p) && isMemoryMarkdownPath(p, memoryDir));
}

export function createChildToolPolicy() {
  const children = new Map();
  return {
    restrict(sessionId, options) { children.set(sessionId, options); },
    release(sessionId) { children.delete(sessionId); },
    isRestricted(sessionId) { return children.has(sessionId); },
    guard(exec) {
      const restriction = children.get(exec.agent?.session.id); if (!restriction) return;
      const { memoryDir } = restriction; const a = exec.arguments ?? {};
      if (['read', 'glob', 'grep', ...MEMORY_TOOL_NAMES].includes(exec.name)) return;
      const cwd = exec.agent?.session.header.cwd ?? process.cwd();
      if (['write', 'edit'].includes(exec.name) && canonicalMemoryPath(a.file_path, memoryDir, cwd)) return;
      if (exec.name === 'bash') {
        if (isReadOnlyCommand(a.command)) return;
        if (isMemoryRemoveCommand(a.command, memoryDir) && shellWords(a.command).slice(1).filter(p => isAbsolute(p)).every(p => canonicalMemoryPath(p, memoryDir))) return;
      }
      return t().guardDenied;
    },
  };
}

export function createStepBudget() {
  const budgets = new Map();
  return {
    set(sessionId, maxSteps) { budgets.set(sessionId, Math.max(0, Math.floor(maxSteps))); },
    clear(sessionId) { budgets.delete(sessionId); },
    onPreStep(sessionId) {
      if (!budgets.has(sessionId)) return true;
      const remaining = budgets.get(sessionId); if (remaining <= 0) return false;
      budgets.set(sessionId, remaining - 1); return true;
    },
  };
}
