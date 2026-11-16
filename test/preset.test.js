import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESET, presetRows, registerFreeClaudePreset as registerPreset } from '../lib/preset.js';

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

function registry() {
  const definitions = new Map();
  const registered = [];
  return {
    definitions,
    registered,
    async register(def) {
      if (definitions.has(def.id)) throw new Error('Duplicate agent preset: ' + def.id);
      definitions.set(def.id, { config: def });
      registered.push(def);
      return async () => { definitions.delete(def.id); };
    },
  };
}
const STANDARD = [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }, { id: 'tool-office', name: '@deepseek-ai/dsh-tool-office' }];

test('copies the live standard rows once standard appears, and unregisters on dispose', async () => {
  const r = registry();
  const dispose = registerPreset({ agentPresets: r }, { intervalMs: 2 });
  await tick(10);
  assert.equal(r.registered.length, 0, 'waits for standard');
  r.definitions.set('standard', { config: { id: 'standard', plugins: STANDARD } });
  await tick(20);
  assert.equal(r.registered.length, 1);
  assert.equal(r.registered[0].id, PRESET.id);
  assert.deepEqual(r.registered[0].plugins, STANDARD);
  assert.notEqual(r.registered[0].plugins, STANDARD, 'own array');
  await dispose();
  assert.equal(r.definitions.has(PRESET.id), false);
});

test('does not duplicate a preset declared elsewhere; gives up after the timeout; tolerates odd registries', async () => {
  const logs = [];
  const r = registry();
  r.definitions.set(PRESET.id, { config: { id: PRESET.id, plugins: STANDARD } });
  r.definitions.set('standard', { config: { id: 'standard', plugins: STANDARD } });
  await registerPreset({ agentPresets: r }, { log: m => logs.push(m) });
  await tick();
  assert.equal(r.registered.length, 0);
  assert.match(logs[0], /already declared/);
  const empty = registry();
  const stop = registerPreset({ agentPresets: empty }, { intervalMs: 1, timeoutMs: 5, log: m => logs.push(m) });
  await tick(30);
  assert.equal(empty.registered.length, 0);
  assert.ok(logs.some(m => /did not appear/.test(m)));
  await stop();
  assert.equal(presetRows({}, 'standard'), undefined);
  assert.equal(presetRows(undefined, 'standard'), undefined);
});
