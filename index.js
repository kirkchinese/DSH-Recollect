/**
 * Claude-Code-style memory for DSH, for every model.
 *
 * - Instruction files (Managed → User → Project root→cwd → Local) with
 *   `@import`, rules and conditional rules, injected as one durable
 *   `<system-reminder>` before the first request, re-announced as a diff on
 *   resume / pause toggles and in full after compaction hides it.
 * - Persistent memory: complete writing guidance in the system prompt (no
 *   model-dependent shortening) and the MEMORY.md index in the instruction
 *   block. Writes go through the built-in write/edit tools when the sandbox
 *   allows the memory directory, otherwise through dedicated memory tools.
 * - Post-write lint, nested instruction discovery, optional recall,
 *   background extraction, dream consolidation and agent memory.
 * @module @kirkchinese/dsh-recollect
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { Config, isResolved, liveConfig, resolveConfig } from './lib/config.js';
import { INDEX_FILE, RECALL_SESSION_BUDGET, SOURCE_KIND } from './lib/constants.js';
import { setLanguage, t } from './lib/i18n.js';
import { InstructionLoader } from './lib/instructions.js';
import { agentsHome, dshHome, dshProjectKey, expandHome, projectSlug, within } from './lib/paths.js';
import { preambleFor, reminder, renderBaseline, renderDiff, renderNested, truncateIndex } from './lib/render.js';
import { announcedState, diffInstructions, digest, everAnnounced, instructionSource } from './lib/state.js';
import { lintMemoryWrite, memoryToolDefinitions, TOOL } from './lib/memtool.js';
import { claudeMemorySlugs, importMemoryDir } from './lib/importer.js';
import { readForRecall, renderRecalled, selectByBm25, selectBySelector } from './lib/recall.js';
import { cleanText } from './lib/sanitize.js';

export const name = 'recollect';
export const inject = ['systemPrompt', 'tools', 'workingDirectory', 'agents'];
export { Config };

/**
 * Synchronous canonical git root (the system prompt is assembled before any
 * async hook can run, so the memory path must be computable synchronously).
 * @param start - absolute directory.
 */
function gitRootSync(start) {
  let dir = resolve(start);
  for (;;) {
    const dotgit = join(dir, '.git');
    let st;
    try {
      st = statSync(dotgit);
    } catch {
      st = undefined;
    }
    if (st?.isDirectory()) return dir;
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, 'utf8'));
      if (m) {
        const parts = resolve(dir, m[1].trim()).split(sep);
        const i = parts.lastIndexOf('worktrees');
        if (i > 0 && parts[i - 1] === '.git') return parts.slice(0, i - 1).join(sep) || sep;
      }
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const truthy = v => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const falsy = v => /^(0|false|no|off)$/i.test(String(v ?? '').trim());

/** Text of the human messages in a batch. */
function humanText(messages) {
  return messages
    .filter(m => m.source?.kind === 'user')
    .flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text))
    .join('\n')
    .trim();
}

/**
 * Register the plugin.
 * @param ctx - plugin context.
 * @param rawConfig - loader row config.
 */
export function apply(ctx, rawConfig) {
  const config = liveConfig(isResolved(rawConfig) ? rawConfig : resolveConfig(rawConfig));
  setLanguage(() => config.language);
  const log = (...args) => ctx.logger?.warn?.(...args) ?? console.warn('[recollect]', ...args);
  const home = dshHome();
  const subst = p => resolve(expandHome(p.replaceAll('{dshHome}', home).replaceAll('{agentsHome}', agentsHome())));
  const env = process.env;
  const instructionsOn = () => config.instructions.enabled && !truthy(env.DSH_RECOLLECT_DISABLE_INSTRUCTIONS);
  // An explicit falsy env value forces memory on.
  const memoryOn = () => (falsy(env.DSH_RECOLLECT_DISABLE_MEMORY) ? true : truthy(env.DSH_RECOLLECT_DISABLE_MEMORY) ? false : config.memory.enabled);
  const preambleNow = () => preambleFor(config.instructions.authority);
  const loader = () => new InstructionLoader({
    enabled: instructionsOn(),
    managedDirs: config.instructions.managedDirs.map(subst),
    userFiles: config.instructions.userFiles.map(subst),
    userRulesDirs: config.instructions.userRulesDirs.map(subst),
    projectFiles: config.instructions.projectFiles,
    projectDotFiles: config.instructions.projectDotFiles,
    rulesDirs: config.instructions.rulesDirs,
    localFiles: config.instructions.localFiles,
    excludes: config.instructions.excludes.map(subst),
    allowExternalImports: config.instructions.allowExternalImports,
    dedupeContent: config.instructions.dedupeContent,
    log: msg => log(msg),
  });
  const stateFile = join(home, 'recollect', 'state.json');
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort(new Error('recollect disposed')), 'recollect.lifetime');

  // ---------- Persistent per-session flags (pause) ----------
  /** @type {{ paused: Record<string, boolean> }} */
  let persisted = { paused: {} };
  try {
    persisted = { paused: {}, ...JSON.parse(readFileSync(stateFile, 'utf8')) };
  } catch { /* first run */ }
  let saving = Promise.resolve();
  const save = () => {
    saving = saving.then(async () => {
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(stateFile, JSON.stringify(persisted, null, 1));
    }).catch(error => log('state save failed', error));
    return saving;
  };
  const isPaused = session => persisted.paused[session.id] === true;

  // ---------- Per-agent facts ----------
  /** @type {WeakMap<object, { cwd: string, memoryDir: string, mode: string, toolsFiber?: object, seen: boolean, pendingReason?: string, touches: string[], surfaced: Set<string>, selectorHistory: object[] }>} */
  const agents = new WeakMap();
  const restrictedChildren = new Set();
  const isChild = agent => restrictedChildren.has(agent.session.id);

  const cwdOf = agent => {
    try {
      return ctx.workingDirectory.get(agent.session);
    } catch {
      return agent.session.header.cwd ?? process.cwd();
    }
  };
  const claudeHomeNow = () => subst(config.memory.claudeHome || process.env.CLAUDE_CONFIG_DIR || '~/.claude');
  const slugFor = cwd => projectSlug(gitRootSync(cwd) ?? resolve(cwd));
  const memoryDirFor = cwd => {
    if (config.memory.directory) return subst(config.memory.directory);
    if (config.memory.shareWithClaudeCode) return join(claudeHomeNow(), 'projects', slugFor(cwd), 'memory');
    return join(subst(config.memory.root), 'projects', slugFor(cwd));
  };
  /** 'files' | 'tools' | 'readonly'. */
  const writeModeFor = (agent, memoryDir) => {
    const policySvc = ctx.get?.('sandboxPolicy');
    let mode;
    try {
      mode = policySvc?.resolve({ session: agent.session });
    } catch {
      mode = undefined;
    }
    if (mode?.mode === 'read-only') return 'readonly';
    if (config.memory.writeMode !== 'auto') return config.memory.writeMode;
    if (mode === undefined || mode.mode === 'danger-full-access') return 'files';
    return within(mode.workspaceRoot, memoryDir) ? 'files' : 'tools';
  };
  const info = agent => {
    let st = agents.get(agent);
    const cwd = cwdOf(agent);
    const dirKey = JSON.stringify([cwd, config.memory.root, config.memory.directory, config.memory.shareWithClaudeCode, config.memory.claudeHome, config.memory.writeMode]);
    if (st === undefined || st.dirKey !== dirKey) {
      const memoryDir = memoryDirFor(cwd);
      if (memoryOn()) {
        try {
          mkdirSync(memoryDir, { recursive: true });
        } catch (error) {
          log('cannot create memory directory', memoryDir, error);
        }
      }
      st = { ...(st ?? { seen: false, touches: [], surfaced: new Set(), selectorHistory: [] }), cwd, dirKey, memoryDir, mode: writeModeFor(agent, memoryDir) };
      agents.set(agent, st);
    }
    return st;
  };
  const memoryActive = agent => memoryOn() && !isPaused(agent.session);

  // ---------- Memory tools (scoped, only in tools mode) ----------
  const toolDefs = memoryToolDefinitions({
    dirFor: async exec => (exec.agent ? info(exec.agent).memoryDir : memoryDirFor(process.cwd())),
    canWrite: exec => {
      if (exec.agent && !memoryActive(exec.agent)) return t().tools.err.paused;
      if (exec.agent && info(exec.agent).mode === 'readonly') return t().tools.err.readOnly;
      return undefined;
    },
    onWritten: async (exec, abs, content) => {
      if (!config.memory.lint || !exec.agent) return [];
      return lintMemoryWrite({ memoryDir: info(exec.agent).memoryDir, path: abs, content });
    },
  }).map(d => defineTool(d));
  const syncTools = agent => {
    const st = info(agent);
    st.mode = writeModeFor(agent, st.memoryDir);
    const want = memoryActive(agent) && st.mode === 'tools';
    if (want && st.toolsFiber === undefined) {
      st.toolsFiber = agent.ctx.inject(['tools'], scope => {
        for (const def of toolDefs) scope.effect(() => scope.tools.register(def), `recollect.tool.${def.name}`);
      });
    } else if (!want && st.toolsFiber !== undefined) {
      const fiber = st.toolsFiber;
      st.toolsFiber = undefined;
      Promise.resolve(fiber.dispose?.()).catch(error => log('tool cleanup failed', error));
    }
  };

  // ---------- System prompt sections (scoped per agent) ----------
  const guidanceText = agent => {
    if (!memoryActive(agent)) return '';
    const st = info(agent);
    return t().guidance({ title: 'persistent memory', dir: `${st.memoryDir}${sep}`, mode: st.mode === 'tools' ? 'tools' : 'files', readOnly: st.mode === 'readonly', extraGuidelines: [] });
  };
  const agentMemoryText = agent => {
    const scope = config.agentMemory[agent.session.header.agentPreset ?? ''];
    if (scope === undefined || !memoryOn() || isPaused(agent.session)) return '';
    const cwd = info(agent).cwd;
    const safe = (agent.session.header.agentPreset || 'unknown').replace(/[^a-zA-Z0-9\-_]/g, '-');
    const dir = scope === 'user' ? join(home, 'agent-memory', safe) : scope === 'project' ? join(cwd, '.claude', 'agent-memory', safe) : join(cwd, '.claude', 'agent-memory-local', safe);
    let index = null;
    let refused = false;
    try {
      if (scope === 'user') {
        mkdirSync(dir, { recursive: true });
      } else {
        // project/local live in the working copy: refuse links, special files
        // and anything whose real path leaves the working directory.
        mkdirSync(dir, { recursive: true });
        const real = realpathSync(dir);
        if (!lstatSync(dir).isDirectory() || !within(realpathSync(cwd), real)) refused = true;
      }
      const p = join(dir, INDEX_FILE);
      if (!refused && existsSync(p)) {
        const st = lstatSync(p);
        if (scope !== 'user' && (!st.isFile() || st.nlink > 1)) refused = true;
        else index = cleanText(truncateIndex(readFileSync(p, 'utf8')).content);
      }
    } catch {
      index = null;
    }
    // The dedicated memory tools only reach the project memory directory, so an
    // agent memory the sandbox keeps from write/edit is offered read-only.
    const mode = writeModeFor(agent, dir);
    const tx = t();
    const head = tx.guidance({ title: 'Persistent Agent Memory', dir: `${dir}${sep}`, mode: 'files', readOnly: refused || mode !== 'files', extraGuidelines: [tx.agent.scope[scope]] });
    const tail = refused ? tx.agent.indexRefused : index ? index : tx.agent.indexEmpty;
    return `${head}\n\n${tx.agent.indexHeading}\n\n${tail}`;
  };
  const fibers = new Map();
  ctx.effect(() => async () => {
    const pending = [];
    for (const [agent, fiber] of fibers) {
      pending.push(Promise.resolve(fiber?.dispose?.()));
      const st = agents.get(agent);
      if (st?.toolsFiber) pending.push(Promise.resolve(st.toolsFiber.dispose?.()));
      if (st) st.toolsFiber = undefined;
    }
    fibers.clear();
    await Promise.allSettled(pending);
  }, 'recollect.agent-fibers');
  const setupAgent = agent => {
    if (fibers.has(agent)) return;
    const fiber = agent.ctx.inject(['systemPrompt'], scope => {
      scope.systemPrompt.section({ name: 'recollect:guidance', order: 9500, interpolate: false, text: () => guidanceText(agent) });
      scope.systemPrompt.section({ name: 'recollect:agent-memory', order: 9510, interpolate: false, text: () => agentMemoryText(agent) });
    });
    fibers.set(agent, fiber);
    syncTools(agent);
  };
  for (const agent of ctx.agents.list()) setupAgent(agent);
  ctx.on('agent/created', ({ agent }) => {
    setupAgent(agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    const fiber = fibers.get(agent);
    fibers.delete(agent);
    Promise.resolve(fiber?.dispose?.()).catch(() => {});
    const st = agents.get(agent);
    if (st?.toolsFiber) Promise.resolve(st.toolsFiber.dispose?.()).catch(() => {});
    agents.delete(agent);
  });

  // ---------- Instruction announcements ----------
  const identityOf = st => JSON.stringify({ cwd: st.cwd, memoryDir: st.memoryDir });
  const loadCurrent = async agent => {
    const st = info(agent);
    const { files } = await loader().loadStartup({ cwd: st.cwd, memoryIndexPath: memoryActive(agent) ? join(st.memoryDir, INDEX_FILE) : undefined });
    const total = files.reduce((n, f) => n + f.content.length, 0);
    if (total > config.instructions.warnTotalChars) log(`${files.length} instruction files add up to ${total} chars, over the ${config.instructions.warnTotalChars}-char warning threshold (not truncated)`);
    return files;
  };
  const message = (text, source) => createUserMessage({ content: [{ type: 'text', text }], source });

  const announcements = async (agent, entering, step) => {
    const st = info(agent);
    const out = [];
    const { baseline, announced } = announcedState(agent, entering);
    const identity = identityOf(st);
    const emptyCheckDue = st.emptyIdentity === identity && st.pendingReason === undefined && !(step === 1 && config.instructions.refreshEachTurn);
    if ((baseline === undefined || baseline.identity !== identity) && !emptyCheckDue) {
      const reason = baseline !== undefined ? 'directory_changed' : everAnnounced(agent) ? 'compaction' : undefined;
      const files = await loadCurrent(agent);
      st.seen = true;
      st.pendingReason = undefined;
      // Nothing to show: add no block. Remember the empty
      // result in memory so it is not re-read at every step.
      if (files.length === 0) {
        st.emptyIdentity = identity;
        return out;
      }
      st.emptyIdentity = undefined;
      out.push(message(renderBaseline(files, preambleNow()), instructionSource('baseline', files, { identity, reason })));
      return out;
    }
    let reason = st.pendingReason;
    if (!st.seen) reason = reason ?? 'session_start';
    else if (step === 1 && config.instructions.refreshEachTurn) reason = reason ?? 'turn';
    st.seen = true;
    st.pendingReason = undefined;
    if (reason !== undefined) {
      const files = await loadCurrent(agent);
      const diff = diffInstructions(files, announced);
      if (diff !== undefined) out.push(message(renderDiff(diff, reason), instructionSource('diff', diff.files, { removed: diff.removed, reason })));
    }
    if (config.instructions.nested && st.touches.length > 0) {
      const touches = st.touches.splice(0);
      const fresh = [];
      const known = new Map(announced);
      for (const path of touches) {
        for (const f of await loader().loadForTouch({ cwd: st.cwd, filePath: path })) {
          const prev = known.get(f.path);
          if (prev !== undefined && prev.digest === digest(f.content)) continue;
          known.set(f.path, { type: f.type, digest: digest(f.content), scope: 'nested' });
          fresh.push(f);
        }
      }
      if (fresh.length > 0) out.push(message(renderNested(fresh), instructionSource('nested', fresh)));
    }
    return out;
  };

  // ---------- Recall ----------
  const routeFor = (agent, route) => {
    if (route.provider && route.model) return { provider: route.provider, model: route.model };
    const held = agent.session.requestHeader?.()?.config ?? agent.options;
    return held?.provider && held?.model ? { provider: held.provider, model: held.model } : undefined;
  };
  const complete = async (agent, route, { system, messages, maxTokens }, signal) => {
    const llm = ctx.get?.('llm');
    const r = routeFor(agent, route);
    if (llm === undefined || r === undefined) throw new Error('no LLM route for the memory selector');
    const call = await llm.prepareCall({ ...r, maxTokens }, signal);
    const assembler = new BlockAssembler();
    // Earlier selector turns are folded into one user message so the call
    // needs no synthetic assistant messages.
    const flat = messages.map(m => {
      const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return m.role === 'assistant' ? `(your earlier answer)\n${text}` : text;
    }).join('\n\n');
    const input = [createUserMessage({ content: [{ type: 'text', text: flat }], source: { kind: SOURCE_KIND } })];
    for await (const chunk of call.stream({ ...call.config, system, messages: input, sessionId: agent.session.id, signal })) assembler.push(chunk);
    if (assembler.finish?.kind !== 'stop') return '';
    return assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('');
  };
  const recallMessages = async (agent, entering, signal) => {
    if (!config.recall.enabled || !memoryActive(agent)) return [];
    const query = humanText(entering);
    if (query === '' || !/\s/.test(query.trim()) && !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(query)) return [];
    const st = info(agent);
    // Session budget (counted in UTF-16 units of
    // the recalled bodies still visible): a gate before selection, not a slice.
    let used = 0;
    for (const seq of agent.session.surface.nodes) {
      const ev = agent.session.eventAt(seq);
      if (ev?.type === 'user/message' && ev.data.source?.kind === SOURCE_KIND && ev.data.source.role === 'recall') {
        for (const r of ev.data.source.recalled ?? []) {
          st.surfaced.add(r.path);
          used += r.units ?? 0;
        }
      }
    }
    if (used >= RECALL_SESSION_BUDGET) return [];
    const exclude = new Set(st.surfaced);
    let paths;
    if (config.recall.method === 'selector') {
      const res = await selectBySelector({ memoryDir: st.memoryDir, query, exclude, history: st.selectorHistory, complete: req => complete(agent, config.recall.selector, req, signal) });
      paths = res.paths;
      st.selectorHistory.push({ query, selected: res.selectedFilenames });
    } else {
      paths = await selectByBm25({ memoryDir: st.memoryDir, query, exclude, limit: 5 });
    }
    if (paths.length === 0) return [];
    const items = [];
    for (const path of paths.slice(0, 5)) {
      const r = await readForRecall(path).catch(() => undefined);
      if (r === undefined) continue;
      const mtimeMs = statSync(path).mtimeMs;
      items.push({ path, content: r.content, mtimeMs });
      st.surfaced.add(path);
    }
    if (items.length === 0) return [];
    const texts = renderRecalled(items);
    return texts.map((text, i) => message(text, {
      kind: SOURCE_KIND,
      form: 'notice',
      role: 'recall',
      summary: `Recalled memory ${items[i].path.slice(st.memoryDir.length + 1)}`.slice(0, 120),
      recalled: [{ path: items[i].path, units: items[i].content.length }],
    }));
  };

  // ---------- Background extraction / dream (optional modules) ----------
  const background = { extractor: undefined, dreamer: undefined, policy: undefined, budget: undefined };
  const backgroundReady = (async () => {
    try {
      const guard = await import('./lib/guard.js');
      background.policy = guard.createChildToolPolicy();
      background.budget = guard.createStepBudget();
      ctx.effect(() => ctx.tools.guard(background.policy.guard), 'recollect.child-guard');
      const memory = {
        dirFor: agent => info(agent).memoryDir,
        isPaused: session => isPaused(session) || !memoryOn(),
        guidanceAvailable: true,
        toolNames: agent => ({ write: info(agent).mode === 'tools' ? [TOOL.write, TOOL.edit, TOOL.remove] : ['write', 'edit'] }),
        writeMode: agent => info(agent).mode,
        onChild: (sessionId, on) => (on ? restrictedChildren.add(sessionId) : restrictedChildren.delete(sessionId)),
      };
      // Optional services are read lazily so their absence never blocks activation.
      const services = {
        get subagents() { return ctx.get('subagents'); },
        get jobs() { return ctx.get('jobs'); },
        get sessionPersistence() { return ctx.get('sessionPersistence'); },
        get workingDirectory() { return ctx.workingDirectory; },
      };
      {
        const { createExtractor } = await import('./lib/extract.js');
        background.extractor = createExtractor({ ctx: services, config, log, memory, policy: background.policy, budget: background.budget });
      }
      {
        const { createDreamer } = await import('./lib/dream.js');
        background.dreamer = createDreamer({ ctx: services, config, log, memory, policy: background.policy, budget: background.budget, sessionsDir: agent => (agent.session.header.cwd ? join(home, 'sessions', dshProjectKey(agent.session.header.cwd)) : join(home, 'sessions', '_no-cwd')) });
      }
    } catch (error) {
      log('background memory features unavailable', error);
    }
  })();
  ctx.effect(() => async () => {
    await backgroundReady;
    await background.extractor?.drain?.(60000);
    await Promise.allSettled([background.extractor?.dispose?.(), background.dreamer?.dispose?.()]);
  }, 'recollect.background');

  // ---------- Pre-step: suppression, budget, announcements, recall ----------
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal.aborted) return decision;
    let messages = decision.messages;
    if (config.instructions.suppressBuiltin) messages = messages.filter(m => m.source?.kind !== 'agent-instructions');
    if (background.budget !== undefined && !background.budget.onPreStep(agent.session.id)) return { kind: 'reject' };
    if (isChild(agent) || background.policy?.isRestricted?.(agent.session.id)) return { ...decision, messages };
    if (step === 1 && messages.length === 0) return { ...decision, messages };
    try {
      syncTools(agent);
      const ours = await announcements(agent, messages, step);
      const recalled = step === 1 ? await recallMessages(agent, messages, signal).catch(error => {
        log('recall failed', error);
        return [];
      }) : [];
      if (ours.length === 0 && recalled.length === 0 && messages === decision.messages) return decision;
      return { ...decision, messages: [...ours, ...messages, ...recalled] };
    } catch (error) {
      if (signal.aborted) throw error;
      log('instruction announcement failed', error);
      return { ...decision, messages };
    }
  }, { prepend: true });

  // ---------- File touches (nested instructions) ----------
  ctx.on('tools/result', (exec, result) => {
    if (result.isError || exec.agent === undefined || exec.signal?.aborted) return;
    if (!['read', 'write', 'edit'].includes(exec.name)) return;
    const p = exec.arguments?.file_path;
    if (typeof p !== 'string' || p.trim() === '') return;
    const st = agents.get(exec.agent);
    if (st !== undefined) st.touches.push(p.trim());
  });

  // ---------- Post-write lint for built-in write/edit ----------
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (!config.memory.lint || decision.kind !== 'accept' || result.isError || exec.agent === undefined) return decision;
    if (exec.name !== 'write' && exec.name !== 'edit') return decision;
    const p = exec.arguments?.file_path;
    if (typeof p !== 'string') return decision;
    const st = info(exec.agent);
    const abs = resolve(st.cwd, expandHome(p));
    if (!within(st.memoryDir, abs)) return decision;
    try {
      const msgs = await lintMemoryWrite({ memoryDir: st.memoryDir, path: abs, content: exec.name === 'write' ? exec.arguments.content : undefined });
      if (msgs.length === 0) return decision;
      const extra = message(reminder(msgs.join('\n\n')), { kind: SOURCE_KIND, form: 'notice', role: 'lint', summary: 'Memory write check' });
      return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), extra] };
    } catch (error) {
      log('memory lint failed', error);
      return decision;
    }
  });

  // ---------- Turn end → background work ----------
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return;
    const agent = ctx.agents.get(session.id);
    if (agent === undefined || isChild(agent) || session.header.origin === 'subagent') return;
    void backgroundReady.then(() => {
      try {
        background.extractor?.onTurnEnd(agent);
        background.dreamer?.onTurnEnd(agent);
      } catch (error) {
        log('background memory hook failed', error);
      }
    });
  });

  // ---------- Commands ----------
  ctx.inject(['commands'], scoped => {
    const statusText = async agent => {
      const st = info(agent);
      const files = await loadCurrent(agent);
      const total = files.reduce((n, f) => n + f.content.length, 0);
      return t().commands.status({
        memory: memoryOn() ? (isPaused(agent.session) ? 'paused' : 'on') : 'off',
        mode: st.mode,
        dir: st.memoryDir,
        recall: config.recall.enabled ? config.recall.method : false,
        extract: config.extract.enabled,
        dream: config.dream.enabled,
        files: files.map(f => ({ type: f.type, path: f.path, chars: f.content.length })),
        total,
        warn: total > config.instructions.warnTotalChars ? config.instructions.warnTotalChars : false,
      });
    };
    scoped.effect(() => scoped.commands.register({
      name: 'memory',
      description: t().commands.memory.description,
      handler: async ({ agent }) => ({ kind: 'success', text: await statusText(agent) }),
    }), 'recollect.cmd.memory');
    scoped.effect(() => scoped.commands.register({
      name: 'pause-memory',
      description: t().commands.pause.description,
      handler: async ({ agent }) => {
        const now = !isPaused(agent.session);
        if (now) persisted.paused[agent.session.id] = true;
        else delete persisted.paused[agent.session.id];
        await save();
        info(agent).pendingReason = now ? 'memory_paused' : 'memory_resumed';
        syncTools(agent);
        return { kind: 'success', text: now ? t().commands.pausedOn : t().commands.pausedOff };
      },
    }), 'recollect.cmd.pause');
    scoped.effect(() => scoped.commands.register({
      name: 'remember',
      description: t().commands.remember.description,
      input: { hint: t().commands.remember.hint },
      handler: async ({ agent, rawInput }) => {
        const text = rawInput.trim();
        if (text === '') return { kind: 'error', text: t().commands.rememberUsage };
        if (!memoryActive(agent)) return { kind: 'error', text: t().commands.memoryOff };
        agent.followup(createUserMessage({ content: [{ type: 'text', text: t().rememberPrompt(text) }], source: { kind: 'user' } }));
        return { kind: 'success', text: t().commands.rememberQueued };
      },
    }), 'recollect.cmd.remember');
    scoped.effect(() => scoped.commands.register({
      name: 'memory-import',
      description: t().commands.import.description,
      input: { hint: t().commands.import.hint },
      handler: async ({ agent, rawInput }) => {
        const args = rawInput.trim().split(/\s+/).filter(Boolean);
        const all = args.includes('all');
        const dryRun = args.includes('--dry-run');
        if (config.memory.shareWithClaudeCode) return { kind: 'error', text: t().commands.import.shared };
        const pairs = all
          ? (await claudeMemorySlugs(claudeHomeNow())).map(slug => ({ slug, from: join(claudeHomeNow(), 'projects', slug, 'memory'), to: config.memory.directory ? subst(config.memory.directory) : join(subst(config.memory.root), 'projects', slug) }))
          : [{ slug: slugFor(info(agent).cwd), from: join(claudeHomeNow(), 'projects', slugFor(info(agent).cwd), 'memory'), to: info(agent).memoryDir }];
        const results = [];
        for (const p of pairs) results.push({ ...p, ...(await importMemoryDir({ from: p.from, to: p.to, dryRun })) });
        info(agent).pendingReason = 'session_start';
        return { kind: 'success', text: t().commands.import.result({ dryRun, claudeHome: claudeHomeNow(), results }) };
      },
    }), 'recollect.cmd.import');
    scoped.effect(() => scoped.commands.register({
      name: 'dream',
      description: t().commands.dream.description,
      handler: async ({ agent }) => {
        await backgroundReady;
        if (background.dreamer === undefined || !config.dream.enabled) return { kind: 'error', text: t().commands.dreamDisabled };
        try {
          return { kind: 'success', text: await background.dreamer.runNow(agent) };
        } catch (error) {
          return { kind: 'error', text: t().commands.dreamFailed(error?.message ?? String(error)) };
        }
      },
    }), 'recollect.cmd.dream');
  });
}
