/** Memory discovery, BM25/LLM selection, and bounded recall rendering. */
import { readdir, lstat, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { INDEX_FILE, MAX_SCANNED_MEMORIES, DESCRIPTION_FALLBACK_CHARS, RECALL_MAX_SELECTED, RECALL_MAX_LINES, RECALL_MAX_BYTES } from './constants.js';
import { splitFrontmatter } from './markdown.js';
import { cleanText, neutralizeTags } from './sanitize.js';
import { t } from './i18n.js';
import { createIndex, addDocument, removeDocument, rank, relevanceFloor } from './bm25.js';

const directories = new Map();
function directoryState(memoryDir) {
  const root = resolve(memoryDir);
  if (!directories.has(root)) directories.set(root, { root, files: new Map(), index: createIndex([]) });
  return directories.get(root);
}

async function scan(state) {
  const candidates = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async entry => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      if (!entry.isFile() || !entry.name.endsWith('.md') || basename(path) === INDEX_FILE) return;
      try {
        const stat = await lstat(path);
        if (!stat.isFile()) return;
        const previous = state.files.get(path);
        if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
          candidates.push(previous);
          return;
        }
        const text = await readFile(path, 'utf8');
        const { frontmatter, body } = splitFrontmatter(text.replace(/^\uFEFF/, ''));
        const firstLine = body.split(/\r?\n/).map(line => line.replace(/^#{1,6}\s+/, '').trim()).find(Boolean);
        const file = {
          path,
          filename: relative(state.root, path).split(sep).join('/'),
          mtimeMs: stat.mtimeMs,
          type: frontmatter.metadata?.type ?? frontmatter.type,
          description: frontmatter.description ?? firstLine?.slice(0, DESCRIPTION_FALLBACK_CHARS),
          size: stat.size,
        };
        candidates.push({ ...file, text });
      } catch { /* A disappearing or unreadable memory is not a recall candidate. */ }
    }));
  }
  await walk(state.root);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filename.localeCompare(b.filename));
  const selected = candidates.slice(0, MAX_SCANNED_MEMORIES);
  const keep = new Set(selected.map(file => file.path));
  for (const path of state.files.keys()) {
    if (!keep.has(path)) {
      state.files.delete(path);
      removeDocument(state.index, path);
    }
  }
  for (const file of selected) {
    if (state.files.get(file.path) !== file) {
      addDocument(state.index, file);
      state.files.set(file.path, file);
    }
  }
  return selected.map(({ text, ...file }) => file);
}

/** Recursive, newest-first .md manifest; skip links and all MEMORY.md files. */
export async function scanMemories(memoryDir) {
  const state = directoryState(memoryDir);
  // Coalesce concurrent scans so updates cannot race against index removal.
  if (!state.pending) state.pending = scan(state).finally(() => { state.pending = undefined; });
  return state.pending;
}

export async function selectByBm25({ memoryDir, query, exclude = new Set(), limit = RECALL_MAX_SELECTED }) {
  await scanMemories(memoryDir);
  const { index } = directoryState(memoryDir);
  const candidates = RECALL_MAX_SELECTED + Math.min(exclude.size + 10, 20);
  const floor = relevanceFloor(index.docs.size);
  return rank(index, query, candidates)
    .filter(item => item.score >= floor && !exclude.has(item.path))
    .slice(0, Math.max(0, limit)).map(item => item.path);
}

const message = (role, text) => ({ role, content: [{ type: 'text', text }] });
const queryText = query => t().recall.selectorQuery(query);

export function buildSelectorRequest({ manifestFiles, query, history = [] }) {
  const manifest = manifestFiles.map(file => `- ${file.type ? `[${file.type}] ` : ''}${file.filename} (${new Date(file.mtimeMs).toISOString()})${file.description ? `: ${file.description}` : ''}`).join('\n');
  const messages = [message('user', manifest)];
  for (const turn of history) {
    messages.push(message('user', queryText(turn.query)));
    messages.push(message('assistant', JSON.stringify({ selected_memories: turn.selected })));
  }
  messages.push(message('user', queryText(query)));
  return { system: t().recall.selectorSystem, messages };
}

/** Parse just JSON objects, never JS, and never trust paths outside the manifest. */
export function parseSelectorReply(text, allowedFilenames) {
  if (typeof text !== 'string') return [];
  const allowed = new Set(allowedFilenames);
  // Accept prose/fences around one object; balanced braces respect JSON strings.
  const start = text.indexOf('{');
  if (start === -1) return [];
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end === -1) return [];
  try {
    const result = JSON.parse(text.slice(start, end));
    if (!Array.isArray(result.selected_memories) || result.selected_memories.some(value => typeof value !== 'string')) return [];
    const names = result.selected_memories.map(name => name.replace(/^\[[^\]]+\]\s+/, ''));
    return [...new Set(names.filter(name => allowed.has(name)))].slice(0, RECALL_MAX_SELECTED);
  } catch { return []; }
}

export async function selectBySelector({ memoryDir, query, exclude = new Set(), history = [], complete }) {
  const manifestFiles = (await scanMemories(memoryDir)).filter(file => !exclude.has(file.path));
  if (manifestFiles.length === 0) return { paths: [], selectedFilenames: [] };
  const request = buildSelectorRequest({ manifestFiles, query, history });
  const reply = await complete({ ...request, maxTokens: 512 });
  const selectedFilenames = parseSelectorReply(reply, manifestFiles.map(file => file.filename));
  const pathsByName = new Map(manifestFiles.map(file => [file.filename, file.path]));
  return { paths: selectedFilenames.map(name => pathsByName.get(name)), selectedFilenames };
}

/** Keep frontmatter, truncate whole lines before cleaning, then add the notice. */
export async function readForRecall(path) {
  const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
  const lines = text.split('\n');
  const kept = [];
  let bytes = 0, byBytes = false;
  for (const raw of lines) {
    if (kept.length === RECALL_MAX_LINES) break;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const nextBytes = bytes + (kept.length ? 1 : 0) + Buffer.byteLength(line);
    if (nextBytes > RECALL_MAX_BYTES) { byBytes = true; break; }
    bytes = nextBytes;
    kept.push(line);
  }
  const truncated = kept.length < lines.length;
  let content = cleanText(kept.join('\n'));
  if (truncated) content += `\n\n${t().recall.truncated(byBytes, cleanText(path))}`;
  return { content, truncated, byBytes };
}

export function renderRecalled(items, now = Date.now()) {
  return items.map((item, index) => {
    const daysOld = Math.max(0, Math.floor((now - item.mtimeMs) / 86400000));
    const age = daysOld > 1 ? `${t().recall.age(daysOld)}\n\n` : '';
    const header = `${age}${t().recall.header(cleanText(item.path))}`;
    const preamble = index === 0 ? `${t().recall.preamble}\n\n` : '';
    return `<system-reminder>\n${preamble}${neutralizeTags(`${header}\n\n${item.content}`)}\n</system-reminder>`;
  });
}

export const budgetUsed = items => items.reduce((sum, item) => sum + item.content.length, 0);
