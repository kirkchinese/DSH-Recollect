/**
 * Durable per-session `<token_budget>` budgets for recollect.
 *
 * The budget a session first sends is recorded once and restored on resume or
 * after a host restart, so that session's system prompt (and its cache
 * prefix) stays byte-identical even when the setting changed meanwhile.
 * Sessions without a record (new ones, or ones created before budget records)
 * take the current setting. Budgets are never parsed back out of prompt text:
 * instruction or memory files may quote such tags.
 *
 * One small file per session, created with first-writer-wins semantics: the
 * record is written to a private temp file and hard-linked into place, which
 * fails atomically when another process got there first; the loser reads and
 * returns the winner's budget. No lock, no read-modify-write of a shared file,
 * no in-process budget cache, so every process sees other processes' records.
 * Corrupt/unreadable records fail open to the candidate without being overwritten.
 * An administrator must remove or repair those records; each store warns once
 * per affected session ID.
 * @module @kirkchinese/dsh-recollect/budget-store
 */
import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = 1;
/** Most recent session records kept in the directory. */
export const MAX_ENTRIES = 5000;

const fileName = id => `${encodeURIComponent(id)}.json`;

/**
 * @param dir - directory of records, e.g. `<dshHome>/recollect/budgets`.
 * @param options - `{ log?, maxEntries?, beforeCommit? }`; `beforeCommit(id)`
 *   runs between writing the temp file and linking it (tests use it to
 *   interleave another writer deterministically).
 */
export function createBudgetStore(dir, { log = () => {}, maxEntries = MAX_ENTRIES, beforeCommit } = {}) {
  const pathOf = id => join(dir, fileName(id));
  const warned = new Set();
  const warnRecord = (id, message, error) => {
    if (warned.has(id)) return;
    warned.add(id);
    log(message, pathOf(id), error);
  };
  /** @returns the recorded budget, undefined when absent, null when unreadable. */
  const readRecord = id => {
    try {
      const doc = JSON.parse(readFileSync(pathOf(id), 'utf8'));
      if (doc?.version === VERSION && Number.isFinite(doc.budget) && doc.budget > 0) return doc.budget;
      warnRecord(id, 'budget record has an unknown format; manual repair required');
      return null;
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      warnRecord(id, 'budget record unreadable; manual repair required', error);
      return null;
    }
  };
  const prune = () => {
    try {
      const files = readdirSync(dir).filter(name => name.endsWith('.json') && !name.startsWith('.'));
      if (files.length <= maxEntries) return;
      const removeTarget = files.length - maxEntries;
      const aged = files.map(name => {
        try { return { name, mtime: statSync(join(dir, name)).mtimeMs, vanished: false }; }
        catch (error) {
          // Unknown-age records still occupy capacity; a vanished one has
          // already released it and must count toward the removal target.
          if (error?.code === 'ENOENT') return { name, mtime: 0, vanished: true };
          return { name, mtime: 0, vanished: false };
        }
      }).sort((a, b) => a.mtime - b.mtime);
      let settled = 0;
      for (const { name, vanished } of aged) {
        if (settled >= removeTarget) break;
        if (vanished) { settled++; continue; }
        try {
          unlinkSync(join(dir, name));
          settled++;
        } catch (error) {
          // Another pruner may have removed it first: that also frees capacity.
          if (error?.code === 'ENOENT') settled++;
        }
      }
      if (settled < removeTarget) {
        const remaining = readdirSync(dir).filter(name => name.endsWith('.json') && !name.startsWith('.')).length;
        if (remaining > maxEntries) log(
          'budget records exceed retention limit: remaining=' + remaining + '; target=' + maxEntries,
          dir,
        );
      }
    } catch (error) {
      log('budget records could not be pruned', dir, error);
    }
  };
  return {
    /** Recorded budget of a session, or undefined. */
    get(id) {
      const value = readRecord(id);
      return value ?? undefined;
    },
    /**
     * The session's budget: its record when there is one, otherwise
     * `candidate`, which is recorded unless another process records first,
     * in which case that process's budget is returned.
     */
    resolve(id, candidate) {
      const existing = readRecord(id);
      if (existing !== undefined && existing !== null) return existing;
      const tmp = join(dir, `.${fileName(id)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(tmp, JSON.stringify({ version: VERSION, budget: candidate, at: Date.now() }));
        beforeCommit?.(id);
        // Recheck after preparing the candidate: another process may have
        // committed a valid record or an administrator may have repaired it.
        const current = readRecord(id);
        if (current !== undefined) return current ?? candidate;
        try {
          linkSync(tmp, pathOf(id));
        } catch (error) {
          const winner = readRecord(id);
          if (winner !== undefined && winner !== null) return winner;
          if (error?.code !== 'EEXIST') throw error;
          // Never overwrite an existing target, even when this read is corrupt
          // or it disappears: a subsequent repair may already be underway.
          return candidate;
        }
        prune();
        return candidate;
      } catch (error) {
        log('budget record write failed', pathOf(id), error);
        return candidate;
      } finally {
        try { unlinkSync(tmp); } catch { /* linked-then-removed or never written */ }
      }
    },
  };
}
