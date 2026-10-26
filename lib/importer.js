/**
 * Import memories written by Claude Code (`~/.claude/projects/<slug>/memory/`)
 * into Recollect's own directory. The source is only read; the copy is
 * independent, so the two programs never write the same files.
 * @module @kirkchinese/dsh-recollect/importer
 */
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { INDEX_FILE } from './constants.js';

/**
 * All `.md` files below a directory (links and hidden entries skipped).
 * @param root - directory.
 */
async function markdownFiles(root) {
  const out = [];
  const walk = async dir => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
    }
  };
  await walk(root);
  return out.sort();
}

/** Link target of an index line `- [Title](file.md) — hook`. */
const linkOf = line => /\]\(([^)]+)\)/.exec(line)?.[1]?.trim();

/**
 * Copy one memory directory into another.
 * - Topic files: copied when absent; identical files are skipped; a different
 *   file of the same name is kept and the incoming copy is reported as a conflict.
 * - `MEMORY.md`: index lines whose link target is not yet listed are appended.
 * @param params - `{ from, to, dryRun? }` absolute directories.
 * @returns `{ copied, identical, conflicts, indexAdded }` (relative paths).
 */
export async function importMemoryDir({ from, to, dryRun = false }) {
  const result = { copied: [], identical: [], conflicts: [], indexAdded: 0 };
  const st = await lstat(from).catch(() => undefined);
  if (st === undefined || !st.isDirectory()) return result;
  if (!dryRun) await mkdir(to, { recursive: true });
  for (const src of await markdownFiles(from)) {
    const rel = relative(from, src);
    if (rel === INDEX_FILE) continue;
    const dest = join(to, rel);
    const existing = await readFile(dest, 'utf8').catch(() => undefined);
    const shown = rel.split(sep).join('/');
    if (existing === undefined) {
      if (!dryRun) {
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(src, dest);
      }
      result.copied.push(shown);
    } else if (existing === await readFile(src, 'utf8')) {
      result.identical.push(shown);
    } else {
      result.conflicts.push(shown);
    }
  }
  const srcIndex = await readFile(join(from, INDEX_FILE), 'utf8').catch(() => '');
  if (srcIndex.trim() !== '') {
    const destPath = join(to, INDEX_FILE);
    const destIndex = await readFile(destPath, 'utf8').catch(() => '');
    const known = new Set(destIndex.split('\n').map(linkOf).filter(Boolean));
    const add = srcIndex.split('\n').filter(line => {
      const link = linkOf(line);
      if (link === undefined || known.has(link)) return false;
      known.add(link);
      return true;
    });
    if (add.length > 0) {
      result.indexAdded = add.length;
      if (!dryRun) {
        const base = destIndex.trimEnd();
        await writeFile(destPath, `${base === '' ? '' : `${base}\n`}${add.join('\n')}\n`);
      }
    }
  }
  return result;
}

/**
 * Project directories under Claude Code's `projects/` that hold memories.
 * @param claudeHome - `~/.claude`.
 * @returns slugs.
 */
export async function claudeMemorySlugs(claudeHome) {
  const entries = await readdir(join(claudeHome, 'projects'), { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const st = await lstat(join(claudeHome, 'projects', e.name, 'memory')).catch(() => undefined);
    if (st?.isDirectory()) out.push(e.name);
  }
  return out.sort();
}
