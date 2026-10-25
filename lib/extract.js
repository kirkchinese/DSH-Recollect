import { randomUUID, createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import { t } from './i18n.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { within, expandHome } from './paths.js';
import { sanitize } from './sanitize.js';

export function textContent(content) {
  return typeof content === 'string' ? content : (content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

/** Deliberate deviation from CC's whitespace-only heuristic: >=3 CJK characters count too. */
export function hasUserProse(message) {
  if (!message || message.isMeta || message.source?.kind !== 'user') return false;
  const text = textContent(message.content).trim();
  return text.split(/\s+/).filter(Boolean).length >= 3 || (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length >= 3;
}

/** Cursor is the last consumed event seq, not an array offset (initially -1). */
export function inspectExtractionRange(events, cursor, memoryDir, cwd = process.cwd()) {
  // A missing cursor (import/replacement) falls back to the complete available history.
  const found = cursor < 0 || events.some(e => e.seq === cursor);
  const range = found ? events.filter(e => e.seq > cursor) : events;
  let directWrite = false;
  for (const e of range) {
    if (e.type !== 'tool/call') continue;
    const call = e.data; let args;
    try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; } catch { continue; }
    if (['memory_write', 'memory_edit', 'memory_delete'].includes(call.name)) directWrite = true;
    if (['write', 'edit'].includes(call.name) && typeof args?.file_path === 'string' && within(memoryDir, resolve(cwd ?? process.cwd(), expandHome(args.file_path)))) directWrite = true;
  }
  const prose = range.some(e => e.type === 'user/message' && hasUserProse(e.data));
  return { cursor: events.at(-1)?.seq ?? cursor, messageCount: range.filter(e => ['user/message', 'assistant/message'].includes(e.type)).length,
    skip: directWrite ? 'direct-write' : !prose ? 'no-prose' : null };
}

/** Small local manifest, recursive without following symlinks; hashes also detect same-mtime edits. */
export async function scanMemories(memoryDir) {
  const files = new Map();
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      try {
        const [data, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
        const field = name => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(data)?.[1]?.replace(/^['"]|['"]$/g, '') ?? '';
        files.set(path, { mtime: info.mtimeMs, digest: createHash('sha256').update(data).digest('hex'), type: field('type') || 'memory', description: field('description') });
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  await walk(resolve(memoryDir)); return files;
}

export function changedMemoryPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p)?.digest !== after.get(p)?.digest || before.get(p)?.mtime !== after.get(p)?.mtime);
}

export function memoryManifest(files, dir) {
  return [...files].map(([path, f]) => `- [${f.type}] ${path.slice(resolve(dir).length + 1)} (${new Date(f.mtime).toISOString()}): ${f.description}`).map(s => sanitize(s).replace(/\s*\n\s*/g, ' ')).join('\n');
}

export function toolConstraints(toolsMode = false) {
  return t().extract.tools(toolsMode).replace(/[。.;；]\s*$/, '');
}

export function renderExtractionPrompt({ messageCount, manifest = '', toolsMode = false }) {
  return t().extract.prompt({ messageCount, manifest, tools: toolConstraints(toolsMode), toolsMode });
}

export function memoryUpdateText(sourceLabel, paths) {
  const source = sourceLabel === 'dream' || /consolidation/i.test(String(sourceLabel)) ? 'dream' : 'extract';
  const count = paths.filter(p => basename(p) !== 'MEMORY.md').length;
  const cleanPaths = paths.map(p => sanitize(p).replace(/\s+/g, ' '));
  return t().memoryUpdate({ source, count, paths: cleanPaths });
}

export function injectMemoryUpdate(agent, sourceLabel, paths) {
  const { text, summary } = memoryUpdateText(sourceLabel, paths);
  agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'recollect', form: 'notice', role: 'memory-update', summary } }));
}

export function isMemoryChild(agent, policy) {
  return agent.session.header.origin === 'subagent' || policy.isRestricted?.(agent.session.id) === true;
}

export function usesMemoryTools(memory, agent) {
  return memory.toolNames(agent).write.some(name => name.startsWith('memory_'));
}

/** Reserve restrictions BEFORE publishing the fork; result contains no child session events. */
export async function runMemoryChild({ ctx, agent, policy, budget, memoryDir, kind, prompt, route, maxSteps, signal, activations }) {
  const childId = SessionId(`session-${randomUUID()}`);
  policy.restrict(childId, { memoryDir, kind }); budget.set(childId, maxSteps);
  let activation;
  try {
    signal.throwIfAborted();
    activation = await ctx.subagents.startActivation({ provider: 'fork', label: kind === 'dream' ? 'Memory consolidation' : 'Memory extraction', childId,
      request: { parent: agent, prompt: [{ type: 'text', text: prompt }], ...(route?.provider && route?.model ? { agentOptions: { provider: route.provider, model: route.model } } : {}) }, signal, delivery: 'caller' });
    activations.add(activation);
    return await activation.result;
  } finally {
    try { if (activation) await activation.dispose(); }
    finally { activations.delete(activation); policy.release(childId); budget.clear(childId); }
  }
}

export function reportFailure(log, message, error) {
  try { if (typeof log?.warn === 'function') log.warn(`${message}: ${error?.message ?? error}`); else if (typeof log === 'function') log(`${message}: ${error?.message ?? error}`); } catch { /* logging never breaks callbacks */ }
}

export function createExtractor({ ctx, config, log, memory, policy, budget }) {
  const states = new Map(), activations = new Set(), tasks = new Set(), controller = new AbortController();
  let disposed = false;
  async function pass(agent, events, state, trailing = false) {
    const memoryDir = memory.dirFor(agent);
    const range = inspectExtractionRange(events, state.cursor, memoryDir, ctx.workingDirectory?.get(agent.session) ?? agent.session.header.cwd);
    if (range.skip) { state.cursor = range.cursor; return; }
    if (!trailing && ++state.turns < config.extract.everyNTurns) return;
    state.turns = 0;
    const before = await scanMemories(memoryDir);
    const prompt = renderExtractionPrompt({ messageCount: range.messageCount, manifest: memoryManifest(before, memoryDir), toolsMode: usesMemoryTools(memory, agent) });
    try {
      await runMemoryChild({ ctx, agent, policy, budget, memoryDir, kind: 'extract', prompt, route: config.extract.route, maxSteps: config.extract.maxTurns, signal: controller.signal, activations });
      state.cursor = range.cursor;
    } finally {
      const changed = changedMemoryPaths(before, await scanMemories(memoryDir));
      if (changed.length && !disposed) injectMemoryUpdate(agent, 'Background memory extraction', changed);
    }
  }
  async function drain(agent, events, state) {
    state.running = true;
    try {
      let trailing = false;
      do {
        state.pending = null;
        if (disposed || memory.isPaused(agent.session)) break;
        try { await pass(agent, events, state, trailing); } catch (e) { reportFailure(log, 'Memory extraction failed', e); }
        events = state.pending; trailing = true;
      } while (events && config.extract.everyNTurns <= 1 && !disposed);
    } finally { state.running = false; state.pending = null; }
  }
  return {
    onTurnEnd(agent) {
      try {
        if (disposed || !config.extract.enabled || memory.isPaused(agent.session) || isMemoryChild(agent, policy)) return;
        const id = agent.session.id;
        if (!states.has(id)) states.set(id, { cursor: -1, turns: 0, running: false, pending: null });
        const state = states.get(id), events = agent.session.snapshotEvents();
        if (state.running) { state.pending = events; return; }
        const task = drain(agent, events, state).catch(e => reportFailure(log, 'Memory extraction failed', e));
        tasks.add(task); void task.finally(() => tasks.delete(task));
      } catch (e) { reportFailure(log, 'Memory extraction callback failed', e); }
    },
    /** Wait up to `ms` for running passes, without aborting them. */
    async drain(ms = 60000) {
      let timer;
      await Promise.race([Promise.allSettled([...tasks]), new Promise(r => { timer = setTimeout(r, ms); timer.unref?.(); })]);
      clearTimeout(timer);
    },
    async dispose() {
      disposed = true; controller.abort();
      await Promise.allSettled([...activations].map(a => a.dispose()));
      await Promise.allSettled([...tasks]); states.clear();
    },
  };
}
