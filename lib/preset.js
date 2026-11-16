/**
 * Registers the unofficial "Free Claude" agent preset as a copy of the host's own
 * `standard` preset, read at runtime from the preset registry.
 *
 * A fixed plugin list in the bundle patch broke whenever DSH removed or
 * renamed a standard component (0.2.2 dropped
 * `@deepseek-ai/dsh-tool-subagent-control/list-agents`, and the preset failed
 * to load). Copying the live definition keeps the preset in step with every
 * DSH version, including the user's own edits to `standard`.
 * @module @kirkchinese/dsh-recollect/preset
 */

export const PRESET = Object.freeze({
  id: 'free-claude',
  name: 'Free Claude',
  description: 'Unofficial independent preset; not affiliated with Anthropic. 非官方独立预设，与 Anthropic 无关。',
  order: 15,
});

/**
 * Child plugin rows of a registered preset. `definitions` is the registry's
 * own map (`id → { config }`); `readDocument` exposes the same rows only as
 * YAML, so the map is read directly and the result is validated.
 * @param registry - the `agentPresets` service.
 * @param id - preset id.
 * @returns the rows, or undefined when the preset is not registered (yet).
 */
export function presetRows(registry, id) {
  const rows = registry?.definitions?.get?.(id)?.config?.plugins;
  return Array.isArray(rows) && rows.length > 0 ? rows : undefined;
}

/**
 * Wait for the base preset, then register the copy.
 * @param ctx - context with `agentPresets` injected.
 * @param opts - `{ base, log, intervalMs, timeoutMs }`.
 * @returns a disposer.
 */
export function registerFreeClaudePreset(ctx, { base = 'standard', log = () => {}, intervalMs = 250, timeoutMs = 120000 } = {}) {
  const registry = ctx.agentPresets;
  let disposed = false;
  let unregister;
  let timer;
  const started = Date.now();
  const attempt = async () => {
    if (disposed) return;
    if (registry.definitions?.has?.(PRESET.id)) {
      log(`agent preset "${PRESET.id}" is already declared elsewhere (for example an old profile row); not registering a copy`);
      return;
    }
    const rows = presetRows(registry, base);
    if (rows === undefined) {
      if (registry.definitions === undefined) {
        log('agent preset registry has no readable definitions; the Free Claude preset is not registered');
        return;
      }
      if (Date.now() - started > timeoutMs) {
        log(`base preset "${base}" did not appear within ${timeoutMs} ms; the Free Claude preset is not registered`);
        return;
      }
      timer = setTimeout(() => { void attempt(); }, intervalMs);
      return;
    }
    try {
      const release = await registry.register({ ...PRESET, plugins: [...rows] });
      if (disposed) await release();
      else unregister = release;
    } catch (error) {
      log('registering the Free Claude preset failed', error);
    }
  };
  void attempt();
  return async () => {
    disposed = true;
    clearTimeout(timer);
    const release = unregister;
    unregister = undefined;
    await release?.();
  };
}
