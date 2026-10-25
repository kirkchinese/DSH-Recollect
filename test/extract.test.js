import { setLanguage } from '../lib/i18n.js';
setLanguage('en');
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_TOOL_NAMES, shellWords, isMemoryMarkdownPath, canonicalMemoryPath, isReadOnlyCommand, isMemoryRemoveCommand, createChildToolPolicy, createStepBudget } from '../lib/guard.js';
import { hasUserProse, inspectExtractionRange, renderExtractionPrompt, scanMemories, changedMemoryPaths, memoryManifest, memoryUpdateText, createExtractor } from '../lib/extract.js';

const user = (text, source = { kind: 'user' }) => ({ source, content: [{ type: 'text', text }] });
const event = (seq, type, data) => ({ seq, type, data });
const human = (seq, text = 'Please remember this preference') => event(seq, 'user/message', user(text));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate() && Date.now() < end) await tick();
  assert.ok(predicate(), 'expected asynchronous controller progress within 3 seconds');
}
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-extract-'));
  // mkdtemp returns this exact test-owned directory; never accept a computed external deletion target.
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test('conservative read-only shell allow/deny tables', () => {
  for (const command of ['ls -la /tmp', 'find /tmp -name "*.md"', 'cat "/tmp/a b.md" | head -20', 'grep -rn "word" /tmp --include="*.jsonl" | tail -50', 'rg foo /tmp | sort | uniq -c', 'stat /tmp', 'wc -l /tmp/a', 'cut -d : -f 1 /tmp/a', 'file /tmp/a']) assert.equal(isReadOnlyCommand(command), true, command);
  for (const command of ['', 'ls || cat a', 'cat a > b', 'cat < a', 'ls; pwd', 'ls && cat a', 'cat `id`', 'cat $(id)', 'cat $HOME/a', 'ls\nrm /tmp/a', 'find /tmp -delete', 'find /tmp -exec touch a', 'find /tmp -execdir id', 'find /tmp -ok id', 'find /tmp -fprint /tmp/out', 'sort -o /tmp/out', 'sort --output=/tmp/out', 'sort --compress-program=id', 'uniq input output', 'file -C', 'file --compile', 'file --comp', 'rg --pre=id foo', 'grep --hostname-bin=id foo', 'bash -c ls', 'python -c print', 'cat a &', 'ls |', 'cat "unterminated']) assert.equal(isReadOnlyCommand(command), false, command);
  assert.deepEqual(shellWords('rm -f "/tmp/a b.md"'), ['rm', '-f', '/tmp/a b.md']);
});

test('rm accepts only absolute contained markdown paths and conservative flags', () => {
  for (const command of ['rm /mem/a.md', 'rm -f --force -- /mem/a.md /mem/b.md', 'rm "/mem/a b.md"']) assert.equal(isMemoryRemoveCommand(command, '/mem'), true, command);
  for (const command of ['rm', 'rm -rf /mem/a.md', 'rm ./a.md', 'rm /mem/a.txt', 'rm /memory/a.md', 'rm /mem/../a.md', 'rm /mem/*.md', 'rm /mem/$a.md', 'rm /mem/a.md | cat', 'rm /mem/a.md; ls', 'rm -f', 'rm /mem/a.md > out']) assert.equal(isMemoryRemoveCommand(command, '/mem'), false, command);
});

test('path containment and canonical symlink confinement', async t => {
  const dir = await temp(t), mem = join(dir, 'mem'), outside = join(dir, 'outside');
  await mkdir(mem); await mkdir(outside); await symlink(outside, join(mem, 'escape'));
  assert.equal(isMemoryMarkdownPath('mem/a.md', mem, dir), true);
  assert.equal(isMemoryMarkdownPath('../outside/a.md', mem, mem), false);
  assert.equal(isMemoryMarkdownPath(join(dir, 'memory/a.md'), mem), false);
  assert.equal(canonicalMemoryPath(join(mem, 'new/sub/a.md'), mem), true);
  assert.equal(canonicalMemoryPath(join(mem, 'escape/a.md'), mem), false);
});

test('policy is child-only, restricts mutations and budgets count total steps', async t => {
  const dir = await temp(t), policy = createChildToolPolicy();
  const exec = (name, args = {}, id = 'child') => ({ name, arguments: args, agent: { session: { id, header: { cwd: dir } } } });
  assert.equal(policy.guard(exec('web_search')), undefined);
  policy.restrict('child', { memoryDir: dir, kind: 'extract' });
  assert.equal(policy.isRestricted('child'), true);
  for (const name of ['read', 'glob', 'grep', ...MEMORY_TOOL_NAMES]) assert.equal(policy.guard(exec(name)), undefined);
  assert.equal(policy.guard(exec('write', { file_path: join(dir, 'new.md') })), undefined);
  assert.match(policy.guard(exec('write', { file_path: '/etc/wrong.md' })), /memory/i);
  assert.match(policy.guard(exec('subagent')), /memory/i);
  assert.equal(policy.guard(exec('bash', { command: `rm -f ${dir}/new.md` })), undefined);
  policy.release('child'); assert.equal(policy.guard(exec('subagent')), undefined);
  const budget = createStepBudget(); budget.set('child', 2);
  assert.deepEqual([budget.onPreStep('child'), budget.onPreStep('child'), budget.onPreStep('child')], [true, true, false]);
  assert.equal(budget.onPreStep('parent'), true); budget.clear('child'); assert.equal(budget.onPreStep('child'), true);
});

test('human prose heuristic excludes notices/meta and supports CJK deviation', () => {
  assert.equal(hasUserProse(user('one two three')), true);
  assert.equal(hasUserProse(user('one two')), false);
  assert.equal(hasUserProse(user('记住这个偏好')), true);
  assert.equal(hasUserProse(user('日本語')), true);
  assert.equal(hasUserProse(user('hello three words', { kind: 'recollect' })), false);
  assert.equal(hasUserProse({ ...user('one two three'), isMeta: true }), false);
});

test('cursor range skips direct writes/no-prose and falls back if missing', () => {
  let events = [human(0), event(1, 'assistant/message', { message: {} }), event(2, 'tool/call', { name: 'write', arguments: '{"file_path":"/mem/a.md"}' })];
  assert.deepEqual(inspectExtractionRange(events, -1, '/mem'), { cursor: 2, messageCount: 2, skip: 'direct-write' });
  assert.equal(inspectExtractionRange(events, 2, '/mem').skip, 'no-prose');
  assert.equal(inspectExtractionRange(events.slice(0, 2), 999, '/mem').skip, null);
  events.push(human(3)); assert.equal(inspectExtractionRange(events, 2, '/mem').skip, null);
  events = [human(0), event(1, 'tool/call', { name: 'memory_delete', arguments: '{}' })];
  assert.equal(inspectExtractionRange(events, -1, '/mem').skip, 'direct-write');
  events[1].data = { name: 'edit', arguments: '{broken' };
  assert.equal(inspectExtractionRange(events, -1, '/mem').skip, null);
  events[1].data = { name: 'write', arguments: '{"file_path":"/mem/non-markdown.txt"}' };
  assert.equal(inspectExtractionRange(events, -1, '/mem').skip, 'direct-write');
});

test('manifest, diff, prompt adaptation and ambient notice', async t => {
  const dir = await temp(t); const before = await scanMemories(dir);
  await writeFile(join(dir, 'preference.md'), '---\ntype: feedback\ndescription: Prefer tests first\n---\ncontent');
  const after = await scanMemories(dir); assert.equal(changedMemoryPaths(before, after).length, 1);
  const manifest = memoryManifest(after, dir); assert.match(manifest, /\[feedback\] preference.md \(\d{4}-/);
  const prompt = renderExtractionPrompt({ messageCount: 4, manifest });
  assert.match(prompt, /~4 messages/); assert.match(prompt, /preference\.md/);
  assert.match(prompt, /read/);
  assert.match(renderExtractionPrompt({ messageCount: 2, toolsMode: true }), /memory_write/);
  assert.match(memoryUpdateText('Background memory extraction', ['/mem/a.md']).summary, /1/);
  assert.match(memoryUpdateText('Background memory extraction', ['/mem/MEMORY.md']).summary, /index/i);
  assert.match(memoryUpdateText('Background memory extraction', ['/mem/a.md']).text, /<system-reminder>/);
});

test('extractor cadence, child pre-reservation, coalescing and notices', async t => {
  const dir = await temp(t), policy = createChildToolPolicy(), budget = createStepBudget();
  let events = [human(0)], resolveResult, calls = 0; const notices = [];
  const agent = { session: { id: 'parent', header: { cwd: dir }, snapshotEvents: () => [...events] }, inject: m => notices.push(m) };
  const ctx = { subagents: { async startActivation(spec) {
    calls++; assert.equal(spec.provider, 'fork'); assert.equal(spec.delivery, 'caller'); assert.equal(policy.isRestricted(spec.childId), true);
    assert.equal(budget.onPreStep(spec.childId), true);
    return { childId: spec.childId, result: new Promise(r => { resolveResult = r; }), async dispose() {} };
  } } };
  const config = { extract: { enabled: true, everyNTurns: 1, maxTurns: 5 } };
  const extractor = createExtractor({ ctx, config, policy, budget, memory: { dirFor: () => dir, isPaused: () => false, toolNames: () => ({ write: ['write', 'edit'] }) } });
  extractor.onTurnEnd(agent); await until(() => resolveResult);
  events.push(human(1, 'Save another useful preference')); extractor.onTurnEnd(agent);
  events.push(human(2, 'Save the most recent preference')); extractor.onTurnEnd(agent);
  await writeFile(join(dir, 'saved.md'), 'new memory'); resolveResult({ stopReason: 'completed' });
  await until(() => calls === 2);
  resolveResult({ stopReason: 'completed' }); await tick(); await tick();
  await extractor.dispose();
  assert.equal(calls, 2); assert.equal(notices.length, 1); assert.match(notices[0].source.summary, /1/);
});

test('extractor advances skip cursor, counts only eligible cadence turns and contains callback failures', async t => {
  const dir = await temp(t), policy = createChildToolPolicy(), budget = createStepBudget();
  let events = [human(0), event(1, 'tool/call', { name: 'memory_write', arguments: '{}' })], calls = 0, paused = false;
  const prompts = [], warnings = [];
  const agent = { session: { id: 'parent', header: { cwd: dir }, snapshotEvents: () => [...events] }, inject() {} };
  const config = { extract: { enabled: true, everyNTurns: 2, maxTurns: 5 } };
  const extractor = createExtractor({ config, policy, budget, log: { warn: s => warnings.push(s) },
    memory: { dirFor: () => dir, isPaused: () => paused, toolNames: () => ({ write: ['write'] }) },
    ctx: { subagents: { async startActivation(spec) { calls++; prompts.push(spec.request.prompt[0].text); return { result: Promise.resolve({ stopReason: 'completed' }), async dispose() {} }; } } } });
  extractor.onTurnEnd(agent); await tick(); // Direct write consumes range but not cadence.
  events.push(human(2)); extractor.onTurnEnd(agent); await tick(); assert.equal(calls, 0);
  events.push(human(3)); extractor.onTurnEnd(agent); await until(() => calls === 1);
  assert.match(prompts[0], /~2 messages/);
  // These gates do not start any new work.
  paused = true; extractor.onTurnEnd(agent); paused = false;
  agent.session.header.origin = 'subagent'; extractor.onTurnEnd(agent); delete agent.session.header.origin;
  config.extract.enabled = false; extractor.onTurnEnd(agent);
  await extractor.dispose(); assert.equal(calls, 1);
  const broken = createExtractor({ config: { extract: { enabled: true } }, policy, budget, log: { warn: s => warnings.push(s) }, memory: { isPaused() { throw new Error('bad callback'); } } });
  assert.doesNotThrow(() => broken.onTurnEnd(agent)); await broken.dispose(); assert.ok(warnings.some(s => s.includes('bad callback')));
});
