import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanMemories, buildSelectorRequest } from '../lib/recall.js';
import { clipUnits } from '../lib/sanitize.js';

test('a description fallback never ends in half a character', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'recollect-recall-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The 120th code unit is the high surrogate of 🔹 (U+1F539).
  await writeFile(join(dir, 'emoji.md'), `${'a'.repeat(119)}🔹${'b'.repeat(40)}\n\nbody\n`);
  const file = (await scanMemories(dir)).find(f => f.filename === 'emoji.md');
  assert.equal(file.description, 'a'.repeat(119));
  assert.ok(file.description.isWellFormed());
  const { messages } = buildSelectorRequest({ manifestFiles: [file], query: 'q' });
  for (const m of messages) for (const b of m.content) if (b.type === 'text') assert.ok(b.text.isWellFormed());
});

test('clipUnits keeps surrogate pairs whole', () => {
  assert.equal(clipUnits('ab🔹', 3), 'ab');
  assert.equal(clipUnits('ab🔹', 4), 'ab🔹');
  assert.equal(clipUnits('abc', 10), 'abc');
  assert.equal(clipUnits('🔹', 1), '');
});
