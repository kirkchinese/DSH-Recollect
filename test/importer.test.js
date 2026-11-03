import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeMemorySlugs, importMemoryDir } from '../lib/importer.js';
import { claudeMemoryStatus, runMemoryImport } from '../lib/share.js';

test('imports topic files without overwriting and merges index lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc-imp-'));
  const from = join(root, 'claude', 'projects', '-p', 'memory');
  const to = join(root, 'dsh', 'projects', '-p');
  await mkdir(join(from, 'sub'), { recursive: true });
  await mkdir(to, { recursive: true });
  await writeFile(join(from, 'a.md'), 'A');
  await writeFile(join(from, 'sub', 'b.md'), 'B');
  await writeFile(join(from, 'same.md'), 'S');
  await writeFile(join(from, 'clash.md'), 'NEW');
  await writeFile(join(from, 'MEMORY.md'), '- [A](a.md) — a\n- [S](same.md) — s\n');
  await writeFile(join(to, 'same.md'), 'S');
  await writeFile(join(to, 'clash.md'), 'OLD');
  await writeFile(join(to, 'MEMORY.md'), '- [S](same.md) — mine\n');
  const dry = await importMemoryDir({ from, to, dryRun: true });
  assert.deepEqual(dry.copied, ['a.md', 'sub/b.md']);
  assert.equal(await readFile(join(to, 'a.md'), 'utf8').catch(() => 'absent'), 'absent');
  const r = await importMemoryDir({ from, to });
  assert.deepEqual(r.identical, ['same.md']);
  assert.deepEqual(r.conflicts, ['clash.md']);
  assert.equal(r.indexAdded, 1);
  assert.equal(await readFile(join(to, 'clash.md'), 'utf8'), 'OLD');
  assert.equal(await readFile(join(to, 'MEMORY.md'), 'utf8'), '- [S](same.md) — mine\n- [A](a.md) — a\n');
  assert.deepEqual(await claudeMemorySlugs(join(root, 'claude')), ['-p']);
  const again = await importMemoryDir({ from, to });
  assert.equal(again.copied.length + again.indexAdded, 0);
});

test('import workflow refuses disabled memory and shared projects without I/O', async () => {
  const params = { projectRoot: '/project', from: '/claude', to: '/dsh', dryRun: true, enabled: true, share: { active: false } };
  const forbidden = async () => assert.fail('refusal must not touch disk');
  const deps = { sourceStatus: forbidden, importDir: forbidden, afterImport: forbidden };
  assert.equal((await runMemoryImport({ ...params, enabled: false }, deps)).refused, 'memory-off');
  for (const via of ['global', 'project']) assert.equal((await runMemoryImport({ ...params, share: { active: true, via } }, deps)).refused, 'shared');
});

test('source inspection excludes the index and refuses missing or index-only sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recollect-imp-empty-'));
  const from = join(root, 'source');
  const params = { projectRoot: root, from, to: join(root, 'dest'), dryRun: false, enabled: true, share: { active: false } };
  assert.deepEqual(await claudeMemoryStatus(from), { dir: from, exists: false, count: 0 });
  assert.equal((await runMemoryImport(params)).refused, 'no-source');
  await mkdir(from);
  await writeFile(join(from, 'MEMORY.md'), '- [Missing](missing.md)');
  assert.deepEqual(await claudeMemoryStatus(from), { dir: from, exists: true, count: 0 });
  assert.equal((await runMemoryImport(params)).refused, 'no-source');
  await mkdir(join(from, 'nested'));
  await writeFile(join(from, 'nested', 'topic.md'), 'topic');
  await writeFile(join(from, '.hidden.md'), 'hidden');
  await writeFile(join(from, 'note.txt'), 'not a topic');
  assert.equal((await claudeMemoryStatus(from)).count, 1);
});

test('preview is read-only; confirmed import preserves conflicts and refreshes only after commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recollect-imp-flow-'));
  const from = join(root, 'claude');
  const to = join(root, 'dsh');
  await mkdir(from); await mkdir(to);
  for (const [name, text] of [['new.md', 'new'], ['same.md', 'same'], ['clash.md', 'incoming'], ['MEMORY.md', '- [New](new.md)']]) await writeFile(join(from, name), text);
  await writeFile(join(to, 'same.md'), 'same');
  await writeFile(join(to, 'clash.md'), 'existing');
  const refreshed = [];
  const deps = { afterImport: dir => refreshed.push(dir) };
  const params = { projectRoot: root, from, to, dryRun: true, enabled: true, share: { active: false, via: 'directory' } };
  const preview = await runMemoryImport(params, deps);
  assert.deepEqual(preview, { projectRoot: root, from, to, dryRun: true, copied: ['new.md'], identical: ['same.md'], conflicts: ['clash.md'], indexAdded: 1 });
  assert.deepEqual(refreshed, []);
  assert.equal(await readFile(join(to, 'new.md'), 'utf8').catch(() => undefined), undefined);
  assert.equal(await readFile(join(to, 'MEMORY.md'), 'utf8').catch(() => undefined), undefined);
  const committed = await runMemoryImport({ ...params, dryRun: false }, deps);
  assert.deepEqual(committed, { ...preview, dryRun: false });
  assert.deepEqual(refreshed, [to]);
  assert.equal(await readFile(join(to, 'new.md'), 'utf8'), 'new');
  assert.equal(await readFile(join(to, 'clash.md'), 'utf8'), 'existing');
  assert.equal(await readFile(join(from, 'clash.md'), 'utf8'), 'incoming');
  assert.equal(await readFile(join(to, 'MEMORY.md'), 'utf8'), '- [New](new.md)\n');
});
