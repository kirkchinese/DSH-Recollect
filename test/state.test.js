import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announcedState, diffInstructions, digest, everAnnounced, instructionSource } from '../lib/state.js';

/** Minimal agent double: events by seq, surface = visible seqs. */
function fakeAgent(events, surface = events.map((_, i) => i)) {
  return { session: { seq: events.length, eventAt: s => events[s], surface: { nodes: surface } } };
}
const msg = source => ({ type: 'user/message', data: { source, content: [] } });
const A = { path: '/p/CLAUDE.md', type: 'Project', content: 'a' };
const B = { path: '/p/AGENTS.md', type: 'Project', content: 'b' };
const N = { path: '/p/sub/CLAUDE.md', type: 'Project', content: 'n' };

test('no baseline visible after compaction, but history has one', () => {
  const events = [msg(instructionSource('baseline', [A, B], { identity: 'x' })), { type: 'turn/end' }];
  const agent = fakeAgent(events, [1]);
  assert.equal(announcedState(agent).baseline, undefined);
  assert.equal(everAnnounced(agent), true);
});

test('fold baseline + diff + nested; diff ignores nested-only paths', () => {
  const events = [
    msg(instructionSource('baseline', [A, B], { identity: 'x' })),
    msg(instructionSource('diff', [{ ...A, content: 'a2' }], { removed: ['/p/AGENTS.md'] })),
    msg(instructionSource('nested', [N])),
  ];
  const { baseline, announced } = announcedState(fakeAgent(events));
  assert.equal(baseline.identity, 'x');
  assert.deepEqual([...announced.keys()].sort(), ['/p/CLAUDE.md', '/p/sub/CLAUDE.md']);
  assert.equal(announced.get('/p/CLAUDE.md').digest, digest('a2'));
  assert.equal(diffInstructions([{ ...A, content: 'a2' }], announced), undefined, 'nested file is not reported as removed');
  const d = diffInstructions([{ ...A, content: 'a3' }, B], announced);
  assert.deepEqual(d.files.map(f => f.path), ['/p/CLAUDE.md', '/p/AGENTS.md']);
  assert.deepEqual(d.removed, []);
});

test('pending messages count as visible', () => {
  const agent = fakeAgent([]);
  const pending = [{ source: instructionSource('baseline', [A], { identity: 'y' }) }];
  assert.equal(announcedState(agent, pending).baseline.identity, 'y');
});
