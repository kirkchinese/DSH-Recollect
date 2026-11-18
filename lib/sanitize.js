/**
 * Content cleaning before injection.
 *
 * `cleanText`: normalize CR / Unicode line
 * separators to `\n`, drop C0/C1 controls and invisible format, private-use,
 * unassigned, surrogate and default-ignorable code points, keeping tab,
 * newline, ZWNJ, ZWJ and the emoji variation selectors. Applied to every
 * injected file.
 * `neutralizeTags` keeps file content from closing the plugin-owned frame.
 * @module @kirkchinese/dsh-recollect/sanitize
 */

const KEEP = new Set([0x200c, 0x200d, 0xfe0e, 0xfe0f, 9, 10, 13]);
const INVISIBLE = /^[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}]$/u;

/**
 * Whether one code point is removed by {@link cleanText}.
 * @param ch - a single code point string.
 */
export function isHiddenChar(ch) {
  const cp = ch.codePointAt(0);
  if (KEEP.has(cp)) return false;
  return INVISIBLE.test(ch) || cp < 32 || (cp >= 127 && cp <= 159);
}

/**
 * Normalize line breaks and strip hidden characters.
 * @param text - raw file text.
 * @returns cleaned text.
 */
export function cleanText(text) {
  let out = '';
  for (const ch of text.replace(/\r\n?|[\u2028\u2029]/g, '\n')) {
    if (!isHiddenChar(ch)) out += ch;
  }
  return out;
}

/**
 * Escape `<system-reminder>` frame tags inside content.
 * @param text - content to embed in a reminder frame.
 */
export function neutralizeTags(text) {
  return text.replace(/<(\/?)(system-reminder)(\s*)>/gi, '&lt;$1$2$3&gt;');
}

/**
 * Clean then neutralize.
 * @param text - raw content.
 */
export function sanitize(text) {
  return neutralizeTags(cleanText(text));
}

/**
 * A prefix of at most `max` UTF-16 code units that never ends in half of a
 * surrogate pair. Plain `slice(0, max)` can leave a lone high surrogate, which
 * strict JSON parsers (DeepSeek) reject as "lone leading surrogate".
 * @param text - source string.
 * @param max - maximum length in code units.
 */
export function clipUnits(text, max) {
  if (text.length <= max) return text;
  const end = max > 0 && (text.charCodeAt(max - 1) & 0xfc00) === 0xd800 ? max - 1 : max;
  return text.slice(0, end);
}
