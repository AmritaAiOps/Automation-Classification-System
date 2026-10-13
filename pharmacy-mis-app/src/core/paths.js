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
 *           │   └── 08-08-2026/   <- the three raw files, exactly as pulled (DD-MM-YYYY)
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
    // DD-MM-YYYY: how the day's folder and downloaded files are named on disk.
    dmy: `${dd}-${mm}-${year}`,
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
    dayInputsDir: path.join(inputsDir, d.dmy),
    outputsDir: path.join(monthDir, 'outputs'),
    masterFile: path.join(monthDir, 'outputs', `Master_Report_${d.monthName}_${d.year}.xlsx`),
  };
}

/**
 * The single source of truth for "which day are we processing".
 *
 * The person running this app opens it TODAY to process YESTERDAY's reports,
 * so the default report date is always the previous CALENDAR day — not
 * "24 hours ago", which would drift across a DST change, and not naive
 * day-number arithmetic, which breaks on the 1st of every month. Built on the
 * same Date.UTC parts used by fromParts()/parseReportDate() above, so this and
 * every other date in the app agree on what a "day" is.
 *
 * Every caller — the UI, the Amrita HIS date fields, the inputs folder, the
 * pipeline, the logs — must derive the report date from this one function
 * (or be handed the value it already produced) rather than computing
 * "yesterday" independently.
 */
function getPreviousCalendarDay(reference = new Date()) {
  return fromDate(new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - 1));
}

/** Today, in the same shape as parseReportDate()/getPreviousCalendarDay(). */
function getToday(reference = new Date()) {
  return fromDate(reference);
}

/**
 * The Amrita HIS portal's own date format, DD/MM/YYYY — e.g. "08/09/2026".
 * Accepts anything parseReportDate() accepts (an ISO string, the portal's own
 * DD-MM-YYYY, or a Date), so it can be handed the reportDate computed once at
 * the top of a run.
 */
function formatPortalDate(input) {
  const d = parseReportDate(input);
  return `${String(d.day).padStart(2, '0')}/${String(d.month).padStart(2, '0')}/${d.year}`;
}

/**
 * Pull a date out of a folder or file name, if one is there, as YYYY-MM-DD.
 * Understands the app's own DD-MM-YYYY names (e.g. "08-08-2026",
 * "Pharmacy-PRQ-Details_08-08-2026.csv") as well as YYYY-MM-DD / YYYYMMDD.
 */
function dateFromName(name) {
  const base = path.basename(String(name || ''));
  const iso = /(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})/.exec(base);
  if (iso) {
    try { return parseReportDate(`${iso[1]}-${iso[2]}-${iso[3]}`).iso; } catch { /* try the next form */ }
  }
  const dmy = /(?<!\d)(\d{2})[-_.](\d{2})[-_.](\d{4})(?!\d)/.exec(base);
  if (dmy) {
    try { return parseReportDate(`${dmy[3]}-${dmy[2]}-${dmy[1]}`).iso; } catch { /* not a date */ }
  }
  return null;
}

/**
 * Every calendar day from `from` to `to` inclusive, as parseReportDate() objects.
 * `to` defaults to `from`. Capped so a mistyped year cannot start a months-long run.
 */
function dateRange(from, to, maxDays = 31) {
  const a = parseReportDate(from);
  const b = parseReportDate(to || from);
  if (b.date < a.date) throw new Error('The "To" date is before the "From" date.');
  const days = [];
  for (let t = a.date.getTime(); t <= b.date.getTime(); t += 86400000) {
    days.push(fromDate(new Date(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate())));
    if (days.length > maxDays) throw new Error(`Please pick at most ${maxDays} days at a time.`);
  }
  return days;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  resolveLayout,
  parseReportDate,
  dateRange,
  dateFromName,
  ensureDir,
  getPreviousCalendarDay,
  getToday,
  formatPortalDate,
};
