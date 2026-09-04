'use strict';

/**
 * RFC-4180 CSV reader. The pharmacy exports quote any header that wraps onto a
 * second line ("Created\nDate") and quote every thousands-separated amount
 * (" 3,629.00 "), so embedded newlines and commas inside quotes both have to
 * survive parsing intact.
 */

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Parse CSV text into an array of row arrays. */
function parseCsv(text) {
  const src = stripBom(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let sawAnyChar = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { inQuotes = true; sawAnyChar = true; continue; }
    if (ch === ',') { row.push(field); field = ''; sawAnyChar = true; continue; }
    if (ch === '\r') { continue; }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawAnyChar = false;
      continue;
    }
    field += ch;
    sawAnyChar = true;
  }

  if (sawAnyChar || field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Collapse a header cell to a comparable key: newlines and runs of whitespace
 * become single spaces, periods are dropped, case is folded. This is what lets
 * the same field be found across files that spell it differently — the PO
 * sheet's "PO. No." and the GRN export's "PO\nNo." both key to "po no".
 */
function headerKey(cell) {
  return String(cell == null ? '' : cell)
    .replace(/\s+/g, ' ')
    .replace(/\./g, '')
    .trim()
    .toLowerCase();
}

module.exports = { parseCsv, headerKey };
