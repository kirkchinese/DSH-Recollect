import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config, isResolved, liveConfig } from '../lib/config.js';

test('live config reads volatile sections at access time', () => {
  const resolved = Config({});
  assert.ok(isResolved(resolved));
  const config = liveConfig(resolved);
  assert.equal(config.recall.enabled, false);
  const write = Object.getOwnPropertySymbols(resolved.recall).find(s => String(s).includes('volatile.write'));
  resolved.recall[write]({ ...resolved.recall.get(), enabled: true });
  assert.equal(config.recall.enabled, true);
  assert.equal(config.dream.minHours, 24);
});
