import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenLedger, tokenBudget, DEFAULT_TOKEN_BUDGET } from '../lib/token-ledger.js';

test('context growth consumes a pacing interval; user input reanchors', () => {
  const ledger = new TokenLedger();
  const amounts = [[1000, true], [1200, false], [1600, false], [300, false], [1700, false], [1800, true]]
    .map(([n, user]) => ledger.observe('a', n, 1000, user));
  assert.deepEqual(amounts, [1000, 800, 400, 400, 300, 1000]);
});
test('only explicit rollover adds the full previous context, including repeated compactions', () => {
  const ledger = new TokenLedger();
  assert.equal(ledger.observe('a', 1000, 10000, true), 10000);
  assert.equal(ledger.observe('a', 1600, 10000), 9400);
  ledger.rollOverContext('a', 1600);
  assert.equal(ledger.observe('a', 300, 10000), 9100);
  assert.equal(ledger.observe('a', 500, 10000), 8900);
  ledger.rollOverContext('a', 500);
  assert.equal(ledger.observe('a', 200, 10000), 8700);
  assert.equal(ledger.observe('a', 200, 10000, true), 10000);
});
test('invalid samples do not anchor, decrease usage or contaminate sessions', () => {
  const ledger = new TokenLedger();
  for (const value of [undefined, NaN, Infinity, -1]) {
    assert.equal(ledger.observe('a', value, 1000, true), undefined);
    ledger.rollOverContext('a', value);
  }
  assert.equal(ledger.observe('a', 1000, 1000), 1000);
  assert.equal(ledger.observe('a', 1400, 1000), 600);
  assert.equal(ledger.observe('b', 1400, 1000), 1000);
  assert.equal(ledger.observe('a', 300, 1000), 600);
  assert.equal(ledger.observe('a', 9000, 1000), 0);
  ledger.forget('a');
  assert.equal(ledger.observe('a', 1400, 1000), 1000);
  ledger.clear();
  assert.equal(ledger.observe('b', 2000, 1000), 1000);
});
test('a user reanchor survives a missing measurement after an established anchor', t => {
  const ledger = new TokenLedger();
  const remaining = [
    ledger.observe('a', 1000, 1000, true),
    ledger.observe('a', 1600, 1000),
    ledger.observe('a', undefined, 1000, true),
    ledger.observe('a', 1800, 1000),
    ledger.observe('a', 1900, 1000),
  ];
  assert.deepEqual(remaining, [1000, 400, undefined, 1000, 900]);
  t.diagnostic('M3 reanchor sequence=' + remaining.map(n => n ?? 'no reminder').join(' -> '));
});

test('budget normalization returns positive integers with a generous default', () => {
  for (const value of [undefined, NaN, Infinity, -1, 0]) assert.equal(tokenBudget(value), DEFAULT_TOKEN_BUDGET);
  assert.equal(DEFAULT_TOKEN_BUDGET, 15000000);
  assert.equal(tokenBudget(1234.9), 1234);
});
