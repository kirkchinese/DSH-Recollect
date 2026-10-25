import { setLanguage } from '../lib/i18n.js';
setLanguage('en');
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireDreamLock, rollbackDreamLock, lastConsolidatedAt, lockPath, dreamTimeGate, dreamSessionGate, sessionsSince, renderDreamPrompt, createDreamer } from '../lib/dream.js';
import { createChildToolPolicy, createStepBudget } from '../lib/guard.js';

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-dream-'));
  // Exact mkdtemp-owned test directory only.
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test('dream time gate and ten-minute scan throttle', () => {
  const now = 100000000;
  assert.equal(dreamTimeGate({ now, lastConsolidatedAt: now - 3600000, minHours: 24 }), 'too-soon');
  assert.equal(dreamTimeGate({ now, lastConsolidatedAt: 0, minHours: 24, lastScanAt: now - 599999 }), 'scan-throttled');
  assert.equal(dreamTimeGate({ now, lastConsolidatedAt: 0, minHours: 24, lastScanAt: now - 600000 }), null);
  assert.equal(dreamSessionGate(['a', 'b'], 2), true); assert.equal(dreamSessionGate(['a'], 2), false);
});

test('fresh lock denies live holder, absent lock rolls back to absent', async t => {
  const dir = await temp(t); assert.equal(await lastConsolidatedAt(dir), 0);
  const lock = await acquireDreamLock(dir); assert.ok(lock); assert.equal(lock.priorMtime, 0);
  assert.equal(await readFile(lockPath(dir), 'utf8'), String(process.pid));
  assert.equal(await acquireDreamLock(dir), null);
  await rollbackDreamLock(lock); assert.equal(await lastConsolidatedAt(dir), 0);
});

test('dead PID or old live PID permits takeover; rollback restores previous mtime', async t => {
  const dir = await temp(t), path = lockPath(dir);
  await writeFile(path, '999999'); const previous = new Date(Date.now() - 200000); await utimes(path, previous, previous);
  const prior = (await stat(path)).mtimeMs, lock = await acquireDreamLock(dir);
  assert.ok(lock); assert.equal(lock.priorMtime, prior);
  await rollbackDreamLock(lock); assert.equal(await readFile(path, 'utf8'), '');
  assert.ok(Math.abs((await stat(path)).mtimeMs - prior) < 1000);
  await writeFile(path, String(process.pid)); const old = new Date(Date.now() - 3600001); await utimes(path, old, old);
  assert.ok(await acquireDreamLock(dir));
});

test('rollback never overwrites another holder', async t => {
  const dir = await temp(t), lock = await acquireDreamLock(dir);
  await writeFile(lock.path, '12345'); await rollbackDreamLock(lock);
  assert.equal(await readFile(lock.path, 'utf8'), '12345');
});

test('touched-session scan uses mtimes, excludes current/child/other project', async t => {
  const dir = await temp(t), sessionsDir = join(dir, 'transcripts'), cwd = join(dir, 'project'); await mkdir(sessionsDir); await mkdir(cwd);
  const headers = [
    { id: 'old-but-touched', cwd, createdAt: 1 }, { id: 'parent', cwd },
    { id: 'child', cwd, origin: 'subagent' }, { id: 'other', cwd: join(dir, 'elsewhere') }, { id: 'untouched', cwd },
  ];
  for (const header of headers) {
    const sd = join(sessionsDir, header.id); await mkdir(sd);
    const path = join(sd, 'session.v4.jsonl'); await writeFile(path, JSON.stringify(header) + '\n');
    if (header.id === 'untouched') await utimes(path, new Date(1000), new Date(1000));
  }
  const agent = { session: { id: 'parent', header: { cwd } } };
  const ctx = { sessionPersistence: { list: async () => headers.map(header => ({ header, revision: 'opaque' })) } };
  assert.deepEqual(await sessionsSince({ ctx, sessionsDir, agent, since: 2000 }), ['old-but-touched']);
  assert.deepEqual(await sessionsSince({ ctx: {}, sessionsDir, agent, since: 2000 }), ['old-but-touched']);
});

test('dream rendering preserves phases, reconciliation and adapted tool restrictions', () => {
  const prompt = renderDreamPrompt({ memoryDir: '/mem', sessionsDir: '/sessions', sessionIds: ['one', 'two'] });
  for (const term of ['/mem', '/sessions', 'MEMORY.md', '--include="*.jsonl"', '- one', '- two', 'AGENTS.md']) assert.ok(prompt.includes(term), term);
  assert.ok(!prompt.includes('## Team memory'));
  assert.match(renderDreamPrompt({ memoryDir: '/mem', sessionsDir: '/s', toolsMode: true }), /memory_write/);
});

function fixture(dir, startActivation, overrides = {}) {
  const agent = { session: { id: 'parent', header: { cwd: dir } }, inject() {} };
  const config = { dream: { enabled: true, minHours: 0, minSessions: 1, ...overrides } };
  const ctx = { subagents: { startActivation }, sessionPersistence: { list: async () => [] } };
  const dream = createDreamer({ ctx, config, policy: createChildToolPolicy(), budget: createStepBudget(), memory: { dirFor: () => dir, isPaused: () => false, toolNames: () => ({ write: ['write'] }) }, sessionsDir: join(dir, 'sessions') });
  return { dream, agent, ctx };
}

test('manual dream bypasses gates but respects lock; failed run rolls back', async t => {
  const dir = await temp(t); let calls = 0;
  const { dream, agent } = fixture(dir, async spec => {
    calls++; assert.equal(spec.provider, 'fork'); assert.equal(spec.label, 'Memory consolidation');
    return { result: Promise.resolve({ stopReason: 'error' }), async dispose() {} };
  }, { enabled: false, minHours: 999, minSessions: 100 });
  assert.match(await dream.runNow(agent), /failed/); assert.equal(calls, 1); assert.equal(await lastConsolidatedAt(dir), 0);
  await acquireDreamLock(dir); assert.match(await dream.runNow(agent), /locked/); assert.equal(calls, 1);
  await dream.dispose();
});

test('jobs wrapper uses synchronous hooks and successful dream retains lock timestamp', async t => {
  const dir = await temp(t), hooks = [];
  const { dream, agent, ctx } = fixture(dir, async () => ({ result: Promise.resolve({ stopReason: 'completed' }), async dispose() {} }));
  ctx.jobs = { start(spec) { assert.equal(spec.owner, 'parent'); hooks.push(spec.run({ append() {} })); return 'job'; } };
  assert.equal(await dream.runNow(agent), 'Memory consolidation completed.');
  assert.ok(hooks[0].done instanceof Promise); assert.equal((await hooks[0].done).status, 'completed');
  assert.ok(await lastConsolidatedAt(dir) > 0); await dream.dispose();
});

test('failed session-count gate consumes scan throttle', async t => {
  const dir = await temp(t); let scans = 0;
  const { dream, agent, ctx } = fixture(dir, async () => { throw new Error('should not start'); });
  ctx.sessionPersistence.list = async () => { scans++; return []; };
  dream.onTurnEnd(agent);
  // dispose waits for the first callback to finish; a separate controller exercises subsequent callbacks below.
  await new Promise(resolve => setTimeout(resolve, 30));
  dream.onTurnEnd(agent); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(scans, 1); await dream.dispose();
});
