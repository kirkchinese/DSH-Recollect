import { t } from './i18n.js';
import { readdir, stat, readFile, writeFile, unlink, utimes, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalGitRoot } from './paths.js';
import { sanitize } from './sanitize.js';
import { scanMemories, changedMemoryPaths, toolConstraints, usesMemoryTools, isMemoryChild, runMemoryChild, injectMemoryUpdate, reportFailure } from './extract.js';

export const DREAM_SCAN_THROTTLE_MS = 600000;
export const DREAM_LOCK_MAX_AGE_MS = 3600000;
export const lockPath = memoryDir => join(memoryDir, '.consolidate-lock');
export async function lastConsolidatedAt(memoryDir) {
  return (await stat(lockPath(memoryDir)).catch(e => { if (e.code === 'ENOENT') return null; throw e; }))?.mtimeMs ?? 0;
}
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
/** Lock: write/re-read, NOT atomic CAS; a simultaneous writer can race. */
export async function acquireDreamLock(memoryDir, { now = Date.now(), pid = process.pid, alive = pidAlive } = {}) {
  const path = lockPath(memoryDir), priorMtime = await lastConsolidatedAt(memoryDir);
  if (priorMtime && now - priorMtime < DREAM_LOCK_MAX_AGE_MS) {
    const holder = Number.parseInt(await readFile(path, 'utf8').catch(() => ''), 10);
    if (alive(holder)) return null;
  }
  await writeFile(path, String(pid));
  if ((await readFile(path, 'utf8')).trim() !== String(pid)) return null;
  return { path, priorMtime, pid };
}
export async function rollbackDreamLock(lock) {
  // Do not roll back somebody else's replacement lock.
  if ((await readFile(lock.path, 'utf8').catch(() => '')).trim() !== String(lock.pid)) return;
  if (!lock.priorMtime) await unlink(lock.path).catch(e => { if (e.code !== 'ENOENT') throw e; });
  else { await writeFile(lock.path, ''); const time = new Date(lock.priorMtime); await utimes(lock.path, time, time); }
}
export function dreamTimeGate({ now, lastConsolidatedAt: last, minHours, lastScanAt }) {
  if (now - last < minHours * 3600000) return 'too-soon';
  if (lastScanAt !== undefined && now - lastScanAt < DREAM_SCAN_THROTTLE_MS) return 'scan-throttled';
  return null;
}
export function dreamSessionGate(sessions, minSessions) { return sessions.length >= minSessions; }

function encodeSessionId(raw) {
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  return raw.replace(/[^A-Za-z0-9._-]/g, c => `~${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}
function decodeSessionId(raw) { return raw.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))); }
async function transcriptInfo(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const logs = entries.filter(e => e.isFile() && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(e.name));
  let mtime = 0, plain;
  for (const log of logs) {
    const path = join(dir, log.name), s = await stat(path);
    mtime = Math.max(mtime, s.mtimeMs);
    if (!log.name.endsWith('.zstd')) plain = path;
  }
  return { mtime, plain };
}
async function physicalHeader(path) {
  if (!path) return null; // Cannot decode compressed headers without a persistence provider.
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(65536), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    return JSON.parse(line);
  } catch { return null; } finally { await file.close(); }
}

/** Snapshots have no touchedAt. Join their trusted headers to actual generation-log mtimes. */
export async function sessionsSince({ ctx, sessionsDir, agent, since }) {
  const dir = typeof sessionsDir === 'function' ? sessionsDir(agent) : sessionsDir;
  if (!dir) return [];
  const current = agent.session.id;
  const project = await canonicalGitRoot(agent.session.header.cwd ?? process.cwd()) ?? resolve(agent.session.header.cwd ?? process.cwd());
  let snapshots;
  try { snapshots = await ctx.sessionPersistence?.list(); } catch { /* fallback to physical plain JSONL header */ }
  const sessions = [];
  if (snapshots) {
    for (const { header } of snapshots) {
      if (header.id === current || header.origin === 'subagent' || !header.cwd) continue;
      const root = await canonicalGitRoot(header.cwd) ?? resolve(header.cwd);
      if (root !== project) continue;
      const { mtime } = await transcriptInfo(join(dir, encodeSessionId(header.id)));
      if (mtime > since) sessions.push(header.id);
    }
  } else {
    const entries = await readdir(dir, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    for (const entry of entries) {
      if (!entry.isDirectory() || decodeSessionId(entry.name) === current) continue;
      const { mtime, plain } = await transcriptInfo(join(dir, entry.name));
      if (mtime <= since) continue;
      const header = await physicalHeader(plain);
      if (!header?.id || header.id === current || header.origin === 'subagent' || !header.cwd) continue;
      if ((await canonicalGitRoot(header.cwd) ?? resolve(header.cwd)) === project) sessions.push(header.id);
    }
  }
  return [...new Set(sessions)].sort();
}

export function renderDreamPrompt({ memoryDir, sessionsDir, sessionIds = [], toolsMode = false }) {
  return t().dream.prompt({ memoryDir, sessionsDir, sessionIds: sessionIds.map(id => sanitize(id).replace(/\s+/g, ' ')), toolsMode, tools: toolConstraints(toolsMode) });
}

export function createDreamer({ ctx, config, log, memory, policy, budget, sessionsDir }) {
  const scans = new Map(), running = new Map(), activations = new Set(), tasks = new Set(), controllers = new Set();
  let disposed = false;
  const dirForSessions = agent => typeof sessionsDir === 'function' ? sessionsDir(agent) : sessionsDir;
  async function execute(agent, memoryDir, ids, controller) {
    const lock = await acquireDreamLock(memoryDir);
    if (!lock) return 'Memory consolidation is already locked by another process.';
    let successful = false, before;
    try {
      before = await scanMemories(memoryDir);
      const prompt = renderDreamPrompt({ memoryDir, sessionsDir: dirForSessions(agent), sessionIds: ids, toolsMode: usesMemoryTools(memory, agent) });
      const result = await runMemoryChild({ ctx, agent, policy, budget, memoryDir, kind: 'dream', prompt, route: config.dream.route, maxSteps: config.dream.maxTurns ?? 30, signal: controller.signal, activations });
      if (result.stopReason !== 'completed') throw new Error(`Memory consolidation stopped: ${result.stopReason}`);
      successful = true;
      return 'Memory consolidation completed.';
    } finally {
      try {
        if (before && !disposed) {
          const changed = changedMemoryPaths(before, await scanMemories(memoryDir));
          if (changed.length) injectMemoryUpdate(agent, 'Background memory consolidation', changed);
        }
      } finally { if (!successful) await rollbackDreamLock(lock); }
    }
  }
  async function attempt(agent, force) {
    if (disposed) return 'Memory consolidation is disposed.';
    if (!config.dream.enabled && !force) return 'Memory consolidation is disabled.';
    if (memory.isPaused(agent.session) || isMemoryChild(agent, policy)) return 'Memory consolidation is paused or unavailable in a subagent.';
    const memoryDir = memory.dirFor(agent);
    if (running.has(memoryDir)) return 'Memory consolidation is already running.';
    // Reserve the directory before any await so concurrent turn-end callbacks coalesce.
    running.set(memoryDir, true);
    const controller = new AbortController(); controllers.add(controller);
    try {
      const since = await lastConsolidatedAt(memoryDir), now = Date.now();
      if (!force) {
        const gate = dreamTimeGate({ now, lastConsolidatedAt: since, minHours: config.dream.minHours, lastScanAt: scans.get(memoryDir) });
        if (gate) return `Memory consolidation skipped: ${gate}.`;
        scans.set(memoryDir, now); // consumed even when the session gate fails
      }
      const ids = await sessionsSince({ ctx, sessionsDir: dirForSessions(agent), agent, since });
      if (!force && !dreamSessionGate(ids, config.dream.minSessions)) return 'Memory consolidation skipped: not enough recent sessions.';
      if (disposed) return 'Memory consolidation is disposed.';
      let work;
      if (ctx.jobs?.start) {
        try {
          ctx.jobs.start({ kind: 'memory-dream', label: 'Memory consolidation', owner: agent.session.id, run(job) {
            work = execute(agent, memoryDir, ids, controller);
            return { cancel() { controller.abort(); }, done: work.then(text => { job.append(text); return { status: controller.signal.aborted ? 'killed' : 'completed', detail: text }; }, e => ({ status: controller.signal.aborted ? 'killed' : 'failed', detail: String(e.message ?? e) })) };
          } });
        } catch (e) { if (work) throw e; reportFailure(log, 'Memory consolidation Jobs UI unavailable; running directly', e); }
      }
      return await (work ?? execute(agent, memoryDir, ids, controller));
    } catch (e) { reportFailure(log, 'Memory consolidation failed', e); return `Memory consolidation failed: ${e.message ?? e}`; }
    finally { controllers.delete(controller); running.delete(memoryDir); }
  }
  function start(agent, force) {
    const task = attempt(agent, force).catch(e => { reportFailure(log, 'Memory consolidation callback failed', e); return `Memory consolidation failed: ${e.message ?? e}`; }); tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task)); return task;
  }
  return {
    onTurnEnd(agent) { void start(agent, false).catch(e => reportFailure(log, 'Memory consolidation callback failed', e)); },
    runNow(agent) { return start(agent, true); },
    async dispose() {
      disposed = true; for (const controller of controllers) controller.abort();
      await Promise.allSettled([...activations].map(a => a.dispose()));
      await Promise.allSettled([...tasks]); scans.clear();
    },
  };
}
