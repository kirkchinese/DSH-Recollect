/** Free Claude: an unofficial, independently authored DSH working preset. */
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { join } from 'node:path';
import { t } from './i18n.js';
import { dshHome } from './paths.js';
import { createBudgetStore } from './budget-store.js';
import { DEFAULT_TOKEN_BUDGET, tokenBudget, TokenLedger } from './token-ledger.js';
import { registerFreeClaudePreset } from './preset.js';

export const name = 'free-claude';
export const inject = ['agents'];
export const Config = z.object({
  enabled: z.boolean().default(true).description('Enable the unofficial Free Claude preset behavior.'),
  presets: z.array(z.string()).default(['free-claude']).description('Composed preset IDs that use Free Claude.'),
  toolGuidance: z.boolean().default(true).description('Include practical tool guidance.'),
  totalTokens: z.boolean().default(true).description('Include the fixed budget and append pacing reminders.'),
  totalTokensBudget: z.number().min(1).default(DEFAULT_TOKEN_BUDGET).description('Token budget locked on first use per session; changes apply to new sessions.'),
  registerPreset: z.boolean().default(true).description('Register the Free Claude agent preset as a live copy of the host standard preset (restart to change).'),
  presetBase: z.string().default('standard').description('Preset whose plugin rows Free Claude copies.'),
  drop: z.array(z.string()).default(['deployment:persona-prefix', 'deployment:persona-suffix']).description('Sections to omit; all other plugin sections remain.'),
}).volatile();
export const ORDERS = Object.freeze({ core: -990, budgetLine: -970, toolGuidance: -960 });

export function apply(ctx, rawConfig) {
  const unwrap = value => {
    while (value && typeof value.get === 'function') value = value.get();
    return value;
  };
  const read = () => ({ ...unwrap(Config({})), ...unwrap(rawConfig) });
  const active = agent => {
    let preset = agent.session.header.agentPreset ?? '';
    try { preset = ctx.get?.('agentPresets')?.composedPreset(agent.ctx) ?? preset; } catch { /* older host */ }
    const config = read();
    return config.enabled && config.presets.includes(preset);
  };
  const ledger = new TokenLedger();
  const budgets = new Map(), steps = new Map(), compactions = new Map(), measured = new Map();
  const warn = (...args) => ctx.logger?.warn?.(...args);
  const store = createBudgetStore(join(dshHome(), 'recollect', 'budgets'), { log: warn });
  const budgetFor = agent => {
    const id = agent.session.id;
    if (!budgets.has(id)) budgets.set(id, store.resolve(id, tokenBudget(read().totalTokensBudget)));
    return budgets.get(id);
  };
  const measure = session => {
    let value;
    try { value = ctx.get?.('tokenMeter')?.measure(session)?.totalTokens; } catch { /* unavailable */ }
    if (!Number.isFinite(value) || value < 0) return undefined;
    measured.set(session.id, value);
    return value;
  };
  // Optional: hosts without a preset registry (headless) skip the preset.
  if (read().registerPreset !== false && typeof ctx.inject === 'function') {
    ctx.inject(['agentPresets'], scoped => {
      scoped.effect(() => registerFreeClaudePreset(scoped, { base: read().presetBase || 'standard', log: (...a) => (ctx.logger?.warn ? ctx.logger.warn(...a) : console.warn('[free-claude]', ...a)) }), 'free-claude: preset');
    });
  }

  const fibers = new Map();
  const setup = agent => {
    if (fibers.has(agent)) return;
    steps.set(agent.session.id, undefined);
    const fiber = agent.ctx.inject(['systemPrompt'], scope => {
      for (const key of ['core', 'budgetLine', 'toolGuidance']) {
        scope.effect(() => scope.systemPrompt.section({
          name: 'free-claude:' + key, order: ORDERS[key], interpolate: false,
          text: () => {
            if (!active(agent)) return '';
            const config = read(), text = t().freeClaude;
            if (key === 'budgetLine') return config.totalTokens ? text.budgetLine(budgetFor(agent)) : '';
            if (key === 'toolGuidance' && !config.toolGuidance) return '';
            return text[key];
          },
        }), 'free-claude:' + key);
      }
      scope.effect(() => scope.on('system-prompt/assemble', async (assembly, context, next) => {
        const result = await next();
        if (!active(agent)) return result;
        const drop = new Set(read().drop);
        const identity = { name: 'harness:identity', text: t().freeClaude.identity, interpolate: false };
        const sections = result.sections.filter(s => !drop.has(s.name)).map(s => s.name === identity.name ? { ...s, ...identity } : s);
        if (!sections.some(s => s.name === identity.name)) sections.unshift(identity);
        return { ...result, sections };
      }), 'free-claude:assembly');
    });
    fibers.set(agent, fiber);
  };
  for (const agent of ctx.agents.list()) setup(agent);
  ctx.on('agent/created', ({ agent }) => setup(agent));
  ctx.on('session/event', (session, event) => {
    const id = session.id;
    if (!steps.has(id)) return;
    const data = event.data ?? {}, state = steps.get(id);
    // A summary event precedes replacement. A prune or a decreasing meter is
    // not a compaction; partial, failed and mismatched boundaries commit nothing.
    if (event.type === 'compaction/start' && typeof data.compactionId === 'string') {
      compactions.set(id, { id: data.compactionId, before: measure(session) ?? measured.get(id), summary: false });
    } else if (event.type === 'compaction/summary') {
      const pending = compactions.get(id);
      if (pending && pending.id === data.compactionId) {
        pending.before = measure(session) ?? pending.before;
        pending.summary = true;
      }
    } else if (event.type === 'compaction/end') {
      const pending = compactions.get(id);
      if (pending && pending.id === data.compactionId) {
        if (data.error === undefined && pending.summary && pending.before !== undefined) ledger.rollOverContext(id, pending.before);
        compactions.delete(id);
      }
    }
    if (event.type === 'step/start') {
      steps.set(id, { turn: data.turn, step: data.step, tools: false, ended: false });
    } else if (event.type === 'tool/result' && event.surfaceOp?.op !== 'replace') {
      if (state && !state.ended && state.turn === data.turn && state.step === data.step) state.tools = true;
    } else if (event.type === 'step/end') {
      if (state && state.tools && state.turn === data.turn && state.step === data.step && data.error === undefined) state.ended = true;
      else steps.set(id, undefined);
    } else if (event.type === 'turn/start' || event.type === 'turn/end') {
      steps.set(id, undefined);
    }
  });
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next();
    const id = agent.session.id, previous = steps.get(id);
    const afterTools = previous?.ended && previous.turn === turn && previous.step === step - 1;
    if (steps.has(id)) steps.set(id, undefined); // consume even on reject/abort
    if (decision.kind === 'reject' || signal.aborted || !active(agent) || !read().totalTokens) return decision;
    const regular = decision.messages.some(message => message.source?.kind === 'user');
    if (!regular && !afterTools) return decision;
    const remaining = ledger.observe(id, measure(agent.session), budgetFor(agent), regular);
    if (remaining === undefined) return decision;
    const reminder = createUserMessage({
      content: [{ type: 'text', text: t().freeClaude.budgetReminder(remaining) }],
      source: { kind: 'free-claude', role: 'token_budget_reminder' },
    });
    return { ...decision, messages: [...decision.messages, reminder] };
  }, { prepend: true });
  ctx.on('agent/disposed', ({ agent }) => {
    const fiber = fibers.get(agent), id = agent.session.id;
    fibers.delete(agent);
    for (const map of [budgets, steps, compactions, measured]) map.delete(id);
    ledger.forget(id);
    Promise.resolve(fiber?.dispose?.()).catch(() => {});
  });
  ctx.effect(() => async () => {
    const all = [...fibers.values()];
    fibers.clear();
    for (const map of [budgets, steps, compactions, measured]) map.clear();
    ledger.clear();
    await Promise.allSettled(all.map(fiber => fiber?.dispose?.()));
  }, 'free-claude:agents');
}
