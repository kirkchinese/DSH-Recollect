/**
 * Active locale for model-facing text. The plugin sets it once from its
 * config; modules read it at render time.
 * @module @kirkchinese/dsh-recollect/i18n
 */
import { texts } from './text/index.js';

let current = () => 'zh';

/** Select the locale: 'zh' | 'en', or a function read at every use (live config). */
export function setLanguage(lang) {
  current = typeof lang === 'function' ? lang : () => lang;
}

/** Current locale object (see lib/text/SPEC.md). */
export function t() {
  return texts(current());
}
