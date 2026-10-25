/**
 * Path policy: home expansion, project slug, git root and memory directory.
 * @module @kirkchinese/dsh-recollect/paths
 */
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

/**
 * Expand a leading `~`.
 * @param p - path.
 */
export function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** DSH home: `$DSH_HOME` or `~/.dsh`. */
export function dshHome(env = process.env) {
  const v = env.DSH_HOME?.trim();
  return v ? resolve(expandHome(v)) : join(homedir(), '.dsh');
}

/** Shared agents home: `$DSH_AGENTS_HOME` or `~/.agents`. */
export function agentsHome(env = process.env) {
  const v = env.DSH_AGENTS_HOME?.trim();
  return v ? resolve(expandHome(v)) : join(homedir(), '.agents');
}

/**
 * 31-multiplier string hash in base 36 (long-slug suffix).
 * @param s - input.
 */
function hash36(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * Project slug: every non-alphanumeric character becomes `-`; slugs over 200
 * characters keep 200 plus `-<hash>`; NFC normalized.
 * @param absPath - absolute project path.
 */
export function projectSlug(absPath) {
  const s = absPath.replace(/[^a-zA-Z0-9]/g, '-');
  const out = s.length <= 200 ? s : `${s.slice(0, 200)}-${hash36(absPath)}`;
  return out.normalize('NFC');
}

const isDir = async p => (await stat(p).catch(() => null))?.isDirectory() === true;

/**
 * Canonical git root: the nearest ancestor with `.git`; a worktree (`.git`
 * file pointing at `<main>/.git/worktrees/<name>`) maps to the main checkout.
 * @param start - absolute directory.
 * @returns root path or null outside git.
 */
export async function canonicalGitRoot(start) {
  let dir = resolve(start);
  for (;;) {
    const dotgit = join(dir, '.git');
    const st = await stat(dotgit).catch(() => null);
    if (st?.isDirectory()) return dir;
    if (st?.isFile()) {
      const text = await readFile(dotgit, 'utf8').catch(() => '');
      const m = /^gitdir:\s*(.+)$/m.exec(text);
      if (m) {
        const gitdir = resolve(dir, m[1].trim());
        const wt = gitdir.split(sep);
        const i = wt.lastIndexOf('worktrees');
        if (i > 0 && wt[i - 1] === '.git') return wt.slice(0, i - 1).join(sep) || sep;
      }
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Memory directory for a working directory.
 * @param cwd - absolute working directory.
 * @param opts - `{ directory?: string, root: string }`; `directory` overrides
 *   everything, `root` is the base that receives `projects/<slug>/`.
 * @returns absolute directory with a trailing separator removed.
 */
export async function memoryDirFor(cwd, { directory, root }) {
  if (directory) return resolve(expandHome(directory));
  const base = (await canonicalGitRoot(cwd)) ?? resolve(cwd);
  return join(root, 'projects', projectSlug(base));
}

/**
 * Whether `child` is `parent` or below it (lexical).
 * @param parent - absolute path.
 * @param child - absolute path.
 */
export function within(parent, child) {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Resolve a possibly relative or `~` path against a base.
 * @param p - path.
 * @param base - absolute base directory.
 */
export function resolveFrom(p, base) {
  const e = expandHome(p);
  return isAbsolute(e) ? resolve(e) : resolve(base, e);
}

export { isDir };

/**
 * DSH session-store project directory name for a cwd (mirrors
 * dsh-session-persistence-jsonl `projectKey`).
 * @param cwd - session cwd.
 */
export function dshProjectKey(cwd) {
  let readable = '';
  let run = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!run) readable += '-';
      run = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      run = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      run = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}
