import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBudgetStore } from '../lib/budget-store.js';

const STORE = fileURLToPath(new URL('../lib/budget-store.js', import.meta.url));
const temp = t => {
  const dir = mkdtempSync(join(tmpdir(), 'recollect-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'budgets');
};
const record = (dir, id) => JSON.parse(readFileSync(join(dir, encodeURIComponent(id) + '.json'), 'utf8'));

test('first resolve records the candidate; later resolves keep the record', t => {
  const dir = temp(t);
  const store = createBudgetStore(dir);
  assert.equal(store.get('a'), undefined);
  assert.equal(store.resolve('a', 15000000), 15000000);
  assert.equal(store.resolve('a', 2000), 15000000, 'a recorded budget is never replaced');
  assert.equal(record(dir, 'a').budget, 15000000);
  assert.deepEqual(readdirSync(dir), ['a.json'], 'no temp file left behind');
});

test('a process sees records another process wrote after it started (no stale cache)', t => {
  const dir = temp(t);
  const webProcess = createBudgetStore(dir), headless = createBudgetStore(dir);
  assert.equal(webProcess.get('warmup'), undefined);
  assert.equal(headless.resolve('shared', 1000), 1000);
  assert.equal(webProcess.resolve('shared', 2000), 1000, 'the existing record wins over the candidate');
  assert.equal(record(dir, 'shared').budget, 1000);
});

test('a writer that loses the race returns the winner and leaves the record intact', t => {
  const dir = temp(t);
  const winner = createBudgetStore(dir);
  const loser = createBudgetStore(dir, { beforeCommit: id => { assert.equal(winner.resolve(id, 1000), 1000); } });
  assert.equal(loser.resolve('raced', 2000), 1000);
  assert.equal(record(dir, 'raced').budget, 1000);
  assert.deepEqual(readdirSync(dir), ['raced.json']);
});

test('concurrent processes agree on one budget per session and lose no records', async t => {
  const dir = temp(t);
  mkdirSync(dir, { recursive: true });
  const go = join(dir, '..', 'go');
  const child = i => new Promise((resolve, reject) => {
    const code = `
      import { existsSync } from 'node:fs';
      import { createBudgetStore } from ${JSON.stringify(pathToFileURL(STORE).href)};
      while (!existsSync(${JSON.stringify(go)})) await new Promise(r => setTimeout(r, 2));
      const store = createBudgetStore(${JSON.stringify(dir)});
      const shared = store.resolve('shared', ${1000 + i});
      const own = store.resolve('own-${i}', ${i + 1});
      process.stdout.write(JSON.stringify({ shared, own }));`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', reject);
    p.on('exit', c => (c === 0 ? resolve(JSON.parse(out)) : reject(new Error('child exit ' + c))));
  });
  const N = 8;
  const runs = Array.from({ length: N }, (_, i) => child(i));
  await new Promise(r => setTimeout(r, 300));
  writeFileSync(go, '');
  const results = await Promise.all(runs);
  const winner = record(dir, 'shared').budget;
  assert.ok(winner >= 1000 && winner < 1000 + N);
  for (const r of results) assert.equal(r.shared, winner, 'every process sees the same budget');
  results.forEach((r, i) => { assert.equal(r.own, i + 1); assert.equal(record(dir, 'own-' + i).budget, i + 1); });
  assert.equal(readdirSync(dir).filter(n => n.endsWith('.tmp')).length, 0);
  t.diagnostic(`${N} processes: shared=${winner}, all ${N} own records present`);
});

test('corrupt records fail open unchanged and warn once per store and id', t => {
  const dir = temp(t);
  mkdirSync(dir, { recursive: true });
  const bad = '{ not json', foreign = JSON.stringify({ version: 99, budget: 5 });
  writeFileSync(join(dir, 'bad.json'), bad);
  writeFileSync(join(dir, 'foreign.json'), foreign);
  const logs = [], store = createBudgetStore(dir, { log: m => logs.push(m) });
  assert.equal(store.resolve('bad', 1000), 1000);
  assert.equal(store.resolve('bad', 2000), 2000);
  assert.equal(store.get('bad'), undefined);
  assert.equal(readFileSync(join(dir, 'bad.json'), 'utf8'), bad);
  assert.equal(store.resolve('foreign', 3000), 3000);
  assert.equal(readFileSync(join(dir, 'foreign.json'), 'utf8'), foreign);
  assert.equal(logs.length, 2);
  t.diagnostic('M2 corrupt records unchanged; bad candidates=1000,2000; warnings=2 for 2 IDs');
});

test('a repair committed before link wins over a stale corrupt-record candidate', t => {
  const dir = temp(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bad.json'), '{ not json');
  const other = createBudgetStore(dir);
  const store = createBudgetStore(dir, { beforeCommit(id) {
    unlinkSync(join(dir, id + '.json')); // An administrator removes the corrupt record.
    assert.equal(other.resolve(id, 1000), 1000);
  } });
  const result = store.resolve('bad', 2000);
  assert.equal(result, 1000);
  assert.equal(record(dir, 'bad').budget, 1000);
  t.diagnostic('M2 competing repair: candidate=2000 returned=' + result + '; disk=' + record(dir, 'bad').budget);
});

test('EEXIST with a still-corrupt record never overwrites a subsequent repair', t => {
  const dir = temp(t), link = fs.linkSync;
  let collided = false;
  t.mock.method(fs, 'linkSync', (from, to) => {
    if (!collided) { collided = true; writeFileSync(to, '{ concurrent corrupt record'); }
    return link(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const store = createBudgetStore(dir, { log() {
    // The EEXIST read saw malformed bytes; a different writer repairs them
    // before resolve unwinds. The original candidate must not replace this.
    writeFileSync(join(dir, 'raced.json'), JSON.stringify({ version: 1, budget: 1000 }));
  } });
  const result = store.resolve('raced', 2000);
  assert.equal(collided, true);
  assert.equal(result, 2000);
  assert.equal(record(dir, 'raced').budget, 1000);
  t.diagnostic('M2 EEXIST fail-open: candidate=' + result + '; later repair on disk=' + record(dir, 'raced').budget);
});

test('a failed link still returns a valid record committed by another writer', t => {
  const dir = temp(t);
  t.mock.method(fs, 'linkSync', (_from, to) => {
    writeFileSync(to, JSON.stringify({ version: 1, budget: 1000 }));
    throw Object.assign(new Error('simulated link failure'), { code: 'EACCES' });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(createBudgetStore(dir).resolve('raced', 2000), 1000);
  assert.equal(record(dir, 'raced').budget, 1000);
});

test('single stat and unlink failures do not disable future pruning', t => {
  const dir = temp(t), store = createBudgetStore(dir, { maxEntries: 3 });
  for (let i = 0; i < 3; i++) {
    store.resolve('s' + i, 1000);
    utimesSync(join(dir, 's' + i + '.json'), 1000 + i, 1000 + i);
  }
  const stat = fs.statSync, unlink = fs.unlinkSync;
  let statFailed = false, unlinkFailed = false;
  t.mock.method(fs, 'statSync', (...args) => {
    if (!statFailed && args[0] === join(dir, 's0.json')) {
      statFailed = true;
      throw Object.assign(new Error('simulated vanished entry'), { code: 'ENOENT' });
    }
    return stat(...args);
  });
  t.mock.method(fs, 'unlinkSync', (...args) => {
    if (!unlinkFailed && args[0] === join(dir, 's0.json')) {
      unlinkFailed = true;
      throw Object.assign(new Error('simulated unlink failure'), { code: 'EACCES' });
    }
    return unlink(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (let i = 3; i < 7; i++) {
    store.resolve('s' + i, 1000);
    utimesSync(join(dir, 's' + i + '.json'), 1000 + i, 1000 + i);
  }
  assert.equal(statFailed, true);
  assert.equal(unlinkFailed, true);
  assert.deepEqual(readdirSync(dir).sort(), ['s4.json', 's5.json', 's6.json']);
  t.diagnostic('M1 per-file failures recovered; retained=s4.json,s5.json,s6.json');
});

test('one long-lived store keeps pruning after every new record', t => {
  const dir = temp(t), store = createBudgetStore(dir, { maxEntries: 3 });
  const counts = [];
  for (let i = 0; i < 7; i++) {
    store.resolve('s' + i, 1000 + i);
    utimesSync(join(dir, 's' + i + '.json'), 1000 + i, 1000 + i);
    counts.push(readdirSync(dir).length);
  }
  assert.deepEqual(counts, [1, 2, 3, 3, 3, 3, 3]);
  assert.deepEqual(readdirSync(dir).sort(), ['s4.json', 's5.json', 's6.json']);
  t.diagnostic('M1 long-lived counts=' + JSON.stringify(counts) + '; retained=' + readdirSync(dir).sort().join(','));
});

test('persistent stat EACCES still counts existing records toward the limit', t => {
  const dir = temp(t), store = createBudgetStore(dir, { maxEntries: 3 }), stat = fs.statSync;
  let faults = 0;
  t.mock.method(fs, 'statSync', (...args) => {
    if (args[0] === join(dir, 's0.json')) {
      assert.equal(record(dir, 's0').budget, 1000, 'faulted record really exists');
      faults++;
      throw Object.assign(new Error('persistent stat denial'), { code: 'EACCES' });
    }
    return stat(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const counts = [];
  for (let i = 0; i < 10; i++) {
    store.resolve('s' + i, 1000 + i);
    assert.equal(record(dir, 's' + i).budget, 1000 + i);
    utimesSync(join(dir, 's' + i + '.json'), 1000 + i, 1000 + i);
    counts.push(readdirSync(dir).length);
  }
  assert.ok(faults > 0);
  assert.deepEqual(counts, [1, 2, 3, 3, 3, 3, 3, 3, 3, 3]);
  assert.deepEqual(readdirSync(dir).sort(), ['s7.json', 's8.json', 's9.json']);
  t.diagnostic('M1 persistent stat counts=' + JSON.stringify(counts) + '; retained=' + readdirSync(dir).sort().join(','));
});

test('persistent unlink EACCES continues to later deletable candidates', t => {
  const dir = temp(t), store = createBudgetStore(dir, { maxEntries: 3 }), unlink = fs.unlinkSync;
  let faults = 0;
  t.mock.method(fs, 'unlinkSync', (...args) => {
    if (args[0] === join(dir, 's0.json')) {
      faults++;
      throw Object.assign(new Error('persistent unlink denial'), { code: 'EACCES' });
    }
    return unlink(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const counts = [];
  for (let i = 0; i < 10; i++) {
    store.resolve('s' + i, 1000 + i);
    assert.equal(record(dir, 's' + i).budget, 1000 + i);
    utimesSync(join(dir, 's' + i + '.json'), 1000 + i, 1000 + i);
    counts.push(readdirSync(dir).length);
  }
  assert.equal(faults, 7);
  assert.deepEqual(counts, [1, 2, 3, 3, 3, 3, 3, 3, 3, 3]);
  assert.deepEqual(readdirSync(dir).sort(), ['s0.json', 's8.json', 's9.json']);
  t.diagnostic('M1 persistent unlink counts=' + JSON.stringify(counts) + '; retained=' + readdirSync(dir).sort().join(','));
});

test('exhausted undeletable candidates log remaining count and retry on later commits', t => {
  const dir = temp(t), logs = [], attempts = [], unlink = fs.unlinkSync;
  const store = createBudgetStore(dir, { maxEntries: 3, log: (...args) => logs.push(args) });
  t.mock.method(fs, 'unlinkSync', (...args) => {
    if (String(args[0]).endsWith('.json')) {
      attempts.push(args[0]);
      throw Object.assign(new Error('all records protected'), { code: 'EACCES' });
    }
    return unlink(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const counts = [], tries = [];
  for (let i = 0; i < 5; i++) {
    store.resolve('s' + i, 1000 + i);
    assert.equal(record(dir, 's' + i).budget, 1000 + i);
    counts.push(readdirSync(dir).length);
    tries.push(attempts.length);
  }
  assert.deepEqual(counts, [1, 2, 3, 4, 5]);
  assert.deepEqual(tries, [0, 0, 0, 4, 9]);
  assert.equal(logs.length, 2);
  assert.match(logs[0][0], /remaining=4.*target=3/);
  assert.match(logs[1][0], /remaining=5.*target=3/);
  assert.deepEqual(readdirSync(dir).sort(), ['s0.json', 's1.json', 's2.json', 's3.json', 's4.json']);
  t.diagnostic('M1 exhausted counts=' + JSON.stringify(counts) + '; attempts=' + JSON.stringify(tries) + '; logs=' + logs.map(row => row[0]).join(' | ') + '; retained=' + readdirSync(dir).sort().join(','));
});

test('a record that vanishes during stat counts as released capacity', t => {
  const dir = temp(t), stat = fs.statSync;
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 3; i++) {
    const file = join(dir, 's' + i + '.json');
    writeFileSync(file, JSON.stringify({ version: 1, budget: 1000 + i, at: i }));
    utimesSync(file, 1000 + i, 1000 + i);
  }
  t.mock.method(fs, 'statSync', (...args) => {
    if (args[0] === join(dir, 's0.json') && existsSync(args[0])) unlinkSync(args[0]);
    return stat(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const store = createBudgetStore(dir, { maxEntries: 3 });
  assert.equal(store.resolve('newest', 2000), 2000);
  assert.deepEqual(readdirSync(dir).sort(), ['newest.json', 's1.json', 's2.json']);
  t.diagnostic('ENOENT during stat retained=' + readdirSync(dir).sort().join(','));
});

test('a record that vanishes during unlink counts as released capacity', t => {
  const dir = temp(t), unlink = fs.unlinkSync;
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 3; i++) {
    const file = join(dir, 's' + i + '.json');
    writeFileSync(file, JSON.stringify({ version: 1, budget: 1000 + i, at: i }));
    utimesSync(file, 1000 + i, 1000 + i);
  }
  t.mock.method(fs, 'unlinkSync', (...args) => {
    if (args[0] === join(dir, 's0.json') && existsSync(args[0])) unlink(args[0]);
    return unlink(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const store = createBudgetStore(dir, { maxEntries: 3 });
  assert.equal(store.resolve('newest', 2000), 2000);
  assert.deepEqual(readdirSync(dir).sort(), ['newest.json', 's1.json', 's2.json']);
  t.diagnostic('ENOENT during unlink retained=' + readdirSync(dir).sort().join(','));
});

test('only the most recent records are kept', t => {
  const dir = temp(t);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 4; i++) {
    const file = join(dir, `s${i}.json`);
    writeFileSync(file, JSON.stringify({ version: 1, budget: 1000, at: i }));
    utimesSync(file, 1000 + i, 1000 + i);
  }
  const store = createBudgetStore(dir, { maxEntries: 3 });
  assert.equal(store.resolve('newest', 2000), 2000);
  assert.deepEqual(readdirSync(dir).sort(), ['newest.json', 's2.json', 's3.json']);
  assert.equal(existsSync(join(dir, 's0.json')), false);
});
