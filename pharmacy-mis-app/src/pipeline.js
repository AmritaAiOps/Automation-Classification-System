'use strict';

const fs = require('fs');
const path = require('path');
const { Logger } = require('./core/logger');
const { loadSheet } = require('./core/sheet');
const { identifySheet } = require('./core/detect');
const { resolveLayout, dateFromName, parseReportDate, ensureDir } = require('./core/paths');
const { mapPrq } = require('./mapping/prq');
const { mapPo } = require('./mapping/po');
const { mapGrn } = require('./mapping/grn');
const { writeDailyRow, FIELD_LABELS } = require('./excel/master');

/**
 * One day's run, start to finish. Every stage announces itself through the
 * Logger, which is what the window streams live - so the app shows its working
 * rather than just a final number.
 *
 * Stages:
 *   1  resolve   - archive root + report date -> the month's folder layout
 *   2  collect   - gather candidate files (folder scan and/or explicit picks)
 *   3  identify  - classify each file by its column layout, not its name
 *   4  map       - apply the column rules for C-D, E-G, H-J
 *   5  write     - update the month's master report
 */

const SOURCE_EXT = new Set(['.csv', '.xlsx', '.xlsm', '.txt']);

async function runDailyReport(options, sink) {
  const log = new Logger(sink);
  const started = Date.now();

  try {
    const result = await execute(options, log);
    log.ok(`done in ${((Date.now() - started) / 1000).toFixed(2)}s`);
    return { ok: true, ...result, log: log.entries };
  } catch (err) {
    log.error(err && err.message ? err.message : String(err));
    if (err && err.stack) log.debug(err.stack);
    return { ok: false, error: err && err.message ? err.message : String(err), log: log.entries };
  }
}

async function execute(options, log) {
  const { archiveRoot, inputFolder, files = {}, dryRun = false } = options;

  // ---- 1. resolve -------------------------------------------------------
  let closeStep = log.step('Stage 1/5 - Resolve run');

  const reportDate = resolveDate(options, log);
  if (!archiveRoot) throw new Error('No archive root chosen - pick the folder that holds (or should hold) Pharmacy-MIS/');
  const layout = resolveLayout(archiveRoot, reportDate);

  log.info(`report date       ${layout.date.iso} (${layout.date.monthName} ${layout.date.year})`);
  log.info(`month folder      ${layout.monthDir}`);
  log.info(`master report     ${layout.masterFile}`);
  closeStep();

  // ---- 2. collect -------------------------------------------------------
  closeStep = log.step('Stage 2/5 - Collect source files');
  const candidates = collectCandidates({ inputFolder, files, layout }, log);
  if (!candidates.length) {
    throw new Error(
      'No .csv or .xlsx files to read. Pick a dated inputs folder, or select the three files individually.',
    );
  }
  closeStep();

  // ---- 3. identify ------------------------------------------------------
  closeStep = log.step('Stage 3/5 - Identify files by column layout');
  const identified = await identifyAll(candidates, log);
  closeStep();

  const missing = ['PRQ', 'PO', 'GRN'].filter((k) => !identified.byKind[k]);
  if (missing.length === 3) {
    throw new Error('None of the files matched a known report layout - see the identification log above.');
  }
  if (missing.length) {
    log.warn(
      `no file supplied for: ${missing.join(', ')}. `
      + `Columns ${missing.map((k) => COLUMNS_FOR[k]).join(' and ')} will be left as they are in the master.`,
    );
  }

  // ---- 4. map -----------------------------------------------------------
  closeStep = log.step('Stage 4/5 - Apply column mapping rules');
  const fields = { C: null, D: null, E: null, F: null, G: null, H: null, I: null, J: null };
  const audit = {};

  if (identified.byKind.PRQ) {
    const close = log.step(`PRQ section -> columns C, D  [${path.basename(identified.byKind.PRQ.file)}]`);
    const r = mapPrq(identified.byKind.PRQ.sheet, log);
    Object.assign(fields, { C: r.C, D: r.D });
    audit.PRQ = r.audit;
    close();
  }
  if (identified.byKind.PO) {
    const close = log.step(`PO section -> columns E, F, G  [${path.basename(identified.byKind.PO.file)}]`);
    const r = mapPo(identified.byKind.PO.sheet, log);
    Object.assign(fields, { E: r.E, F: r.F, G: r.G });
    audit.PO = r.audit;
    close();
  }
  if (identified.byKind.GRN) {
    const close = log.step(`GRN section -> columns H, I, J  [${path.basename(identified.byKind.GRN.file)}]`);
    const r = mapGrn(identified.byKind.GRN.sheet, log);
    Object.assign(fields, { H: r.H, I: r.I, J: r.J });
    audit.GRN = r.audit;
    close();
  }
  closeStep();

  // ---- 5. write ---------------------------------------------------------
  closeStep = log.step(`Stage 5/5 - ${dryRun ? 'Preview' : 'Update'} master report`);
  ensureDir(layout.outputsDir);
  const write = await writeDailyRow({ masterFile: layout.masterFile, date: layout.date, fields, log, dryRun });
  closeStep();

  return {
    date: layout.date.iso,
    layout: {
      archiveRoot: layout.root,
      monthDir: layout.monthDir,
      outputsDir: layout.outputsDir,
      masterFile: layout.masterFile,
    },
    fields,
    labels: FIELD_LABELS,
    sources: identified.summary,
    unidentified: identified.unidentified,
    audit,
    write,
    dryRun,
  };
}

const COLUMNS_FOR = { PRQ: 'C-D', PO: 'E-G', GRN: 'H-J' };

/**
 * The report date, in order of preference: what the user typed, then the date
 * embedded in the inputs folder name, then the date on the source filenames.
 * Nothing falls back to "today" silently - a wrong date writes the wrong row.
 */
/**
 * What the source files themselves look like they are for — the inputs folder's
 * name, the names of the files picked by hand, and the names of the files
 * inside the folder being scanned.
 *
 * Every date found, not just the first: a folder holding a mix of days is worth
 * saying out loud rather than silently taking whichever came back first.
 */
function inferDateFromNames(options) {
  const found = [];
  const note = (iso, source) => { if (iso) found.push({ iso, source }); };

  if (options.inputFolder) {
    note(dateFromName(options.inputFolder), `the inputs folder name "${path.basename(options.inputFolder)}"`);
  }
  for (const p of Object.values(options.files || {})) {
    if (p) note(dateFromName(p), `the filename "${path.basename(p)}"`);
  }
  // The files inside a scanned folder count too. Without this, the commonest
  // case of all — a folder of files named after the day they cover, picked
  // whole — has nothing to compare the date field against.
  if (options.inputFolder && fs.existsSync(options.inputFolder)) {
    try {
      for (const name of fs.readdirSync(options.inputFolder)) {
        if (!SOURCE_EXT.has(path.extname(name).toLowerCase())) continue;
        note(dateFromName(name), `the filename "${name}"`);
      }
    } catch { /* unreadable folder is collectCandidates' problem to report */ }
  }

  if (!found.length) return null;
  const distinct = [...new Set(found.map((f) => f.iso))];
  return { ...found[0], distinct };
}

function resolveDate(options, log) {
  const inferred = inferDateFromNames(options);

  if (options.reportDate) {
    const d = parseReportDate(options.reportDate);
    log.info(`date taken from the date field: ${d.iso}`);

    // The Date field wins, deliberately — filing a day's data under another
    // date is sometimes what is wanted. But it is pre-filled with yesterday and
    // remembered between runs, so it can just as easily be a date nobody chose,
    // and the row it writes looks exactly like a right one. Hence saying so.
    if (inferred && !inferred.distinct.includes(d.iso)) {
      const other = inferred.distinct.length > 1
        ? `the source files look like ${inferred.distinct.join(', ')}`
        : `${inferred.source} says ${inferred.iso}`;
      log.warn(
        `the Date field says ${d.iso}, but ${other}. This run is being filed under ${d.iso}. `
        + 'If that is not what you meant, change the Date field and run again.',
      );
    } else if (inferred && inferred.distinct.length > 1) {
      log.warn(
        `the source files are not all for the same day (${inferred.distinct.join(', ')}). `
        + `This run is being filed under ${d.iso}.`,
      );
    }
    return d.iso;
  }

  if (inferred) {
    if (inferred.distinct.length > 1) {
      throw new Error(
        `The source files are for more than one day (${inferred.distinct.join(', ')}), so the report `
        + 'date cannot be worked out from them. Enter the date you want in the Date field.',
      );
    }
    log.info(`date taken from ${inferred.source}: ${inferred.iso}`);
    return inferred.iso;
  }

  throw new Error(
    'Could not work out the report date. Either enter it in the Date field, or name the '
    + 'inputs folder after it (e.g. inputs/2026-08-08).',
  );
}

/**
 * Build the candidate list. Folder mode and manual picks both feed the same
 * list, so a run can mix them: scan the folder, then override one file by hand.
 * Explicit picks come last and win on duplicate paths.
 */
function collectCandidates({ inputFolder, files, layout }, log) {
  const seen = new Map();

  const folder = inputFolder || (fs.existsSync(layout.dayInputsDir) ? layout.dayInputsDir : null);
  if (folder) {
    if (!fs.existsSync(folder)) throw new Error(`Inputs folder does not exist: ${folder}`);
    const entries = fs.readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isFile() && SOURCE_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(folder, e.name));
    log.info(`scanned ${folder}`);
    log.info(`found ${entries.length} candidate file(s): ${entries.map((f) => path.basename(f)).join(', ') || '(none)'}`);
    for (const f of entries) seen.set(path.resolve(f).toLowerCase(), { file: f, origin: 'folder scan' });
  } else if (!Object.keys(files).length) {
    log.warn(`no inputs folder given and none at the conventional path ${layout.dayInputsDir}`);
  }

  for (const [slot, file] of Object.entries(files)) {
    if (!file) continue;
    if (!fs.existsSync(file)) throw new Error(`Selected file does not exist: ${file}`);
    seen.set(path.resolve(file).toLowerCase(), { file, origin: `picked as ${slot}`, slot });
    log.info(`manual pick (${slot}): ${path.basename(file)}`);
  }

  return [...seen.values()];
}

/**
 * Classify every candidate. Where two files claim the same kind, the
 * higher-scoring match wins and the other is reported rather than dropped
 * silently - a duplicated export is a real thing that happens.
 */
async function identifyAll(candidates, log) {
  const byKind = {};
  const summary = [];
  const unidentified = [];

  for (const cand of candidates) {
    const name = path.basename(cand.file);
    let sheet;
    try {
      sheet = await loadSheet(cand.file);
    } catch (err) {
      log.warn(`${name} - could not read: ${err.message}`);
      unidentified.push({ file: cand.file, reason: err.message });
      continue;
    }

    const id = identifySheet(sheet, cand.file);
    const where = `row ${sheet.headerRowIndex + 1} header, ${sheet.records.length} row(s)`;

    if (id.kind === 'UNKNOWN') {
      log.warn(`${name} - not a source report, skipping (${where})`);
      log.debug(`  ${id.reason}`);
      unidentified.push({ file: cand.file, reason: id.reason });
      continue;
    }

    const entry = { kind: id.kind, file: cand.file, sheet, id, origin: cand.origin };
    const prev = byKind[id.kind];

    if (prev && prev.id.score >= id.score) {
      log.warn(`${name} - also looks like ${id.kind}, but ${path.basename(prev.file)} matched better; ignoring this one`);
      unidentified.push({ file: cand.file, reason: `duplicate ${id.kind} file, weaker match` });
      continue;
    }
    if (prev) {
      log.warn(`${name} - a better ${id.kind} match than ${path.basename(prev.file)}; using this one instead`);
      unidentified.push({ file: prev.file, reason: `superseded as ${id.kind} by ${name}` });
      summary.splice(summary.findIndex((s) => s.file === prev.file), 1);
    }

    byKind[id.kind] = entry;
    summary.push({
      kind: id.kind,
      label: id.label,
      feeds: id.feeds,
      file: cand.file,
      name,
      format: sheet.format,
      rows: sheet.records.length,
      confidence: id.confidence,
      reason: id.reason,
      origin: cand.origin,
    });

    log.ok(`${name} -> ${id.kind} (${id.label}), ${id.confidence} confidence`);
    log.debug(`  ${id.reason}`);
    log.debug(`  ${where}, feeds ${id.feeds}`);
  }

  return { byKind, summary, unidentified };
}

module.exports = { runDailyReport };
