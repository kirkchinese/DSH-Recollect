/**
 * What the model can currently see, folded from the session's visible
 * surface (so compaction that summarizes our messages is detected), and the
 * diff of announced files.
 * @module @kirkchinese/dsh-recollect/state
 */
import { createHash } from 'node:crypto';
import { SOURCE_KIND } from './constants.js';

/** SHA-1 of content. */
export const digest = text => createHash('sha1').update(text).digest('hex');

/**
 * Message source for an instruction announcement.
 * @param role - 'baseline' | 'diff' | 'nested'.
 * @param files - announced files.
 * @param extra - `{ identity?, removed?, reason? }`.
 */
export function instructionSource(role, files, extra = {}) {
  return {
    kind: SOURCE_KIND,
    form: 'instructions',
    role,
    files: files.map(f => ({ path: f.path, type: f.type, digest: digest(f.content) })),
    ...(extra.removed?.length ? { removed: extra.removed } : {}),
    ...(extra.reason ? { reason: extra.reason } : {}),
    ...(extra.identity ? { identity: extra.identity } : {}),
  };
}

const isOurs = (source, role) => source?.kind === SOURCE_KIND && (role === undefined || source.role === role);

/**
 * Sources of our instruction messages on the visible surface plus messages
 * about to enter, in order.
 * @param agent - live agent.
 * @param pending - messages entering with this step.
 */
function visibleSources(agent, pending = []) {
  const out = [];
  const session = agent.session;
  for (const seq of session.surface.nodes) {
    const ev = session.eventAt(seq);
    if (ev?.type === 'user/message' && isOurs(ev.data.source) && ev.data.source.form === 'instructions') out.push(ev.data.source);
  }
  for (const m of pending) if (isOurs(m.source) && m.source.form === 'instructions') out.push(m.source);
  return out;
}

/**
 * Fold the announced instruction state.
 * @param agent - live agent.
 * @param pending - messages entering with this step.
 * @returns `{ baseline: source|undefined, announced: Map<path,{type,digest,scope}> }`;
 *   without a visible baseline the map is empty.
 */
export function announcedState(agent, pending = []) {
  const sources = visibleSources(agent, pending);
  let start = -1;
  for (let i = sources.length - 1; i >= 0; i -= 1) {
    if (sources[i].role === 'baseline') {
      start = i;
      break;
    }
  }
  const announced = new Map();
  if (start === -1) return { baseline: undefined, announced };
  for (const s of sources.slice(start)) {
    for (const f of s.files ?? []) {
      const prior = announced.get(f.path);
      const scope = s.role === 'nested' && prior?.scope !== 'startup' ? 'nested' : 'startup';
      announced.set(f.path, { type: f.type, digest: f.digest, scope });
    }
    for (const p of s.removed ?? []) announced.delete(p);
  }
  return { baseline: sources[start], announced };
}

/**
 * Whether any of our baselines ever entered this session (visible or not).
 * @param agent - live agent.
 */
export function everAnnounced(agent) {
  const session = agent.session;
  for (let seq = 0; seq < session.seq; seq += 1) {
    const ev = session.eventAt(seq);
    if (ev?.type === 'user/message' && isOurs(ev.data.source, 'baseline')) return true;
  }
  return false;
}

/**
 * Diff: changed or new files, removed paths; undefined when equal.
 * @param current - current files (startup set).
 * @param announced - map from {@link announcedState}.
 */
export function diffInstructions(current, announced) {
  const paths = new Set(current.map(f => f.path));
  const files = current.filter(f => {
    const prev = announced.get(f.path);
    return prev === undefined || prev.digest !== digest(f.content) || prev.type !== f.type;
  });
  const removed = [...announced].filter(([p, v]) => v.scope === 'startup' && !paths.has(p)).map(([p]) => p);
  if (files.length === 0 && removed.length === 0) return undefined;
  return { files, removed };
}
