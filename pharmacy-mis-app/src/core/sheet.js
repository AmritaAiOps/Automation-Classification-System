'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { parseCsv, headerKey } = require('./csv');

/**
 * A "sheet" is the common shape every source file is reduced to before any
 * mapping rule looks at it, whether it arrived as CSV or XLSX:
 *
 *   { rows, header, records, headerRowIndex, sheetName, kindHint }
 *
 * rows    – raw cell values, row-major, strings for CSV / native for XLSX
 * header  – normalised header keys (see headerKey)
 * records – one object per data row, keyed by header, with __row / __raw
 */

/** Read an XLSX file's first (or named) worksheet into row arrays. */
async function readWorkbookRows(filePath, sheetName) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) throw new Error(`No worksheet ${sheetName ? `"${sheetName}" ` : ''}in ${path.basename(filePath)}`);

  const rows = [];
  const width = ws.columnCount;
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const arr = [];
    for (let c = 1; c <= width; c += 1) {
      arr[c - 1] = cellValue(row.getCell(c));
    }
    rows[rowNumber - 1] = arr;
  });
  for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];
  return { rows, sheetName: ws.name };
}

/** Unwrap the value shapes ExcelJS hands back (formula results, rich text). */
function cellValue(cell) {
  const v = cell == null ? null : cell.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v;
    if ('result' in v) return v.result == null ? '' : v.result;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
    if ('error' in v) return '';
  }
  return v;
}

/**
 * Find the header row. These exports sometimes carry a title line above the
 * header (the master report does), so rather than assume row 1 we take the
 * first row in the first few that looks like a header: several non-empty text
 * cells, none of them numeric.
 */
function findHeaderRowIndex(rows, lookahead = 10) {
  let best = -1;
  let bestScore = 0;
  const limit = Math.min(rows.length, lookahead);
  for (let r = 0; r < limit; r += 1) {
    const cells = (rows[r] || []).filter((c) => c !== '' && c != null);
    if (cells.length < 3) continue;
    const textual = cells.filter((c) => typeof c === 'string' && !/^-?[\d,.\s]+$/.test(c)).length;
    const score = textual;
    if (textual >= 3 && score > bestScore) { bestScore = score; best = r; }
  }
  return best === -1 ? 0 : best;
}

function buildSheet(rows, extra = {}) {
  const headerRowIndex = extra.headerRowIndex != null ? extra.headerRowIndex : findHeaderRowIndex(rows);
  const header = (rows[headerRowIndex] || []).map(headerKey);
  // Values are copied across as-is so that XLSX native types (numbers,
  // dates) reach the mapping rules untouched.
  const records = [];
  for (let r = headerRowIndex + 1; r < rows.length; r += 1) {
    const raw = rows[r] || [];
    const rec = { __row: r + 1, __raw: raw };
    for (let c = 0; c < header.length; c += 1) {
      if (!header[c]) continue;
      rec[header[c]] = raw[c] === undefined ? '' : raw[c];
    }
    records.push(rec);
  }
  return { rows, header, records, headerRowIndex, ...extra };
}

/** Load any supported source file into the common sheet shape. */
async function loadSheet(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv' || ext === '.txt') {
    const text = fs.readFileSync(filePath, 'utf8');
    const rows = parseCsv(text);
    return buildSheet(rows, { source: filePath, format: 'csv' });
  }
  if (ext === '.xlsx' || ext === '.xlsm') {
    const { rows, sheetName } = await readWorkbookRows(filePath);
    return buildSheet(rows, { source: filePath, format: 'xlsx', sheetName });
  }
  throw new Error(`Unsupported file type "${ext}" — expected .csv or .xlsx (${path.basename(filePath)})`);
}

module.exports = { loadSheet };
