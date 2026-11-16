import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { apply, Config, ORDERS } from '../lib/entry-free-claude.js';
import { t as text, setLanguage } from '../lib/i18n.js';
import { apply as applyMemory } from '../index.js';
import { Config as MemoryConfig } from '../lib/config.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSH_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.';
const human = () => Object.freeze({ role: 'user', source: { kind: 'user' }, content: Object.freeze([{ type: 'text', text: 'hello' }]) });
// Each fixture is one plugin process; pass the same home to model a host restart.
const tempHome = t => {
  const home = mkdtempSync(join(tmpdir(), 'free-claude-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
};
function fixture(t, overrides = {}, history = new Map(), home = tempHome(t)) {
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; });
  const hooks = new Map(), agents = [], cleanups = [];
  let config = { ...Config({}).get(), ...overrides };
  let measured = 1000, throws = false, measurements = 0;
  const ctx = {
    agents: { list: () => agents },
    get: name => name === 'agentPresets' ? { composedPreset: c => c.preset } : name === 'tokenMeter' ? { measure() { measurements++; if (throws) throw Error('unavailable'); return { totalTokens: measured }; } } : undefined,
    on(name, fn) { hooks.set(name, fn); },
    effect(fn) { cleanups.push(fn()); },
  };
  apply(ctx, { get: () => config });
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup?.(); });
  const add = (id = 'main', preset = 'free-claude', depth = 0) => {
    const sections = new Map(), scopeHooks = new Map(), disposers = [];
    const scope = {
      systemPrompt: { section(s) { sections.set(s.name, s); return () => sections.delete(s.name); } },
      effect(fn) { disposers.push(fn()); },
      on(name, fn) { scopeHooks.set(name, fn); return () => scopeHooks.delete(name); },
    };
    if (!history.has(id)) history.set(id, []);
    let scans = 0;
    const agent = { session: { id, header: { agentPreset: preset, delegationDepth: depth }, snapshotEvents() { scans++; return history.get(id).slice(); } }, ctx: { preset, inject(_deps, fn) { fn(scope); return { dispose: () => disposers.forEach(f => f()) }; } } };
    agents.push(agent); hooks.get('agent/created')({ agent });
    const assemble = async (identity = true) => {
      const sorted = [...sections.values(), ...(identity ? [{ name: 'harness:identity', order: -1000, text: DSH_IDENTITY }] : [])].sort((a, b) => a.order - b.order);
      const original = Object.freeze({ sections: Object.freeze(sorted.map(s => Object.freeze({ name: s.name, text: typeof s.text === 'function' ? s.text() : s.text, ...(s.interpolate === undefined ? {} : { interpolate: s.interpolate }) }))), variables: {} });
      const result = await scopeHooks.get('system-prompt/assemble')(original, {}, () => original);
      return { original, result, text: result.sections.map(s => s.text).filter(Boolean).join('\n\n') };
    };
    const step = async (messages = [], number = 2, extra = {}) => {
      const decision = Object.freeze({ kind: extra.decisionKind ?? 'enter', messages: Object.freeze(messages), marker: 'unchanged' });
      const result = await hooks.get('agent/pre-step')({ agent, turn: 1, step: number, signal: { aborted: false }, ...extra }, () => decision);
      return { decision, result };
    };
    const event = (type, number = 1, turn = 1, data = {}, meta = {}) => hooks.get('session/event')(agent.session, { type, data: { step: number, turn, ...data }, ...meta });
    const recordSystem = text => history.get(id).push({ type: 'system/message', data: { message: { content: [{ type: 'text', text }] } } });
    const toolStep = (number = 1, turn = 1) => {
      event('step/start', number, turn);
      event('tool/result', number, turn);
      event('step/end', number, turn);
    };
    return { agent, assemble, step, event, toolStep, recordSystem, section: s => sections.set(s.name, s), scans: () => scans, dispose: () => hooks.get('agent/disposed')({ agent }) };
  };
  return { add, history, home, configure: c => { config = { ...config, ...c }; }, measure: n => { measured = n; }, throwMeasure: () => { throws = true; }, measurements: () => measurements };
}
const remaining = result => Number(result.messages.at(-1).content[0].text.match(/<token_budget remaining="(\d+)"/)[1]);

test('first and second system assemblies are byte identical with the full budget', async t => {
  const f = fixture(t), a = f.add();
  f.measure(undefined);
  const first = await a.assemble();
  assert.ok(first.text.includes('<token_budget total="15000000"/>'));
  a.agent.session.requestContext = () => ({ contextWindow: 1000000 });
  f.measure(125000);
  const second = await a.assemble();
  assert.equal(first.text, second.text);
  assert.equal(f.measurements(), 0, 'system must not access token meter');
  t.diagnostic('system SHA256 (both rounds): ' + createHash('sha256').update(first.text).digest('hex'));
});

test('standard-created agent switches Claude identity dynamically and restores DSH unchanged', async t => {
  const f = fixture(t), a = f.add('identity', 'standard');
  let assembled = await a.assemble();
  assert.equal(assembled.result, assembled.original);
  assert.ok(assembled.text.includes(DSH_IDENTITY));
  a.agent.ctx.preset = 'free-claude';
  assembled = await a.assemble();
  assert.ok(assembled.text.startsWith(text().freeClaude.identity));
  assert.ok(!assembled.text.includes(DSH_IDENTITY));
  assert.equal(assembled.original.sections[0].text, DSH_IDENTITY);
  a.agent.ctx.preset = 'standard';
  assembled = await a.assemble();
  assert.equal(assembled.result, assembled.original);
  assert.ok(assembled.text.includes(DSH_IDENTITY));
  a.agent.ctx.preset = 'free-claude';
  assert.equal((await a.assemble(false)).result.sections[0].text, text().freeClaude.identity);
});

test('reminders append after incoming blocks; growth, compaction and new input follow padded countdown', async t => {
  const f = fixture(t), a = f.add('sequence');
  const user = human(), seq = [];
  for (const [n, messages, number] of [[1000, [user], 1], [1200, [], 2], [1600, [], 3], [300, [], 4], [400, [], 5], [500, [user], 6]]) {
    if (number === 4) {
      a.event('compaction/start', 3, 1, { compactionId: 'sequence' });
      a.event('compaction/summary', 3, 1, { compactionId: 'sequence' });
    }
    f.measure(n);
    if (number === 4) a.event('compaction/end', 3, 1, { compactionId: 'sequence' });
    if (number > 1) a.toolStep(number - 1);
    const { decision, result } = await a.step(messages, number);
    assert.equal(result.marker, decision.marker);
    assert.deepEqual(result.messages.slice(0, -1), decision.messages);
    result.messages.slice(0, -1).forEach((m, i) => assert.equal(m, decision.messages[i]));
    const reminder = result.messages.at(-1);
    assert.equal(reminder.role, 'user');
    assert.equal(reminder.source.role, 'token_budget_reminder');
    assert.match(reminder.content[0].text, /^<system-reminder>\n<token_budget remaining="\d+"\/>\n<\/system-reminder>$/);
    seq.push(remaining(result));
  }
  assert.deepEqual(seq, [15000000, 14999800, 14999400, 14999100, 14999000, 15000000]);
  t.diagnostic('reminder sequence: ' + seq.join(' -> '));
});

test('totalTokens gates both outputs, while inactive, aborted and missing-meter steps are untouched', async t => {
  const f = fixture(t, { totalTokens: false }), a = f.add('gates');
  assert.ok(!(await a.assemble()).text.includes('<token_budget'));
  let step = await a.step([human()], 1);
  assert.equal(step.result, step.decision);
  assert.equal(f.measurements(), 0);
  f.configure({ totalTokens: true });
  for (const value of [undefined, NaN, -1]) {
    f.measure(value); step = await a.step([human()], 1); assert.equal(step.result, step.decision);
  }
  f.measure(1000);
  step = await a.step([], 1); assert.equal(step.result, step.decision);
  step = await a.step([human()], 1, { signal: { aborted: true } }); assert.equal(step.result, step.decision);
  a.agent.ctx.preset = 'standard';
  step = await a.step([human()], 1); assert.equal(step.result, step.decision);
  a.agent.ctx.preset = 'free-claude'; f.throwMeasure();
  step = await a.step([human()], 1); assert.equal(step.result, step.decision);
});

test('budget is session-stable, child accounting is independent, disposal removes markers', async t => {
  const f = fixture(t, { totalTokensBudget: 1000 }), a = f.add('budget-main');
  const original = (await a.assemble()).text;
  a.recordSystem(original);
  await a.step([human()], 1);
  f.measure(1100);
  a.toolStep(1);
  assert.equal(remaining((await a.step()).result), 900);
  f.configure({ totalTokensBudget: 2000 });
  assert.equal((await a.assemble()).text, original);
  const child = f.add('budget-child', 'free-claude', 1);
  assert.ok((await child.assemble()).text.includes('<token_budget total="2000"'));
  assert.equal(remaining((await child.step([human()], 1)).result), 2000);
  f.measure(1200);
  child.toolStep(1);
  a.toolStep(2);
  assert.equal(remaining((await child.step()).result), 1900);
  assert.equal(remaining((await a.step([], 3)).result), 800);
  a.dispose();
  const recreated = f.add('budget-main');
  assert.equal((await recreated.assemble()).text, original);
  assert.equal(recreated.scans(), 0, 'session history is never parsed for the budget');
  const restarted = fixture(t, { totalTokensBudget: 3000 }, new Map(), f.home).add('budget-main');
  assert.equal((await restarted.assemble()).text, original, 'a host restart restores the recorded budget');
  t.diagnostic('resume and restart: <token_budget total="1000"/>; new child: <token_budget total="2000"/>');
});

// Model the agent-loop break contract explicitly: a completed answer must not
// acquire synthetic work at the next pre-step boundary. The cap catches loops.
test('minimal loop ends after final answer instead of feeding reminders forever', async t => {
  const f = fixture(t), a = f.add('finite-loop');
  const trace = [];
  let turnEnds = null, finished = false, modelCalls = 0, endedBy;
  const inbox = [];
  let stoppingCalls = 0;
  const onTurnStopping = async () => { stoppingCalls++; };
  a.event('turn/start');
  for (let step = 1; step <= 10; step++) {
    f.measure(1000 + (step - 1) * 200);
    const { result } = await a.step(step === 1 ? [human()] : [], step);
    const reminders = result.messages.filter(m => m.source?.role === 'token_budget_reminder');
    trace.push({ step, messages: result.messages.length, reminder: reminders.length ? remaining(result) : null });
    if (turnEnds && result.messages.length === 0) { finished = true; endedBy = 'pre-step'; break; }
    a.event('step/start', step);
    modelCalls++;
    if (step < 3) {
      a.event('tool/result', step);
      turnEnds = null;
    } else turnEnds = { kind: 'completed' };
    a.event('step/end', step);
    // agent-loop:1000–1007: run turn-stopping hooks, then stop immediately
    // when completed and no hook or external delivery filled nextStep inbox.
    if (turnEnds && inbox.length === 0) await onTurnStopping();
    if (turnEnds && inbox.length === 0) {
      finished = true; endedBy = 'step-end';
      a.event('turn/end', step);
      break;
    }
  }
  assert.equal(finished, true, 'loop must end within ten pre-steps');
  assert.equal(modelCalls, 3);
  assert.deepEqual(trace, [
    { step: 1, messages: 2, reminder: 15000000 },
    { step: 2, messages: 1, reminder: 14999800 },
    { step: 3, messages: 1, reminder: 14999600 },
  ]);
  assert.equal(endedBy, 'step-end');
  assert.equal(stoppingCalls, 1);
  const idle = await a.step([], 4);
  assert.equal(idle.result, idle.decision);
  assert.equal(idle.result.messages.length, 0);
  t.diagnostic('finite-loop trace: ' + JSON.stringify(trace) + '; ended at step 3 via step-end/inbox-empty, model calls 3; independent idle probe messages=0');
});

test('tool continuation retains its reminder with metadata; pure notifications do not inject', async t => {
  const f = fixture(t), a = f.add('notices');
  await a.step([human()], 1);
  f.measure(1200);
  for (const kind of ['subagent-settled', 'agent-message', 'runtime-context']) {
    const notice = Object.freeze({ role: 'user', source: { kind }, content: [{ type: 'text', text: 'notice' }] });
    const pure = await a.step([notice], 2);
    assert.equal(pure.result, pure.decision);
    a.toolStep(1);
    const { decision, result } = await a.step([notice], 2);
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0], notice);
    assert.equal(decision.messages.length, 1);
    assert.equal(remaining(result), 14999800);
    const empty = await a.step([], 2);
    assert.equal(empty.result, empty.decision, 'tool marker consumed once');
    t.diagnostic('metadata ' + kind + ': pure messages=1/reminder=null; after tools messages=2/reminder=14999800');
  }
  assert.equal(f.measurements(), 4);
});

test('only the immediately preceding finished tool step in the same turn can arm a reminder', async t => {
  const f = fixture(t), a = f.add('step-events');
  await a.step([human()], 1);
  const untouched = async (number = 2, extra) => {
    const { decision, result } = await a.step([], number, extra);
    assert.equal(result, decision);
  };
  a.event('tool/result', 1); // No corresponding step/start.
  await untouched();
  a.event('step/start', 1);
  a.event('tool/result', 1); // Batch has not finished.
  await untouched();
  a.toolStep(1);
  f.measure(1100);
  assert.equal(remaining((await a.step()).result), 14999900);
  await untouched(); // Consume once, even if a pre-step is repeated.
  a.toolStep(1);
  await untouched(3); // Not the following step.
  a.toolStep(1);
  await untouched(2, { turn: 2 });
  a.toolStep(1);
  a.event('step/start', 2);
  a.event('step/end', 2); // Completed answer without tools clears the old marker.
  await untouched(3);
  a.toolStep(1);
  a.event('turn/end', 1);
  await untouched();
  a.event('step/start', 1);
  a.event('compaction/start', 1);
  a.event('compaction/summary', 1);
  a.event('compaction/end', 1);
  a.event('llm/retry', 1);
  a.event('step/end', 1);
  await untouched();
});

test('skipped tool continuations cannot leak into a later boundary or another session', async t => {
  const f = fixture(t), a = f.add('skip-main'), child = f.add('skip-child', 'free-claude', 1);
  await a.step([human()], 1);
  a.toolStep(1);
  const other = await child.step();
  assert.equal(other.result, other.decision);
  f.measure(undefined);
  const missing = await a.step();
  assert.equal(missing.result, missing.decision);
  f.measure(1200);
  let again = await a.step();
  assert.equal(again.result, again.decision);
  a.toolStep(1);
  f.configure({ totalTokens: false });
  await a.step();
  f.configure({ totalTokens: true });
  again = await a.step();
  assert.equal(again.result, again.decision);
  a.toolStep(1);
  await a.step([], 2, { signal: { aborted: true } });
  again = await a.step();
  assert.equal(again.result, again.decision);
  a.toolStep(1);
  a.dispose();
  const recreated = f.add('skip-main');
  again = await recreated.step();
  assert.equal(again.result, again.decision);
});

test('real compaction rolls over the full pre-replacement measurement, pruning does not', async t => {
  const f = fixture(t, { totalTokensBudget: 10000 }), a = f.add('compact'), b = f.add('prune');
  const compact = [remaining((await a.step([human()], 1)).result)];
  const prune = [remaining((await b.step([human()], 1)).result)];
  f.measure(1600);
  a.toolStep(1); b.toolStep(1);
  compact.push(remaining((await a.step([], 2)).result));
  prune.push(remaining((await b.step([], 2)).result));
  f.measure(1500);
  a.event('compaction/start', 2, 1, { compactionId: 'c1' });
  f.measure(1600); // Summary boundary is newer than the start/last-step sample.
  a.event('compaction/summary', 2, 1, { compactionId: 'c1', shadowedTokenCount: 1300 });
  b.event('compaction/prune', 2, 1, { shadowedTokenCount: 1300 });
  f.measure(300);
  a.event('compaction/end', 2, 1, { compactionId: 'c1' });
  a.event('compaction/end', 2, 1, { compactionId: 'c1' }); // No duplicate rollover.
  a.toolStep(2); b.toolStep(2);
  compact.push(remaining((await a.step([], 3)).result));
  prune.push(remaining((await b.step([], 3)).result));
  f.measure(400);
  b.toolStep(3);
  prune.push(remaining((await b.step([], 4)).result));
  assert.deepEqual(compact, [10000, 9400, 9100]);
  assert.deepEqual(prune, [10000, 9400, 9400, 9400]);
  t.diagnostic('host-event differential compaction=' + JSON.stringify(compact) + ', prune=' + JSON.stringify(prune));
});

test('failed compactions and tool-result replacements do not charge rollover or arm continuation', async t => {
  const f = fixture(t, { totalTokensBudget: 10000 }), a = f.add('failed-compact');
  await a.step([human()], 1);
  f.measure(1600); a.toolStep(1);
  assert.equal(remaining((await a.step([], 2)).result), 9400);
  a.event('compaction/start', 2, 1, { compactionId: 'failed' });
  a.event('compaction/summary', 2, 1, { compactionId: 'failed' });
  a.event('compaction/end', 2, 1, { compactionId: 'failed', error: 'failed replacement' });
  a.event('compaction/start', 2, 1, { compactionId: 'no-summary' });
  a.event('compaction/end', 2, 1, { compactionId: 'no-summary' });
  f.measure(300); a.toolStep(2);
  assert.equal(remaining((await a.step([], 3)).result), 9400);
  a.event('step/start', 3);
  a.event('compaction/prune', 3);
  a.event('tool/result', 3, 1, {}, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } });
  a.event('step/end', 3);
  const idle = await a.step([], 4);
  assert.equal(idle.result, idle.decision);
});

test('budgets come from the durable record, never from tags quoted in prompt text', async t => {
  // A session without a record whose history quotes an example budget
  // an example tag: without a record it takes the current setting.
  const history = new Map([['legacy', [
    { type: 'system/message', data: { message: { content: [{ type: 'text', text: 'Imported memory example: <token_budget total="7"/>' }] } } },
    { type: 'system/message', data: { message: { content: [{ type: 'text', text: '<token_budget total="900000"/>' }] } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '<token_budget total="7"/>' }] } },
  ]]]);
  const f = fixture(t, { totalTokensBudget: 2000 }, history), legacy = f.add('legacy');
  const legacyText = (await legacy.assemble()).text;
  assert.ok(legacyText.includes('<token_budget total="2000"/>'));
  assert.equal(remaining((await legacy.step([human()], 1)).result), 2000);
  assert.equal(legacy.scans(), 0);
  const record = JSON.parse(readFileSync(join(f.home, 'recollect', 'budgets', 'legacy.json'), 'utf8'));
  assert.equal(record.version, 1);
  assert.equal(record.budget, 2000);
  // Restart with a new setting: the recorded session keeps 2000, a new one gets 5000.
  const g = fixture(t, { totalTokensBudget: 5000 }, new Map(), f.home);
  assert.equal((await g.add('legacy').assemble()).text, legacyText);
  assert.ok((await g.add('brand-new').assemble()).text.includes('<token_budget total="5000"/>'));
  t.diagnostic('legacy session upgraded to the setting (2000), restored after restart; brand-new=5000');
});

test('assembly preserves other plugin sections, uses stable orders, and contains no duplicates', async t => {
  const f = fixture(t), a = f.add();
  assert.deepEqual(ORDERS, { core: -990, budgetLine: -970, toolGuidance: -960 });
  for (const name of ['deployment:persona-prefix', 'deployment:persona-suffix', 'progress:guidance', 'tool:read', 'recollect:guidance']) {
    a.section({ name, text: name, order: 0 });
  }
  let assembled = await a.assemble();
  const sections = assembled.result.sections;
  for (const key of ['core', 'toolGuidance', 'budgetLine']) assert.equal(sections.filter(s => s.name === 'free-claude:' + key).length, 1);
  for (const name of ['progress:guidance', 'tool:read', 'recollect:guidance']) assert.equal(sections.find(s => s.name === name).text, name);
  for (const name of ['deployment:persona-prefix', 'deployment:persona-suffix']) assert.ok(!sections.some(s => s.name === name));
  f.configure({ toolGuidance: false });
  assert.equal((await a.assemble()).result.sections.find(s => s.name === 'free-claude:toolGuidance').text, '');
  f.configure({ enabled: false });
  assembled = await a.assemble();
  assert.equal(assembled.result, assembled.original);
  assert.ok(assembled.text.includes('deployment:persona-prefix'));
});

test('mismatched compaction IDs do not commit, rejects consume tool markers', async t => {
  const f = fixture(t, { totalTokensBudget: 10000 }), a = f.add();
  await a.step([human()], 1);
  f.measure(1600);
  a.toolStep(1);
  assert.equal(remaining((await a.step([], 2)).result), 9400);
  a.event('compaction/start', 2, 1, { compactionId: 'a' });
  a.event('compaction/summary', 2, 1, { compactionId: 'b' });
  a.event('compaction/end', 2, 1, { compactionId: 'a' });
  f.measure(300);
  a.toolStep(2);
  assert.equal(remaining((await a.step([], 3)).result), 9400);
  a.toolStep(3);
  const aborted = await a.step([], 4, { signal: { aborted: true } });
  assert.equal(aborted.result, aborted.decision);
  const retry = await a.step([], 4);
  assert.equal(retry.result, retry.decision);
  a.toolStep(3);
  const reject = await a.step([], 4, { decisionKind: 'reject' });
  assert.equal(reject.result, reject.decision);
  const afterReject = await a.step([], 4);
  assert.equal(afterReject.result, afterReject.decision);
  a.event('compaction/start', 3);
  a.event('compaction/summary', 3);
  a.event('compaction/end', 3);
  a.toolStep(3);
  assert.equal(remaining((await a.step([], 4)).result), 9400, 'missing IDs are not a matching compaction boundary');
});

test('memory guidance follows composed presets and live auto/full/lean overrides', async t => {
  const home = tempHome(t), oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; setLanguage('zh'); });
  const config = MemoryConfig({ language: 'en', instructions: { enabled: false }, memory: { directory: join(home, 'memory'), writeMode: 'files' } });
  const write = Object.getOwnPropertySymbols(config.memory).find(s => String(s).includes('volatile.write'));
  const setMemory = patch => config.memory[write]({ ...config.memory.get(), ...patch });
  assert.equal(config.memory.get().guidance, 'auto');
  assert.deepEqual(config.memory.get().leanPresets, ['free-claude']);
  const sections = new Map(), disposers = [];
  const scope = { systemPrompt: { section(s) { sections.set(s.name, s); } } };
  const agent = { session: { id: 'memory-style', header: { cwd: home, agentPreset: 'standard' } }, ctx: { preset: 'standard', inject(_deps, fn) { fn(scope); return { dispose() {} }; } } };
  const ctx = {
    agents: { list: () => [agent] },
    workingDirectory: { get: () => home }, tools: { guard() {} },
    get: name => name === 'agentPresets' ? { composedPreset: ctx => ctx.preset } : undefined,
    effect(fn) { disposers.push(fn()); }, on() {}, plugin() {},
    inject(_deps, fn) { fn({ effect: fn => fn(), commands: { register() {} } }); },
  };
  applyMemory(ctx, config);
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose?.(); });
  const opts = { title: 'persistent memory', dir: join(home, 'memory') + '/', mode: 'files', readOnly: false, extraGuidelines: [] };
  const guidance = () => sections.get('recollect:guidance').text();
  assert.equal(guidance(), text().guidance(opts));
  agent.ctx.preset = 'free-claude';
  assert.equal(guidance(), text().leanGuidance(opts));
  setMemory({ guidance: 'full' });
  assert.equal(guidance(), text().guidance(opts));
  agent.ctx.preset = 'standard';
  setMemory({ guidance: 'lean' });
  assert.equal(guidance(), text().leanGuidance(opts));
  setMemory({ guidance: 'auto', leanPresets: ['custom'] });
  assert.equal(guidance(), text().guidance(opts));
  agent.ctx.preset = 'custom';
  assert.equal(guidance(), text().leanGuidance(opts));
});
