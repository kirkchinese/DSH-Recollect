/**
 * Active locale for model-facing text. The plugin sets it once from its
 * config; modules read it at render time.
 * @module @kirkchinese/dsh-recollect/i18n
 */
import { texts } from './text/index.js';

let active = texts('zh');

/** Select the locale ('zh' | 'en'). */
export function setLanguage(lang) {
  active = texts(lang);
}

/** Current locale object (see lib/text/SPEC.md). */
export function t() {
  return active;
}
