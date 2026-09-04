'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The folder convention from the field-mapping document:
 *
 *   Pharmacy-MIS/
 *   └── 2026/
 *       └── 08-August/
 *           ├── inputs/
 *           │   └── 2026-08-08/   <- the three raw files, exactly as pulled
 *           └── outputs/
 *               └── Master_Report_August_2026.xlsx
 *
 * inputs/ is never written to after the pull; outputs/ sits beside it inside
 * the same month folder. Each month gets a fresh master starting at row 1.
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Parse "YYYY-MM-DD" (also accepts DD-MM-YYYY and Date objects) into parts. */
function parseReportDate(input) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) return fromDate(input);
  const s = String(input || '').trim();

  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return fromParts(+m[1], +m[2], +m[3]);

  // The portal's own exports date things DD-MM-YYYY, so accept that too.
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return fromParts(+m[3], +m[2], +m[1]);

  throw new Error(`Unrecognised date "${input}" — expected YYYY-MM-DD`);
}

function fromDate(d) {
  return fromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function fromParts(year, month, day) {
  if (month < 1 || month > 12) throw new Error(`Month out of range in date: ${year}-${month}-${day}`);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDate() !== day) throw new Error(`No such date: ${year}-${String(month).padStart(2, '0')}-${day}`);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return {
    year,
    month,
    day,
    date,
    iso: `${year}-${mm}-${dd}`,
    monthName: MONTH_NAMES[month - 1],
    monthFolder: `${mm}-${MONTH_NAMES[month - 1]}`,
  };
}

/** Every path the run touches, derived from the archive root and the date. */
function resolveLayout(root, dateInput) {
  const d = parseReportDate(dateInput);
  const monthDir = path.join(root, 'Pharmacy-MIS', String(d.year), d.monthFolder);
  const inputsDir = path.join(monthDir, 'inputs');
  return {
    date: d,
    root,
    monthDir,
    inputsDir,
    dayInputsDir: path.join(inputsDir, d.iso),
    outputsDir: path.join(monthDir, 'outputs'),
    masterFile: path.join(monthDir, 'outputs', `Master_Report_${d.monthName}_${d.year}.xlsx`),
  };
}

/** Pull a YYYY-MM-DD out of a folder or file name, if one is there. */
function dateFromName(name) {
  const m = /(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})/.exec(path.basename(String(name || '')));
  if (!m) return null;
  try {
    return parseReportDate(`${m[1]}-${m[2]}-${m[3]}`).iso;
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { resolveLayout, parseReportDate, dateFromName, ensureDir, MONTH_NAMES };
