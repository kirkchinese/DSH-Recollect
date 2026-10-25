/** Independent implementation from public BM25F algorithm descriptions (Robertson & Zaragoza)
 * and the Porter 1980 stemming algorithm as published by Martin Porter. */

const K1 = 1.2;
const B = 0.75;
const FIELDS = { filename: 3, frontmatter: 3, headings: 2.5, body: 1 };
const STOP = new Set('a an and are as at be been but by for from had has have in into is it its of on or our that the their them there these this those to was were will with you your'.split(' '));
const WORDS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu;
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;

/** Porter measures consonant/vowel runs; y is a consonant initially and
 * alternates according to its predecessor. */
function consonant(word, i) {
  const c = word[i];
  return !'aeiou'.includes(c) && (c !== 'y' || i === 0 || !consonant(word, i - 1));
}
function measure(word) {
  let count = 0, vowelSeen = false;
  for (let i = 0; i < word.length; i++) {
    if (!consonant(word, i)) vowelSeen = true;
    else if (vowelSeen) { count++; vowelSeen = false; }
  }
  return count;
}
function hasVowel(word) {
  for (let i = 0; i < word.length; i++) if (!consonant(word, i)) return true;
  return false;
}
function cvc(word) {
  const n = word.length;
  return n >= 3 && consonant(word, n - 1) && !consonant(word, n - 2) && consonant(word, n - 3) && !'wxy'.includes(word[n - 1]);
}

/** Original Porter suffix rules, applied only to ASCII alphabetic words. */
export function stem(input) {
  let w = String(input).toLowerCase();
  if (!/^[a-z]+$/.test(w) || w.length < 3) return w;
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (w.endsWith('ss')) { /* retain ss */ }
  else if (w.endsWith('s')) w = w.slice(0, -1);

  let changed = false;
  if (w.endsWith('eed')) {
    const base = w.slice(0, -3);
    if (measure(base) > 0) w = base + 'ee';
  } else for (const suffix of ['ed', 'ing']) {
    if (w.endsWith(suffix) && hasVowel(w.slice(0, -suffix.length))) {
      w = w.slice(0, -suffix.length);
      changed = true;
      break;
    }
  }
  if (changed) {
    if (/(at|bl|iz)$/.test(w)) w += 'e';
    else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
    else if (measure(w) === 1 && cvc(w)) w += 'e';
  }
  if (w.endsWith('y') && hasVowel(w.slice(0, -1))) w = w.slice(0, -1) + 'i';

  const step2 = { ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize', abli: 'able', alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous', ization: 'ize', ation: 'ate', ator: 'ate', alism: 'al', iveness: 'ive', fulness: 'ful', ousness: 'ous', aliti: 'al', iviti: 'ive', biliti: 'ble' };
  const step3 = { icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: '' };
  const replace = (rules, minimum) => {
    for (const suffix of Object.keys(rules).sort((a, b) => b.length - a.length)) {
      if (w.endsWith(suffix)) {
        const base = w.slice(0, -suffix.length);
        if (measure(base) > minimum) w = base + rules[suffix];
        break;
      }
    }
  };
  replace(step2, 0);
  replace(step3, 0);
  for (const suffix of ['ement', 'ance', 'ence', 'able', 'ible', 'ment', 'ant', 'ent', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize', 'al', 'er', 'ic', 'ou', 'ion']) {
    if (!w.endsWith(suffix)) continue;
    const base = w.slice(0, -suffix.length);
    if (measure(base) > 1 && (suffix !== 'ion' || /[st]$/.test(base))) w = base;
    break;
  }
  if (w.endsWith('e')) {
    const base = w.slice(0, -1);
    if (measure(base) > 1 || measure(base) === 1 && !cvc(base)) w = base;
  }
  if (w.endsWith('ll') && measure(w) > 1) w = w.slice(0, -1);
  return w;
}

function tokensWithPositions(text) {
  // Preserve source boundaries before case folding, so camelCase components and
  // their joined spelling can both be searched without conflating their positions.
  const source = String(text ?? '').normalize('NFKC')
    .replace(/(^|[^\p{L}\p{N}])c\+\+(?=$|[^\p{L}\p{N}])/giu, '$1 cpp ')
    .replace(/(^|[^\p{L}\p{N}])c#(?=$|[^\p{L}\p{N}])/giu, '$1 csharp ')
    .replace(/(^|[^\p{L}\p{N}])\.net(?=$|[^\p{L}\p{N}])/giu, '$1 dotnet ')
    .normalize('NFD').replace(/\p{M}/gu, '');
  const out = [];
  let position = 0;
  for (const match of source.matchAll(WORDS)) {
    const raw = match[0];
    if (CJK.test(raw)) {
      const chars = Array.from(raw);
      for (let i = 0; i < Math.max(1, chars.length - 1); i++) out.push({ term: chars.length === 1 ? chars[0] : chars[i] + chars[i + 1], position: position++ });
      continue;
    }
    const pieces = raw.replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, '$1 $2')
      .replace(/([\p{Ll}])([\p{Lu}])/gu, '$1 $2')
      .replace(/([\p{L}])([\p{N}])|([\p{N}])([\p{L}])/gu, '$1$3 $2$4')
      .split(' ').filter(Boolean);
    const start = position;
    for (const piece of pieces) {
      const word = piece.toLowerCase();
      if (!STOP.has(word)) out.push({ term: stem(word), position });
      position++;
    }
    if (pieces.length > 1) {
      const joined = pieces.join('').toLowerCase();
      if (!STOP.has(joined)) out.push({ term: stem(joined), position: start });
    }
  }
  return out;
}

export function tokenize(text) { return tokensWithPositions(text).map(({ term }) => term); }

function fieldsOf({ filename = '', text = '' }) {
  let content = String(text).replace(/^\uFEFF/, '');
  let frontmatter = '';
  const header = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (header) { frontmatter = header[1]; content = content.slice(header[0].length); }
  const headings = [], body = [];
  let fence = null;
  for (const line of content.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
    }
    if (!fence && !marker && /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line)) headings.push(line.replace(/^ {0,3}#{1,6}[ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, ''));
    else body.push(line);
  }
  const basename = String(filename).split(/[\\/]/).pop().replace(/\.md$/i, '').replace(/[-_.]/g, ' ');
  return { filename: basename, frontmatter, headings: headings.join('\n'), body: body.join('\n') };
}

export function createIndex(documents = []) {
  const index = { docs: new Map(), postings: new Map(), lengths: Object.fromEntries(Object.keys(FIELDS).map(field => [field, 0])), populated: Object.fromEntries(Object.keys(FIELDS).map(field => [field, 0])) };
  for (const document of documents) addDocument(index, document);
  return index;
}

export function removeDocument(index, path) {
  const old = index.docs.get(path);
  if (!old) return;
  for (const [field, data] of Object.entries(old.fields)) {
    index.lengths[field] -= data.length;
    if (data.length) index.populated[field]--;
    for (const term of data.terms.keys()) {
      const posting = index.postings.get(term);
      const record = posting.get(path);
      delete record[field];
      if (!Object.keys(record).length) posting.delete(path);
      if (!posting.size) index.postings.delete(term);
    }
  }
  index.docs.delete(path);
}

export function addDocument(index, { path, filename, text }) {
  removeDocument(index, path);
  const fields = {};
  for (const [field, value] of Object.entries(fieldsOf({ filename, text }))) {
    const tokens = tokensWithPositions(value);
    const terms = new Map();
    for (const { term, position } of tokens) {
      if (!terms.has(term)) terms.set(term, []);
      terms.get(term).push(position);
    }
    const length = tokens.reduce((max, token) => Math.max(max, token.position + 1), 0);
    fields[field] = { length, terms };
    index.lengths[field] += length;
    if (length) index.populated[field]++;
    for (const [term, positions] of terms) {
      if (!index.postings.has(term)) index.postings.set(term, new Map());
      const posting = index.postings.get(term);
      if (!posting.has(path)) posting.set(path, {});
      posting.get(path)[field] = positions;
    }
  }
  index.docs.set(path, { fields });
}

function phraseMatches(record, phrase) {
  for (const field of Object.keys(FIELDS)) {
    const starts = record[field]?.get(phrase[0]);
    if (!starts) continue;
    if (starts.some(start => phrase.every((term, i) => record[field].get(term)?.includes(start + i)))) return FIELDS[field];
  }
  return 0;
}

export function rank(index, query, limit = Infinity) {
  const q = String(query ?? '');
  const clipped = q.length > 4096 ? q.slice(0, 2048) + ' ' + q.slice(-2048) : q;
  const terms = [...new Set(tokenize(clipped))].slice(0, 64);
  const N = index.docs.size;
  if (!N || !terms.length || limit <= 0) return [];
  const termSet = new Set(terms);
  const scores = new Map();
  for (const term of terms) {
    const posting = index.postings.get(term);
    if (!posting) continue;
    const idf = Math.log(1 + (N - posting.size + 0.5) / (posting.size + 0.5));
    for (const [path, fields] of posting) {
      let tf = 0;
      for (const [field, positions] of Object.entries(fields)) {
        // Empty fields do not contribute to the average length of that field.
        const avg = index.lengths[field] / index.populated[field];
        const length = index.docs.get(path).fields[field].length;
        tf += FIELDS[field] * positions.length / (1 - B + B * length / (avg || 1));
      }
      scores.set(path, (scores.get(path) ?? 0) + idf * (K1 + 1) * tf / (K1 + tf));
    }
  }
  const phrases = [...clipped.matchAll(/"([^"\n]+)"/g)].map(match => tokenize(match[1]).filter(term => termSet.has(term))).filter(phrase => phrase.length > 1);
  if (phrases.length) {
    for (const path of scores.keys()) {
      const doc = index.docs.get(path);
      const record = Object.fromEntries(Object.entries(doc.fields).map(([field, data]) => [field, data.terms]));
      for (const phrase of phrases) {
        const weight = phraseMatches(record, phrase);
        if (weight) scores.set(path, scores.get(path) + 0.5 * weight);
      }
    }
  }
  return [...scores].filter(([, score]) => score > 0).map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/** For >=16 docs, IDF(df=1) times 1.7 exceeds the maximum score of
 * a *single occurrence* in the body: normalized tf <= 1/(1-b) = 4,
 * so (k1+1)*4/(k1+4) = 1.6923. Stronger field/term evidence can pass. */
export function relevanceFloor(docCount) {
  if (docCount < 16) return 0;
  return 1.7 * Math.log(1 + (docCount - 0.5) / 1.5);
}
