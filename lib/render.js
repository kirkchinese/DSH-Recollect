/**
 * Model-visible rendering of instruction blocks, refresh diffs and the index
 * truncation warning. Wording comes from the active locale (lib/text).
 * @module @kirkchinese/dsh-recollect/render
 */
import { INDEX_MAX_LINES, INDEX_MAX_UNITS } from './constants.js';
import { sanitize } from './sanitize.js';
import { t } from './i18n.js';

/**
 * Size formatter for the index (`units / 1024`, one decimal, "KB").
 * @param n - UTF-16 code units.
 */
export function formatKB(n) {
  return `${(n / 1024).toFixed(1)}KB`;
}

/**
 * Truncate the memory index to 200 lines and 25 000 UTF-16 units, appending
 * a warning paragraph when anything was cut.
 * @param raw - index text.
 */
export function truncateIndex(raw) {
  const trimmed = raw.trim();
  const lineCount = trimmed.split('\n').length;
  const unitCount = trimmed.length;
  const lineOver = lineCount > INDEX_MAX_LINES;
  const unitOver = unitCount > INDEX_MAX_UNITS;
  const base = { lineCount, unitCount, wasLineTruncated: lineOver, wasUnitTruncated: unitOver };
  if (!lineOver && !unitOver) return { content: trimmed, ...base };
  let kept = lineOver ? trimmed.split('\n').slice(0, INDEX_MAX_LINES).join('\n') : trimmed;
  if (kept.length > INDEX_MAX_UNITS) {
    const cut = kept.lastIndexOf('\n', INDEX_MAX_UNITS);
    kept = kept.slice(0, cut > 0 ? cut : INDEX_MAX_UNITS);
  }
  const keptLines = trimmed[kept.length] === '\n' ? kept.split('\n').length : 0;
  const nextStart = kept.length + 1;
  const nextEnd = trimmed.indexOf('\n', nextStart);
  const nextLine = trimmed.slice(nextStart, nextEnd < 0 ? undefined : nextEnd).trim();
  const warning = t().indexWarning({
    lineCount,
    maxLines: INDEX_MAX_LINES,
    sizeKB: formatKB(unitCount),
    maxKB: formatKB(INDEX_MAX_UNITS),
    kind: lineOver && unitOver ? 'both' : lineOver ? 'lines' : 'size',
    keptLines,
    cutLines: lineCount - keptLines,
    nextLineNo: keptLines + 1,
    nextLineSnippet: nextLine.slice(0, 80),
    keptChars: kept.length,
  });
  return { content: `${kept}\n\n${warning}`, ...base };
}

/** Instruction preamble for an authority setting ('strong' | 'soft'). */
export function preambleFor(authority) {
  return authority === 'soft' ? t().preamble.soft : t().preamble.strong;
}

/**
 * One file section.
 * @param file - `{ path, type, content }`.
 */
export function renderSection(file) {
  return `${t().section(sanitize(file.path), t().labels[file.type] ?? '')}\n\n${sanitize(file.content).trim()}`;
}

/** Wrap text in the reminder frame. */
export function reminder(text) {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

/**
 * Full baseline: preamble plus every section; '' when there is nothing.
 * @param files - ordered instruction files.
 * @param preamble - authority wording.
 */
export function renderBaseline(files, preamble) {
  const body = files.map(renderSection).join('\n\n');
  return body === '' ? '' : reminder(`${preamble}\n\n${body}`);
}

/**
 * Refresh diff: changed files replace earlier copies; removed paths listed.
 * @param diff - `{ files, removed }`.
 * @param reason - refresh reason key.
 */
export function renderDiff(diff, reason) {
  const tx = t();
  const when = tx.refresh.when[reason] ?? tx.refresh.when.turn;
  const parts = [];
  if (diff.files.length > 0) parts.push(tx.refresh.intro(when), ...diff.files.map(renderSection));
  for (const p of diff.removed) parts.push(tx.refresh.removed(sanitize(p)));
  return parts.length === 0 ? '' : reminder(parts.join('\n\n'));
}

/** Instruction files discovered after a file touch: one frame per file. */
export function renderNested(files) {
  return files.map(f => reminder(`${t().nested(sanitize(f.path))}\n\n${sanitize(f.content)}`)).join('\n');
}
