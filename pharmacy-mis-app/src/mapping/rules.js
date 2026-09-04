'use strict';

/**
 * The shared predicates and helpers behind the column rules. Each one is small
 * and named after the rule it encodes, so the mapping modules read like the
 * field-mapping document.
 */

/** Trim, collapse inner whitespace runs, and drop the surrounding quotes Excel adds. */
function clean(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * Rule shared by the PRQ and PO sections: a PRQ number beginning "AUTO" is
 * system-generated (e.g. "AUTO/P/26/540", raised when a PO is closed short) and
 * is dropped. Compared case-insensitively and after trimming.
 */
function isAutoPrq(prqNo) {
  return /^auto/i.test(clean(prqNo));
}

/**
 * Column E rule: a PO number ending in a letter suffix is a split or amended
 * PO ("SE/PH/2026-27/3910-A") and is not a new PO, so it is excluded. A plain
 * number ("SE/PH/2026-27/3919") is counted.
 *
 * Matches a trailing separator + letters, or a bare trailing letter after a
 * digit, so "3910-A", "3910/A", "3910 A" and "3910A" are all treated as
 * suffixed while "2026-27/3919" is not.
 */
function hasLetterSuffix(poNo) {
  const s = clean(poNo);
  if (!s) return false;
  return /[-_/\s]+[A-Za-z]+$/.test(s) || /\d[A-Za-z]+$/.test(s);
}

/**
 * Parse an amount as it appears in these exports: Indian grouping, quoted, and
 * sometimes a lone "-" standing for zero. `" 26,37,499.06 "` → 2637499.06.
 * Returns null when there is no number to read.
 */
function parseAmount(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = clean(value);
  if (!s || s === '-') return null;
  let negative = false;
  if (/^\((.*)\)$/.test(s)) { negative = true; s = s.replace(/^\((.*)\)$/, '$1'); }
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  s = s.replace(/[^\d.]/g, '');
  if (!s || s === '.') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * Count distinct cleaned values of `field` across `records`, ignoring blanks.
 * Returns the count plus the sorted value list, so the UI can show exactly
 * which PRQs / POs / drugs were counted rather than just a number.
 */
function countDistinct(records, field) {
  const seen = new Map(); // normalised key -> first-seen display value
  for (const rec of records) {
    const raw = clean(rec[field]);
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (!seen.has(key)) seen.set(key, raw);
  }
  const values = [...seen.values()].sort((a, b) => a.localeCompare(b, 'en'));
  return { count: seen.size, values };
}

/**
 * Locate the totals row: the "Grand Total" figure sits on a trailer row at the
 * bottom of the sheet where the identifying columns (S.No., PO No. …) are blank
 * but the amount columns are filled. Searched from the bottom up so a blank
 * spacer row below it does not matter.
 *
 * `idFields` are the columns that must be EMPTY on a totals row.
 */
function findTotalsRow(records, idFields, amountField) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i];
    const idsBlank = idFields.every((f) => clean(rec[f]) === '');
    if (!idsBlank) continue;
    const amount = parseAmount(rec[amountField]);
    if (amount != null) return { record: rec, amount, row: rec.__row };
  }
  return null;
}

/** Data rows are every record that is not the totals trailer. */
function dataRows(records, idFields) {
  return records.filter((rec) => idFields.some((f) => clean(rec[f]) !== ''));
}

module.exports = {
  clean,
  isAutoPrq,
  hasLetterSuffix,
  parseAmount,
  countDistinct,
  findTotalsRow,
  dataRows,
};
