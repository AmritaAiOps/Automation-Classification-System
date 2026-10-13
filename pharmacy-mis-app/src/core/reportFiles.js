'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./paths');
const { loadSheet } = require('./sheet');
const { identifySheet } = require('./detect');

/**
 * The three source files, and everything that is the same no matter which tab
 * produced them: what they are called on disk, how a file is checked, and how
 * it is put in the day's folder.
 *
 * Tab 1 (the Puppeteer download) and Tab 2 (a file the operator saved by hand)
 * both end up in storeFile(), so the result is identical and nothing
 * downstream can tell which one made it:
 *
 *   <Input Output Files>\Pharmacy-MIS\<year>\<MM-Month>\inputs\DD-MM-YYYY\<Stem>_DD-MM-YYYY.<ext>
 */

const EXTENSIONS = ['.csv', '.xlsx', '.xlsm'];

/**
 * `stem` is the on-disk name; `portalLabel` is the report's title in the HIS
 * (the scraper navigates by it); `steps` is what Tab 2 shows the operator.
 */
const FILES = [
  {
    key: 'PRQ',
    label: 'Pharmacy PRQ Details',
    portalLabel: 'Pharmacy PRQ Details',
    stem: 'Pharmacy-PRQ-Details',
    feeds: 'Daily Report columns C, D',
    // TODO(HIS steps): replace the generic wording below with the exact clicks for this report.
    steps: [
      'Select "All" in every filter list on the form.',
    ],
  },
  {
    key: 'PO',
    label: 'Purchase Order Detail Report',
    portalLabel: 'Purchase Order Detail Report - Pharmacy',
    stem: 'Purchase-Order-Detail-Report-Pharmacy',
    feeds: 'Daily Report columns E, F, G',
    // TODO(HIS steps): replace the generic wording below with the exact clicks for this report.
    steps: [
      'Select "All" for Creation Status and for Processing Status.',
      'Select "All" in every other filter list.',
    ],
  },
  {
    key: 'GRN',
    label: 'Purchase Report Pharmacy Detail (GRN)',
    portalLabel: 'Purchase Report Pharmacy Detail',
    stem: 'Purchase-Report-Pharmacy-Detail',
    feeds: 'Daily Report columns H, I, J',
    // TODO(HIS steps): replace the generic wording below with the exact clicks for this report.
    steps: [
      'Select "All" for Purchase Tax Scheme first.',
      'Set GRN Type to "All" and GRN Status to "ALL".',
    ],
  },
];

/** Steps every report shares, wrapped around the report's own filter steps. */
function instructionsFor(def) {
  return [
    'Click "Open HIS" and sign in with your Amrita HIS account.',
    // TODO(HIS steps): give the real menu path (e.g. Pharmacy > Reports > ...) if people struggle to find it.
    `Open the report "${def.portalLabel}" from the HIS menu.`,
    'Set both From and To to the report date shown above.',
    ...def.steps,
    'Choose CSV as the export format and run the report.',
    'When the file downloads, click "Select file…" here, or drag it onto this row.',
  ];
}

const byKey = (key) => FILES.find((f) => f.key === key) || null;

function requireDef(key) {
  const def = byKey(key);
  if (!def) throw new Error(`Unknown report "${key}".`);
  return def;
}

/** "Pharmacy-PRQ-Details_08-10-2026" — the name a file has before its extension. */
const baseName = (def, dmy) => `${def.stem}_${dmy}`;

/** Files already in `dir` for this report and day, whatever their extension, newest first. */
function findExisting(dir, def, dmy) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const wanted = baseName(def, dmy).toLowerCase();
  return names
    .filter((n) => EXTENSIONS.includes(path.extname(n).toLowerCase())
      && path.basename(n, path.extname(n)).toLowerCase() === wanted)
    .map((n) => path.join(dir, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/** ensureDir() with a message that says which folder and why, for the operator. Reuses a folder that already exists. */
function ensureFolder(dir, what) {
  try {
    return ensureDir(dir);
  } catch (err) {
    throw new Error(`Could not create ${what} (${dir}): ${err.message}. Check the Input Output Files folder exists and is writable.`);
  }
}

/** rename(), falling back to copy + delete when the file is on another drive (Downloads -> archive). */
function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV' && err.code !== 'EPERM') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/**
 * Put a file in the day's folder as <Stem>_DD-MM-YYYY.<ext>.
 *
 * A file already there for the same report and day (whatever its extension) is
 * never overwritten: it is moved into a "previous" subfolder with a timestamp
 * first. A subfolder rather than beside the new file because the pipeline reads
 * every .csv/.xlsx directly inside the day's folder, and an old copy next to
 * the new one would compete with it. `source` is moved, not copied.
 */
function storeFile(source, destDir, def, dmy) {
  const ext = path.extname(source).toLowerCase() || '.csv';
  const base = baseName(def, dmy);
  const dest = path.join(destDir, `${base}${ext}`);

  ensureFolder(destDir, `the folder for ${dmy}`);
  const old = findExisting(destDir, def, dmy);
  if (old.length) {
    const prevDir = path.join(destDir, 'previous');
    ensureFolder(prevDir, 'the "previous" folder for replaced files');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    for (const file of old) {
      const oldExt = path.extname(file);
      let archived = path.join(prevDir, `${base}_replaced-${stamp}${oldExt}`);
      for (let n = 2; fs.existsSync(archived); n += 1) {
        archived = path.join(prevDir, `${base}_replaced-${stamp}-${n}${oldExt}`);
      }
      try {
        moveFile(file, archived);
      } catch (err) {
        throw new Error(`${path.basename(file)} already exists and could not be set aside (${err.message}). Is it open in another program?`);
      }
    }
  }
  try {
    moveFile(source, dest);
  } catch (err) {
    throw new Error(`Could not save ${path.basename(dest)} into ${destDir}: ${err.message}`);
  }
  return dest;
}

/**
 * Is this file the report it is meant to be? Checks the extension, that it is
 * not empty, that it can be read, that its column headers are this report's
 * (never trusting the filename), and that it has data rows.
 * Resolves { ok: true, rows } or { ok: false, error } with a sentence for a person.
 */
async function validateFile(filePath, key) {
  const def = requireDef(key);
  const fail = (error) => ({ ok: false, error });

  const ext = path.extname(filePath).toLowerCase();
  if (!EXTENSIONS.includes(ext)) {
    return fail(`Wrong file type "${ext || 'none'}" — expected .csv or .xlsx.`);
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch { return fail('The file could not be found.'); }
  if (!stat.isFile()) return fail('That is not a file.');
  if (stat.size === 0) return fail('The file is empty.');

  let sheet;
  try { sheet = await loadSheet(filePath); } catch (err) { return fail(`The file could not be read: ${err.message}`); }

  const found = identifySheet(sheet, null); // by column layout only — the filename is not evidence
  if (found.kind === 'UNKNOWN') {
    return fail(`This does not look like the ${def.label} report — its columns do not match. ${found.reason}`);
  }
  if (found.kind !== key) {
    return fail(`This looks like the ${found.label} report, not the ${def.label} report.`);
  }
  if (!sheet.records.length) return fail('The file has the right columns but no data rows.');
  return { ok: true, rows: sheet.records.length };
}

/**
 * Tab 2: validate a file the operator saved by hand and, only if it passes,
 * move it into the day's folder under the standard name.
 */
async function acceptFile(source, layout, key) {
  const def = requireDef(key);
  const check = await validateFile(source, key);
  if (!check.ok) return check;
  const saved = storeFile(source, layout.dayInputsDir, def, layout.date.dmy);
  return { ok: true, rows: check.rows, path: saved };
}

/** Where each of the three files stands for one day: missing, valid, or present but invalid. */
async function dayStatus(layout) {
  const files = [];
  for (const def of FILES) {
    const [existing] = findExisting(layout.dayInputsDir, def, layout.date.dmy);
    if (!existing) {
      files.push({ key: def.key, state: 'missing', path: null, error: null, rows: 0 });
      continue;
    }
    const check = await validateFile(existing, def.key);
    files.push({
      key: def.key,
      state: check.ok ? 'valid' : 'invalid',
      path: existing,
      error: check.ok ? null : check.error,
      rows: check.ok ? check.rows : 0,
    });
  }
  return files;
}

module.exports = { FILES, EXTENSIONS, byKey, instructionsFor, findExisting, ensureFolder, storeFile, validateFile, acceptFile, dayStatus };
