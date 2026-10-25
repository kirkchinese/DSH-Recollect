/**
 * Minimal Markdown helpers: frontmatter, HTML-comment stripping and `@import`
 * extraction that skips fenced code, indented code and code spans.
 * @module @kirkchinese/dsh-recollect/markdown
 */
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * Split a leading `---` YAML frontmatter block.
 * @param text - file text.
 * @returns `{ frontmatter, body, raw }`; frontmatter is `{}` when absent.
 */
export function splitFrontmatter(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (m === null) return { frontmatter: {}, body: text, raw: '' };
  return { frontmatter: parseYamlSubset(m[1]), body: text.slice(m[0].length), raw: m[1] };
}

const unquote = v => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
};

/**
 * Parse the YAML subset used by memory and rule frontmatter: scalars, one
 * nested mapping level, block lists and flow lists.
 * @param src - frontmatter source.
 */
export function parseYamlSubset(src) {
  const root = {};
  /** Top-level key whose value is an indented block (list or mapping). */
  let openKey = null;
  const scalar = value => (value.startsWith('[') && value.endsWith(']')
    ? value.slice(1, -1).split(',').map(unquote).filter(s => s.length > 0)
    : unquote(value));
  for (const line of src.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent > 0 && openKey !== null) {
      if (t === '-' || t.startsWith('- ')) {
        if (!Array.isArray(root[openKey])) root[openKey] = [];
        root[openKey].push(unquote(t.slice(1)));
        continue;
      }
      const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(t);
      if (kv !== null) {
        if (root[openKey] === null || Array.isArray(root[openKey])) root[openKey] = {};
        root[openKey][kv[1]] = scalar(kv[2]);
      }
      continue;
    }
    if (indent === 0 && (t === '-' || t.startsWith('- ')) && openKey !== null) {
      if (!Array.isArray(root[openKey])) root[openKey] = [];
      root[openKey].push(unquote(t.slice(1)));
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(t);
    if (kv === null) continue;
    if (kv[2] === '') {
      root[kv[1]] = null;
      openKey = kv[1];
    } else {
      root[kv[1]] = scalar(kv[2]);
      openKey = null;
    }
  }
  return root;
}

/**
 * Tokenize lines into prose and code regions.
 * @param text - Markdown text.
 * @returns array of `{ code: boolean, text: string }` line groups.
 */
function regions(text) {
  const out = [];
  const lines = text.split('\n');
  let fence = null;
  let buf = [];
  let bufCode = false;
  const flush = code => {
    if (buf.length > 0) out.push({ code: bufCode, text: buf.join('\n') });
    buf = [];
    bufCode = code;
  };
  let prevBlank = true;
  for (const line of lines) {
    if (fence !== null) {
      buf.push(line);
      const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
      if (close.test(line)) {
        flush(false);
        fence = null;
      }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open !== null) {
      flush(true);
      buf.push(line);
      fence = open[1];
      continue;
    }
    const indented = /^( {4}|\t)/.test(line) && prevBlank && line.trim() !== '';
    if (indented !== bufCode) flush(indented);
    buf.push(line);
    if (!indented) prevBlank = line.trim() === '';
  }
  flush(false);
  return out;
}

/**
 * Remove `<!-- ... -->` comments outside code (comment-only blocks vanish).
 * @param text - Markdown text.
 * @returns `{ content, stripped }`.
 */
export function stripHtmlComments(text) {
  if (!text.includes('<!--')) return { content: text, stripped: false };
  let stripped = false;
  const content = regions(text).map(r => {
    if (r.code) return r.text;
    const next = r.text.replace(/<!--[\s\S]*?-->/g, () => {
      stripped = true;
      return '';
    });
    return next;
  }).join('\n');
  return { content, stripped };
}

const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Extract `@path` import targets, resolved against the importing file's directory.
 * @param text - Markdown text (comments already stripped).
 * @param filePath - absolute path of the importing file.
 * @returns absolute import paths in order of appearance, deduplicated.
 */
export function extractImports(text, filePath) {
  const found = [];
  const seen = new Set();
  for (const r of regions(text)) {
    if (r.code) continue;
    const prose = r.text.replace(/(`+)[\s\S]*?\1/g, ' ');
    const re = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
    let m;
    while ((m = re.exec(prose)) !== null) {
      let target = m[1];
      const hash = target.indexOf('#');
      if (hash !== -1) target = target.slice(0, hash);
      if (target === '') continue;
      target = target.replaceAll('\\ ', ' ');
      if (URLISH.test(target) || EMAILISH.test(target)) continue;
      const ok = target.startsWith('./') || target.startsWith('../') || target.startsWith('~/')
        || (target.startsWith('/') && target !== '/')
        || (!target.startsWith('@') && !/^[#%^&*()]+/.test(target) && /^[a-zA-Z0-9._-]/.test(target));
      if (!ok) continue;
      const abs = target.startsWith('~/') ? join(homedir(), target.slice(2)) : isAbsolute(target) ? target : resolve(dirname(filePath), target);
      if (!seen.has(abs)) {
        seen.add(abs);
        found.push(abs);
      }
    }
  }
  return found;
}

/**
 * Normalize a rule's `paths:` frontmatter: strip a trailing `/**`, drop empty
 * entries; all-`**` means unconditional.
 * @param value - frontmatter `paths` value.
 * @returns glob list, or undefined when the rule is unconditional.
 */
export function rulePaths(value) {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : String(value).split(','))
    .map(s => String(s).trim())
    .map(s => (s.endsWith('/**') ? s.slice(0, -3) : s))
    .filter(s => s.length > 0);
  if (list.length === 0 || list.every(s => s === '**')) return undefined;
  return list;
}
