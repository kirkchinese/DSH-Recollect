/**
 * Dedicated memory tools (used when the sandbox keeps the built-in write/edit
 * tools out of the memory directory) and the post-write lint shared by both
 * write modes.
 * @module @kirkchinese/dsh-recollect/memtool
 */
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { INDEX_FILE, INDEX_MAX_LINES, INDEX_MAX_UNITS, RECALL_MAX_BYTES, RECALL_MAX_LINES } from './constants.js';
import { formatKB } from './render.js';
import { splitFrontmatter } from './markdown.js';
import { cleanText } from './sanitize.js';
import { t } from './i18n.js';

/** Dedicated memory tool names. */
export const TOOL = Object.freeze({ list: 'memory_list', read: 'memory_read', write: 'memory_write', edit: 'memory_edit', remove: 'memory_delete' });
import { within } from './paths.js';

/** Largest memory document the tools accept (bytes). */
export const MAX_DOCUMENT_BYTES = 102400;

/** Patterns refused by memory_write (credentials never belong in memory). */
const SECRET_PATTERNS = [
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];

/**
 * Secret labels found in text.
 * @param text - content.
 */
export function detectSecrets(text) {
  return [...new Set(SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label))];
}

/**
 * Resolve a memory-relative path and refuse escapes, links and non-.md files.
 * @param memoryDir - absolute memory directory.
 * @param p - relative path, optionally starting with `/`.
 * @param opts - `{ mustExist?: boolean }`.
 * @returns absolute path.
 */
export async function resolveMemoryPath(memoryDir, p, { mustExist = false } = {}) {
  if (typeof p !== 'string' || p.trim() === '') throw new Error('path is required');
  const rel = p.trim().replace(/^\/+/, '');
  const abs = resolve(memoryDir, rel);
  if (!within(memoryDir, abs) || abs === resolve(memoryDir)) throw new Error(`invalid path "${p}": it must name a file inside the memory directory`);
  if (!abs.endsWith('.md')) throw new Error(`invalid path "${p}": memory files are Markdown (.md)`);
  if (rel.split('/').some(seg => seg.startsWith('.'))) throw new Error(`invalid path "${p}": hidden files and folders are reserved`);
  const rootReal = await realpath(memoryDir);
  // Every existing ancestor must stay inside the real memory root.
  let probe = dirname(abs);
  while (within(memoryDir, probe)) {
    const real = await realpath(probe).catch(() => undefined);
    if (real !== undefined) {
      if (!within(rootReal, real)) throw new Error(`invalid path "${p}": it leaves the memory directory through a link`);
      break;
    }
    probe = dirname(probe);
  }
  const st = await lstat(abs).catch(() => undefined);
  if (st?.isSymbolicLink()) throw new Error(`invalid path "${p}": memory files cannot be links`);
  if (st !== undefined && !st.isFile()) throw new Error(`invalid path "${p}": not a regular file`);
  if (mustExist && st === undefined) throw new Error(`"${p}" does not exist in the memory directory`);
  return abs;
}

/**
 * Atomic text write (temp file + rename).
 * @param abs - destination.
 * @param content - text.
 */
async function atomicWrite(abs, content) {
  await mkdir(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.${basename(abs)}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, abs);
}

const shown = rel => rel.split(sep).join('/');

/**
 * Post-write lint: index size, recall limit of
 * topic files, continuation files and frontmatter description.
 * @param params - `{ memoryDir, path, content?: string }`; `content` is the
 *   full text the model supplied (write), absent for edits.
 * @returns lint messages (empty when clean).
 */
export async function lintMemoryWrite({ memoryDir, path, content }) {
  const abs = resolve(path);
  if (!within(memoryDir, abs) || !abs.endsWith('.md')) return [];
  const text = await readFile(abs, 'utf8').catch(() => undefined);
  if (text === undefined) return [];
  const rel = shown(relative(memoryDir, abs));
  if (rel === INDEX_FILE) {
    const trimmed = text.trim();
    const lines = trimmed === '' ? 0 : trimmed.split('\n').length;
    const dims = [
      { frac: lines / INDEX_MAX_LINES, over: lines > INDEX_MAX_LINES, size: `${lines} lines`, cap: `${INDEX_MAX_LINES}-line`, target: `${Math.floor(INDEX_MAX_LINES * 0.7)} lines` },
      { frac: trimmed.length / INDEX_MAX_UNITS, over: trimmed.length > INDEX_MAX_UNITS, size: formatKB(trimmed.length), cap: formatKB(INDEX_MAX_UNITS), target: formatKB(Math.floor(INDEX_MAX_UNITS * 0.7)) },
    ].sort((a, b) => b.frac - a.frac);
    const d = dims[0];
        if (d.over) return [t().lint.indexOver({ path: rel, size: d.size, cap: d.cap, target: d.target })];
    if (d.frac >= 0.8) return [t().lint.indexNear({ path: rel, size: d.size, cap: d.cap, target: d.target })];
    return [];
  }
  const out = [];
  const bytes = Buffer.byteLength(text);
  const lines = text.split('\n').length;
  const dims = [
    { frac: bytes / RECALL_MAX_BYTES, over: bytes > RECALL_MAX_BYTES, size: formatKB(bytes), cap: formatKB(RECALL_MAX_BYTES), target: formatKB(Math.floor(RECALL_MAX_BYTES * 0.7)), shownLimit: formatKB(RECALL_MAX_BYTES) },
    { frac: lines / RECALL_MAX_LINES, over: lines > RECALL_MAX_LINES, size: `${lines} lines`, cap: `${RECALL_MAX_LINES}-line`, target: `${Math.floor(RECALL_MAX_LINES * 0.7)} lines`, shownLimit: `${RECALL_MAX_LINES} lines` },
  ].sort((a, b) => b.frac - a.frac);
  const d = dims[0];
  if (d.over) out.push(t().lint.fileOver({ path: rel, size: d.size, cap: d.cap, shown: d.shownLimit, target: d.target }));
  else if (d.frac >= 0.8) out.push(t().lint.fileNear({ path: rel, size: d.size, cap: d.cap, target: d.target }));
  const cont = /^(.*\D)-(\d{1,2})\.md$/.exec(basename(abs));
  if (cont !== null && Number(cont[2]) >= 2) {
    const base = cont[1];
    const prev = String(Number(cont[2]) - 1);
    const candidates = [`${base}.md`, `${base}-${prev}.md`, `${base}-${prev.padStart(cont[2].length, '0')}.md`];
    for (const c of candidates) {
      if (await stat(join(dirname(abs), c)).then(s => s.isFile(), () => false)) {
        out.push(t().lint.continuation({ file: basename(abs), base, cap: formatKB(RECALL_MAX_BYTES) }));
        break;
      }
    }
  }
  if (content !== undefined) {
    const description = splitFrontmatter(content).frontmatter.description;
    if (typeof description !== 'string' || description.trim() === '') out.push(t().lint.noDescription);
    else if (description.length > 300) out.push(t().lint.longDescription(description.length));
  }
  return out;
}

/**
 * List memory files (recursive .md, hidden entries skipped), sorted by path.
 * @param memoryDir - absolute directory.
 * @param prefix - optional relative directory prefix.
 */
export async function listMemoryFiles(memoryDir, prefix = '') {
  const out = [];
  const walk = async dir => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith('.md')) {
        const st = await stat(p);
        out.push({ path: `/${shown(relative(memoryDir, p))}`, bytes: st.size, updatedAt: new Date(st.mtimeMs).toISOString() });
      }
    }
  };
  await walk(memoryDir);
  const pre = prefix ? `/${prefix.replace(/^\/+|\/+$/g, '')}/` : '/';
  return out.filter(f => f.path.startsWith(pre)).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Tool definitions (plain objects for defineTool). Descriptions are read from
 * the active locale when the definitions are built.
 * @param deps - `{ dirFor(exec): Promise<string>, canWrite(exec): string|undefined, onWritten(exec, abs, content?): Promise<string[]> }`.
 */
export function memoryToolDefinitions(deps) {
  const tx = t();
  const P = tx.tools.params;
  const E = tx.tools.err;
  const OK = tx.tools.ok;
  const json = { schema: { type: 'json' }, render: (_a, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] };
  const lintText = msgs => (msgs.length > 0 ? `\n\n${msgs.join('\n\n')}` : '');
  const refuseIfReadOnly = exec => {
    const reason = deps.canWrite(exec);
    if (reason) throw new Error(reason);
  };
  return [
    {
      name: TOOL.list,
      description: tx.tools.list,
      parameters: { path_prefix: { type: 'string', description: P.path_prefix } },
      output: json,
      async execute(args, exec) {
        const dir = await deps.dirFor(exec);
        return { directory: dir, entries: await listMemoryFiles(dir, args.path_prefix ?? '') };
      },
      presentCall: args => ({ card: 'generic', title: `记忆 · 列表${args.path_prefix ? ` ${args.path_prefix}` : ''}`, kind: 'read' }),
    },
    {
      name: TOOL.read,
      description: tx.tools.read,
      parameters: { path: { type: 'string', required: true, description: P.path } },
      output: json,
      async execute(args, exec) {
        const dir = await deps.dirFor(exec);
        const abs = await resolveMemoryPath(dir, args.path, { mustExist: true });
        const st = await stat(abs);
        return { path: args.path, updatedAt: new Date(st.mtimeMs).toISOString(), content: await readFile(abs, 'utf8') };
      },
      presentCall: args => ({ card: 'generic', title: `记忆 · 读取 ${args.path ?? ''}`, kind: 'read' }),
    },
    {
      name: TOOL.write,
      description: tx.tools.write,
      parameters: {
        path: { type: 'string', required: true, description: P.path },
        content: { type: 'string', required: true, description: P.content },
      },
      output: json,
      async execute(args, exec) {
        refuseIfReadOnly(exec);
        const dir = await deps.dirFor(exec);
        const abs = await resolveMemoryPath(dir, args.path);
        const content = cleanText(String(args.content ?? ''));
        if (content.trim() === '') throw new Error(E.empty);
        const bytes = Buffer.byteLength(content);
        if (bytes > MAX_DOCUMENT_BYTES) throw new Error(E.tooLarge(bytes, MAX_DOCUMENT_BYTES));
        const secrets = detectSecrets(content);
        if (secrets.length > 0) throw new Error(E.secrets(secrets));
        const existed = await stat(abs).then(() => true, () => false);
        await atomicWrite(abs, content);
        const lint = await deps.onWritten(exec, abs, content);
        return `${existed ? OK.updated(args.path, bytes) : OK.created(args.path, bytes)}${lintText(lint)}`;
      },
      presentCall: args => ({ card: 'generic', title: `记忆 · 写入 ${args.path ?? ''}`, kind: 'edit' }),
    },
    {
      name: TOOL.edit,
      description: tx.tools.edit,
      parameters: {
        path: { type: 'string', required: true, description: P.path },
        old_string: { type: 'string', required: true, description: P.old_string },
        new_string: { type: 'string', required: true, description: P.new_string },
        replace_all: { type: 'boolean', description: P.replace_all },
      },
      output: json,
      async execute(args, exec) {
        refuseIfReadOnly(exec);
        const dir = await deps.dirFor(exec);
        const abs = await resolveMemoryPath(dir, args.path, { mustExist: true });
        const before = await readFile(abs, 'utf8');
        const count = before.split(args.old_string).length - 1;
        if (args.old_string === '' || count === 0) throw new Error(E.notFound(args.path));
        if (count > 1 && args.replace_all !== true) throw new Error(E.notUnique(count, args.path));
        const after = cleanText(args.replace_all ? before.split(args.old_string).join(args.new_string) : before.replace(args.old_string, () => args.new_string));
        const secrets = detectSecrets(after);
        if (secrets.length > 0) throw new Error(E.secrets(secrets));
        if (Buffer.byteLength(after) > MAX_DOCUMENT_BYTES) throw new Error(E.editTooLarge(args.path, MAX_DOCUMENT_BYTES));
        await atomicWrite(abs, after);
        const lint = await deps.onWritten(exec, abs, undefined);
        return `${OK.edited(args.path, args.replace_all ? count : 1)}${lintText(lint)}`;
      },
      presentCall: args => ({ card: 'generic', title: `记忆 · 编辑 ${args.path ?? ''}`, kind: 'edit' }),
    },
    {
      name: TOOL.remove,
      description: tx.tools.delete,
      parameters: { path: { type: 'string', required: true, description: P.path } },
      output: json,
      async execute(args, exec) {
        refuseIfReadOnly(exec);
        const dir = await deps.dirFor(exec);
        const abs = await resolveMemoryPath(dir, args.path, { mustExist: true });
        await rm(abs);
        return OK.deleted(args.path);
      },
      presentCall: args => ({ card: 'generic', title: `记忆 · 删除 ${args.path ?? ''}`, kind: 'delete' }),
    },
  ];
}
