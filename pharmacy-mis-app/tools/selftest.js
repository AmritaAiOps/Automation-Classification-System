'use strict';

/**
 * End-to-end check against the real reference files in ../reference.
 *
 * Covers: the rule predicates, format identification, the eight column
 * figures, the folder layout, and a real write + re-read of a master report
 * (including the append-then-update path). Run with: npm test
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

const REFERENCE = path.join(__dirname, '..', '..', 'reference');
const rules = require('../src/mapping/rules');
const { loadSheet } = require('../src/core/sheet');
const { identifySheet } = require('../src/core/detect');
const { resolveLayout, parseReportDate, dateFromName } = require('../src/core/paths');
const { runDailyReport } = require('../src/pipeline');
const { cellDateIso } = require('../src/excel/master');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`); }
}

function truthy(name, value, note = '') {
  if (value) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name} ${note}`); }
}

function section(title) { console.log(`\n${title}`); }

async function main() {
  if (!fs.existsSync(REFERENCE)) {
    console.error(`Reference folder not found at ${REFERENCE}`);
    process.exit(1);
  }

  section('Rule predicates');
  check('AUTO PRQ excluded', rules.isAutoPrq('AUTO/P/26/540'), true);
  check('AUTO match is case-insensitive', rules.isAutoPrq('auto/p/26/540'), true);
  check('normal PRQ kept', rules.isAutoPrq('P/AMPU/26/3864'), false);
  check('blank PRQ is not AUTO', rules.isAutoPrq(''), false);
  check('hyphen letter suffix detected', rules.hasLetterSuffix('SE/PH/2026-27/3910-A'), true);
  check('bare letter suffix detected', rules.hasLetterSuffix('SE/PH/2026-27/3910A'), true);
  check('plain PO not suffixed', rules.hasLetterSuffix('SE/PH/2026-27/3919'), false);
  check('year range not read as suffix', rules.hasLetterSuffix('SE/PH/2026-27/3919'), false);
  check('indian grouping parsed', rules.parseAmount(' 26,37,499.06 '), 2637499.06);
  check('dash means no value', rules.parseAmount(' -   '), null);
  check('native number passes through', rules.parseAmount(1674801.3), 1674801.3);
  check('parenthesised negative', rules.parseAmount('(1,200.50)'), -1200.5);

  section('Date and layout handling');
  check('ISO date', parseReportDate('2026-08-08').iso, '2026-08-08');
  check('portal DD-MM-YYYY date', parseReportDate('08-08-2026').iso, '2026-08-08');
  check('month folder name', parseReportDate('2026-08-08').monthFolder, '08-August');
  check('date lifted from folder name', dateFromName('inputs/2026-08-08'), '2026-08-08');
  check('non-date name yields null', dateFromName('report.csv'), null);
  const layout = resolveLayout(path.join('C', 'Archive'), '2026-08-08');
  check(
    'master filename follows the convention',
    path.basename(layout.masterFile),
    'Master_Report_August_2026.xlsx',
  );
  check('inputs day folder', path.basename(layout.dayInputsDir), '2026-08-08');
  let threw = false;
  try { parseReportDate('2026-02-30'); } catch { threw = true; }
  truthy('impossible date rejected', threw);

  section('Format identification (content, not filename)');
  const expectKind = {
    'Pharmacy PRQ Details(1).CSV': 'PRQ',
    'Purchase Order Detail Report - Pharmacy.xlsx': 'PO',
    'Purchase Report Pharmacy Detail (1).CSV': 'GRN',
    'Daily Report for coding.xlsx': 'UNKNOWN',
  };
  for (const [name, kind] of Object.entries(expectKind)) {
    const file = path.join(REFERENCE, name);
    if (!fs.existsSync(file)) { console.log(`  SKIP  ${name} (not present)`); continue; }
    const sheet = await loadSheet(file);
    check(`${name} -> ${kind}`, identifySheet(sheet, file).kind, kind);
  }

  // Identification must survive renaming, since the portal and the Puppeteer
  // half both name their downloads differently.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmis-'));
  const renamed = [
    ['Pharmacy PRQ Details(1).CSV', 'export_a.csv', 'PRQ'],
    ['Purchase Order Detail Report - Pharmacy.xlsx', 'export_b.xlsx', 'PO'],
    ['Purchase Report Pharmacy Detail (1).CSV', 'export_c.csv', 'GRN'],
  ];
  for (const [src, dst, kind] of renamed) {
    const to = path.join(scratch, dst);
    fs.copyFileSync(path.join(REFERENCE, src), to);
    const sheet = await loadSheet(to);
    check(`renamed ${dst} still identified as ${kind}`, identifySheet(sheet, to).kind, kind);
  }

  section('End-to-end run against the reference files');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmis-run-'));
  const run = await runDailyReport({
    archiveRoot: root,
    inputFolder: scratch,
    reportDate: '2026-08-08',
  });

  truthy('run succeeded', run.ok, run.error || '');
  check('C - Total no. of PRQ', run.fields.C, 21);
  check('D - PRQ Itemwise', run.fields.D, 29);
  check('E - PO Created', run.fields.E, 26);
  check('F - PO Items', run.fields.F, 31);
  check('G - Total PO Value', run.fields.G, 1674801.3);
  check('H - Total no. of GRN', run.fields.H, 80);
  // H counts distinct PO numbers, not distinct GRN numbers - see the note at
  // the top of src/mapping/grn.js. Both are pinned so the difference between
  // them cannot be closed by accident.
  check('H counts POs received against, not GRN numbers', run.audit.GRN.poNumbers.length, 80);
  check('the same day has 83 distinct GRN numbers', run.audit.GRN.grnNumbers.length, 83);
  check('I - GRN Itemwise', run.fields.I, 169);
  check('J - Total GRN Value', run.fields.J, 2656763.31);
  check('all three sources identified', run.sources.length, 3);
  check('master was created fresh', run.write.created, true);
  check('row appended, not updated', run.write.mode, 'appended');
  check('written at first data row', run.write.row, 3);

  section('Master report written to disk');
  truthy('master file exists', fs.existsSync(run.layout.masterFile), run.layout.masterFile);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(run.layout.masterFile);
  const ws = wb.getWorksheet('Daily Report');
  truthy('Daily Report sheet present', !!ws);
  check('title band preserved', ws.getCell('A1').value, 'Daily Purchase & Inventory MIS Report');
  check('header preserved', ws.getCell('C2').value, 'Total no of PRQ');
  check('column widths preserved', Math.round(ws.getColumn(3).width), 15);
  check('S.No written', ws.getCell('A3').value, 1);
  check('date written', cellDateIso(ws.getCell('B3').value), '2026-08-08');
  check('C3', ws.getCell('C3').value, 21);
  check('J3', ws.getCell('J3').value, 2656763.31);
  check('money format on G', ws.getCell('G3').numFmt, '#,##0.00');
  truthy('data row keeps borders from the reference', !!(ws.getCell('C3').border || {}).bottom);
  check('Monthly Summary sheet kept', !!wb.getWorksheet('Monthly Summary'), true);
  check('only one data row in a fresh master', run.write.totalRows, 1);

  section('Re-running the same date updates in place');
  const rerun = await runDailyReport({
    archiveRoot: root,
    inputFolder: scratch,
    reportDate: '2026-08-08',
  });
  truthy('re-run succeeded', rerun.ok, rerun.error || '');
  check('recognised as an update', rerun.write.mode, 'updated');
  check('same row reused', rerun.write.row, 3);
  check('no duplicate row added', rerun.write.totalRows, 1);
  check('values reported as overwritten', rerun.write.changes[0].action, 'overwritten');

  section('A second date appends');
  const next = await runDailyReport({
    archiveRoot: root,
    inputFolder: scratch,
    reportDate: '2026-08-09',
  });
  truthy('second date succeeded', next.ok, next.error || '');
  check('appended', next.write.mode, 'appended');
  check('two date rows now', next.write.totalRows, 2);
  check('same master file', next.layout.masterFile, run.layout.masterFile);

  section('A new month starts a new master at row 1');
  const newMonth = await runDailyReport({
    archiveRoot: root,
    inputFolder: scratch,
    reportDate: '2026-09-01',
  });
  truthy('new month succeeded', newMonth.ok, newMonth.error || '');
  check('new master created', newMonth.write.created, true);
  check('starts at row 3 (first data row)', newMonth.write.row, 3);
  check(
    'separate September file',
    path.basename(newMonth.layout.masterFile),
    'Master_Report_September_2026.xlsx',
  );

  section('Dry run leaves the file alone');
  const before = fs.statSync(run.layout.masterFile).mtimeMs;
  const dry = await runDailyReport({
    archiveRoot: root, inputFolder: scratch, reportDate: '2026-08-10', dryRun: true,
  });
  truthy('dry run succeeded', dry.ok, dry.error || '');
  check('nothing written', dry.write.written, false);
  check('file untouched', fs.statSync(run.layout.masterFile).mtimeMs, before);

  section('Error handling');
  const missing = await runDailyReport({ archiveRoot: root, inputFolder: path.join(root, 'nope'), reportDate: '2026-08-08' });
  check('missing folder reported, not crashed', missing.ok, false);
  truthy('error message names the folder', /does not exist/i.test(missing.error), missing.error);

  const noDate = await runDailyReport({ archiveRoot: root, inputFolder: scratch });
  check('undated run refused', noDate.ok, false);
  truthy('error explains how to fix it', /report date/i.test(noDate.error), noDate.error);

  const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmis-partial-'));
  fs.copyFileSync(path.join(REFERENCE, 'Pharmacy PRQ Details(1).CSV'), path.join(partial, 'only_prq.csv'));
  const onlyPrq = await runDailyReport({ archiveRoot: root, inputFolder: partial, reportDate: '2026-08-11' });
  truthy('run with only one source still succeeds', onlyPrq.ok, onlyPrq.error || '');
  check('C still computed', onlyPrq.fields.C, 21);
  check('E left null when no PO file', onlyPrq.fields.E, null);
  check('E reported as skipped', onlyPrq.write.changes.find((c) => c.field === 'E').action, 'skipped (no value from source)');

  console.log(`\n${'='.repeat(56)}`);
  console.log(`${pass} passed, ${fail} failed`);
  console.log(`temp artifacts under ${os.tmpdir()} (pharmis-*)`);
  console.log('='.repeat(56));
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\nself-test crashed:\n', err);
  process.exit(1);
});
