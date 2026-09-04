'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { templateBuffer } = require('./template');
const { ensureDir } = require('../core/paths');

/**
 * The master report writer.
 *
 * Layout, inherited from the reference workbook and never re-derived:
 *   row 1        title band
 *   row 2        column headers
 *   row 3+       one row per date
 *   column A     S.No, renumbered on every save
 *   column B     Date
 *   columns C-J  the eight mapped figures
 *   columns K-Q  outside this automation - read but never written
 */

const SHEET = 'Daily Report';
const HEADER_ROW = 2;
const FIRST_DATA_ROW = 3;
const LAST_COLUMN = 17; // Q

/** Which spreadsheet column each mapped field lands in. */
const FIELD_COLUMNS = { C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9, J: 10 };

const FIELD_LABELS = {
  C: 'Total no of PRQ',
  D: 'Total no PRQ Itemwise',
  E: 'Total No. of PO Created',
  F: 'Total No Of PO Items',
  G: 'Total PO Value',
  H: 'Total no of GRN',
  I: 'Total no. of GRN Itemwise',
  J: 'Total GRN Value',
};

/** Columns G and J are money; the rest of C-J are counts. */
const MONEY_FIELDS = new Set(['G', 'J']);
const MONEY_FORMAT = '#,##0.00';

/**
 * Open the month's master, creating it from the embedded reference format if
 * this is the month's first run. A newly seeded master keeps the template's
 * title, headers, widths and styling but starts with no data rows.
 */
async function openMaster(masterFile, log) {
  const wb = new ExcelJS.Workbook();

  if (fs.existsSync(masterFile)) {
    await wb.xlsx.readFile(masterFile);
    const ws = wb.getWorksheet(SHEET);
    if (!ws) throw new Error(`"${path.basename(masterFile)}" has no "${SHEET}" sheet - is it the right file?`);
    log.info(`opened existing master: ${path.basename(masterFile)} (${countDataRows(ws)} date row(s) already present)`);
    return { wb, ws, created: false };
  }

  await wb.xlsx.load(templateBuffer());
  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw new Error('Embedded template is missing its "Daily Report" sheet');

  const { cleared, style } = clearDataRows(ws);
  log.info(`new month - created ${path.basename(masterFile)} from the reference format, cleared ${cleared} sample row(s)`);
  return { wb, ws, created: true, seedStyle: style };
}

/**
 * Strip the reference workbook's historical rows. Row 3's cell styling is
 * captured first and handed back, so rows written into a fresh master still
 * look like the reference.
 */
function clearDataRows(ws) {
  const style = captureRowStyle(ws.getRow(FIRST_DATA_ROW));
  const last = lastRowNumber(ws);
  let cleared = 0;
  for (let r = last; r >= FIRST_DATA_ROW; r -= 1) {
    if (rowHasAnyValue(ws.getRow(r))) cleared += 1;
    ws.spliceRows(r, 1);
  }
  return { cleared, style };
}

function captureRowStyle(row) {
  const styles = [];
  for (let c = 1; c <= LAST_COLUMN; c += 1) {
    const st = row.getCell(c).style;
    styles[c] = st ? JSON.parse(JSON.stringify(st)) : null;
  }
  return styles;
}

/**
 * The last row number in use. ExcelJS drops `lastRow` to undefined once every
 * data row has been spliced out (which is exactly what seeding a fresh master
 * does), so this falls back to rowCount and never below the header row.
 */
function lastRowNumber(ws) {
  const last = ws.lastRow;
  if (last && last.number) return last.number;
  return Math.max(ws.rowCount || 0, HEADER_ROW);
}

function rowHasAnyValue(row) {
  for (let c = 1; c <= LAST_COLUMN; c += 1) {
    const v = row.getCell(c).value;
    if (v !== null && v !== undefined && v !== '') return true;
  }
  return false;
}

function countDataRows(ws) {
  let n = 0;
  const last = lastRowNumber(ws);
  for (let r = FIRST_DATA_ROW; r <= last; r += 1) {
    if (rowHasAnyValue(ws.getRow(r))) n += 1;
  }
  return n;
}

/** Normalise whatever sits in a Date cell to YYYY-MM-DD for comparison. */
function cellDateIso(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof value === 'object' && value.result instanceof Date) return cellDateIso(value.result);
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  return null;
}

/**
 * Find the row already holding this date, if any. The reference workbook
 * pre-creates a blank row for the upcoming day (row 78 held 2026-08-08 with no
 * figures), so filling one in must update it rather than append a duplicate.
 */
function findDateRow(ws, iso) {
  const last = lastRowNumber(ws);
  for (let r = FIRST_DATA_ROW; r <= last; r += 1) {
    if (cellDateIso(ws.getRow(r).getCell(2).value) === iso) return r;
  }
  return null;
}

/** First row at or after FIRST_DATA_ROW that holds nothing at all. */
function firstFreeRow(ws) {
  const last = lastRowNumber(ws);
  for (let r = FIRST_DATA_ROW; r <= last; r += 1) {
    if (!rowHasAnyValue(ws.getRow(r))) return r;
  }
  return Math.max(last + 1, FIRST_DATA_ROW);
}

/**
 * Style a row like the sheet's other data rows: copy from a populated sibling
 * row, or from the styling captured off the template before it was cleared.
 */
function applyRowStyle(ws, row, seedStyle) {
  let styles = null;
  const last = lastRowNumber(ws);
  for (let r = FIRST_DATA_ROW; r <= last; r += 1) {
    if (r !== row.number && rowHasAnyValue(ws.getRow(r))) { styles = captureRowStyle(ws.getRow(r)); break; }
  }
  if (!styles) styles = seedStyle;
  if (!styles) return;

  for (let c = 1; c <= LAST_COLUMN; c += 1) {
    if (styles[c]) row.getCell(c).style = JSON.parse(JSON.stringify(styles[c]));
  }
}

/** Renumber column A 1..n over the rows that carry a date. */
function renumber(ws) {
  const last = lastRowNumber(ws);
  let n = 0;
  for (let r = FIRST_DATA_ROW; r <= last; r += 1) {
    const row = ws.getRow(r);
    if (cellDateIso(row.getCell(2).value) == null) continue;
    n += 1;
    row.getCell(1).value = n;
  }
  return n;
}

/**
 * Write one date's figures into the month's master.
 *
 * `fields` is { C..J }; a null value means "the source did not yield this
 * figure", and that cell is left as it was rather than being zeroed.
 * Set `dryRun` to compute the full change list without touching the file.
 */
async function writeDailyRow({ masterFile, date, fields, log, dryRun = false }) {
  const { wb, ws, created, seedStyle } = await openMaster(masterFile, log);

  const existingRow = findDateRow(ws, date.iso);
  const targetRow = existingRow != null ? existingRow : firstFreeRow(ws);
  const mode = existingRow != null ? 'updated' : 'appended';

  if (existingRow != null) log.info(`${date.iso} already has row ${existingRow} - updating it in place`);
  else log.info(`${date.iso} is new - writing it at row ${targetRow}`);

  const row = ws.getRow(targetRow);
  applyRowStyle(ws, row, seedStyle);

  const dateCell = row.getCell(2);
  dateCell.value = date.date;
  if (!dateCell.numFmt) dateCell.numFmt = 'dd-mm-yyyy';

  const changes = [];
  for (const [field, col] of Object.entries(FIELD_COLUMNS)) {
    const cell = row.getCell(col);
    const rawBefore = cell.value;
    const before = rawBefore === null || rawBefore === undefined || rawBefore === '' ? null : rawBefore;
    const next = fields[field];

    if (next == null) {
      changes.push({
        field, column: colLetter(col), label: FIELD_LABELS[field], before, after: before,
        action: 'skipped (no value from source)',
      });
      continue;
    }

    cell.value = next;
    if (MONEY_FIELDS.has(field)) cell.numFmt = MONEY_FORMAT;
    changes.push({
      field, column: colLetter(col), label: FIELD_LABELS[field], before, after: next,
      action: before === null ? 'written' : 'overwritten',
    });
  }

  const total = renumber(ws);
  log.info(`master now holds ${total} date row(s); columns K-Q left untouched`);

  if (dryRun) {
    log.warn('dry run - nothing written to disk');
    return { masterFile, created, mode, row: targetRow, changes, totalRows: total, written: false };
  }

  ensureDir(path.dirname(masterFile));
  await saveAtomically(wb, masterFile);
  log.ok(`saved ${path.basename(masterFile)} - row ${targetRow} ${mode}`);

  return { masterFile, created, mode, row: targetRow, changes, totalRows: total, written: true };
}

/**
 * Write to a sibling temp file and rename over the target, so a crash or a
 * locked file can never leave the month's master half-written.
 */
async function saveAtomically(wb, target) {
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    await wb.xlsx.writeFile(tmp);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
      throw new Error(
        `Could not write "${path.basename(target)}" - it is probably open in Excel. `
        + 'Close the file and run again.',
      );
    }
    throw err;
  }
}

function colLetter(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - r) / 26);
  }
  return s;
}

module.exports = { writeDailyRow, cellDateIso, FIELD_LABELS };
