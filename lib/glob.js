/**
 * Small glob matcher (no dependency): `**`, `*`, `?`, `[...]`, `{a,b}`.
 * `matchAbsolute` serves the excludes list (absolute paths, dotfiles
 * included); `matchIgnoreStyle` serves rule `paths:` with gitignore-like
 * semantics (a pattern without a slash matches any path segment depth).
 * @module @kirkchinese/dsh-recollect/glob
 */

const cache = new Map();

/**
 * Compile one glob into an anchored RegExp.
 * @param glob - pattern.
 */
export function globToRegExp(glob) {
  const hit = cache.get(glob);
  if (hit !== undefined) return hit;
  let re = '';
  let i = 0;
  let braces = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 3 : 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (c === '{') {
      braces += 1;
      re += '(?:';
    } else if (c === '}' && braces > 0) {
      braces -= 1;
      re += ')';
    } else if (c === ',' && braces > 0) re += '|';
    else re += c.replace(/[.+^$()|\\]/g, '\\$&');
    i += 1;
  }
  const compiled = new RegExp(`^${re}$`);
  cache.set(glob, compiled);
  return compiled;
}

/**
 * Whether an absolute path matches any glob (patterns are absolute or `**`-prefixed).
 * @param path - absolute path with `/` separators.
 * @param globs - patterns.
 */
export function matchAbsolute(path, globs) {
  return globs.some(g => globToRegExp(g).test(path));
}

/**
 * gitignore-style match of a relative path.
 * @param rel - relative path with `/` separators, no leading `./`.
 * @param globs - patterns.
 */
export function matchIgnoreStyle(rel, globs) {
  let matched = false;
  for (let g of globs) {
    let negate = false;
    if (g.startsWith('!')) {
      negate = true;
      g = g.slice(1);
    }
    if (g.startsWith('./')) g = g.slice(2);
    const anchored = g.startsWith('/') || g.slice(0, -1).includes('/');
    if (g.startsWith('/')) g = g.slice(1);
    const dirOnly = g.endsWith('/');
    if (dirOnly) g = g.slice(0, -1);
    const pattern = anchored ? g : `**/${g}`;
    const re = globToRegExp(pattern);
    // A match on any ancestor directory also covers the path below it.
    const parts = rel.split('/');
    let hit = false;
    for (let n = parts.length; n >= 1 && !hit; n -= 1) {
      if (dirOnly && n === parts.length) continue;
      hit = re.test(parts.slice(0, n).join('/'));
    }
    if (hit) matched = !negate;
  }
  return matched;
}
