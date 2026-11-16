/**
 * Context-growth ledger, independently implemented from the public behavior.
 * Measurements are context sizes, not billed input tokens. Only an explicit,
 * successful summary boundary adds a whole discarded context to the coordinate.
 * A human message starts a new pacing interval; within it usage never decreases.
 */
export const DEFAULT_TOKEN_BUDGET = 15000000;
export const tokenBudget = value => Number.isFinite(value) && value >= 1
  ? Math.floor(value) : DEFAULT_TOKEN_BUDGET;
const valid = value => Number.isFinite(value) && value >= 0;

export class TokenLedger {
  #sessions = new Map();
  #state(id) {
    if (!this.#sessions.has(id)) this.#sessions.set(id, { rollover: 0, anchor: undefined, used: 0, pendingAnchor: false });
    return this.#sessions.get(id);
  }
  /** Commit exactly once per successful compaction (the caller owns event IDs). */
  rollOverContext(id, before) {
    if (!valid(before)) return;
    this.#state(id).rollover += before;
  }
  /** Missing samples emit nothing; a user's reanchor waits for a valid sample. */
  observe(id, context, budget = DEFAULT_TOKEN_BUDGET, reanchor = false) {
    const state = this.#state(id);
    if (reanchor) state.pendingAnchor = true;
    if (!valid(context)) return undefined;
    const coordinate = state.rollover + context;
    if (state.pendingAnchor || state.anchor === undefined) {
      state.anchor = coordinate;
      state.used = 0;
      state.pendingAnchor = false;
    }
    state.used = Math.max(state.used, coordinate - state.anchor);
    return Math.max(0, tokenBudget(budget) - Math.floor(state.used));
  }
  forget(id) { this.#sessions.delete(id); }
  clear() { this.#sessions.clear(); }
}
