/** Project-scoped sharing and the injectable import workflow. */
import { resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { listMemoryFiles } from './memtool.js';
import { importMemoryDir } from './importer.js';

const identity = value => value;
const noGit = () => undefined;
const rootOf = (dir, gitRootOf, expand) => {
  const absolute = resolve(expand(dir));
  return gitRootOf(absolute) ?? absolute;
};

/** Resolve sharing without touching the filesystem except through gitRootOf. */
export function resolveShare(cwd, memoryConfig = {}, gitRootOf = noGit, expand = identity) {
  const projectRoot = gitRootOf(cwd) ?? resolve(cwd);
  if (memoryConfig.directory) return { active: false, via: 'directory', projectRoot };
  if (memoryConfig.shareWithClaudeCode) return { active: true, via: 'global', projectRoot };
  if ((memoryConfig.shareProjects ?? []).some(entry => rootOf(entry, gitRootOf, expand) === projectRoot)) {
    return { active: true, via: 'project', projectRoot };
  }
  return { active: false, via: null, projectRoot };
}

/** Add a project once, or remove every alias of its canonical root. */
export function toggleShareProject(list = [], projectRoot, on, expand = identity, gitRootOf = noGit) {
  const matches = entry => rootOf(entry, gitRootOf, expand) === projectRoot;
  if (!on) return list.filter(entry => !matches(entry));
  return list.some(matches) ? [...list] : [...list, projectRoot];
}

/** Describe importable topic files, excluding the root MEMORY.md index. */
export async function claudeMemoryStatus(dir) {
  const exists = (await lstat(dir).catch(() => undefined))?.isDirectory() === true;
  const files = exists ? await listMemoryFiles(dir) : [];
  return { dir, exists, count: files.filter(file => file.path !== '/MEMORY.md').length };
}

/** Import with explicit policy inputs and injectable I/O for isolated tests. */
export async function runMemoryImport({ projectRoot, from, to, dryRun, enabled, share }, {
  sourceStatus = claudeMemoryStatus, importDir = importMemoryDir, afterImport = () => {},
} = {}) {
  const result = { projectRoot, from, to, dryRun, copied: [], identical: [], conflicts: [], indexAdded: 0 };
  if (!enabled) return { ...result, refused: 'memory-off' };
  if (share.active) return { ...result, refused: 'shared' };
  const source = await sourceStatus(from);
  if (!source.exists || source.count === 0) return { ...result, refused: 'no-source' };
  Object.assign(result, await importDir({ from, to, dryRun }));
  if (!dryRun) await afterImport(to);
  return result;
}
