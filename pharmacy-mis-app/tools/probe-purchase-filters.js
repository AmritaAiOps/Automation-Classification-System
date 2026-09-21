'use strict';

/**
 * Runs Purchase Report Pharmacy Detail several times over one date, changing
 * one filter decision at a time, and reports which combinations return rows.
 *
 *   HIS_USER=... HIS_PASS=... node tools/probe-purchase-filters.js 2026-09-19
 *
 * Why: the run calls that date empty and it is not empty — the same date gives
 * rows when the form is filled in by hand. The form dump turned up two things
 * the run does that a person would not:
 *
 *   1. Grn Type and GrnStatus are plain text inputs (name=GrnType,
 *      name=GrnStatus), not dropdowns. The run writes the literal words "All"
 *      and "ALL" into them. If the servlet matches those against real GRN type
 *      codes, they match nothing, and the run has filtered the report down to
 *      empty with a filter a person never touches.
 *   2. Purchase Tax Scheme is a <select multiple> whose FIRST option has no
 *      label and carries every other option's id joined by commas — it is the
 *      list's own "everything" entry. The run ticks all 52 options, so it sends
 *      that aggregate string AND all 51 ids.
 *
 * Both are guesses until the portal answers. This asks it.
 *
 * Each variant is a real report run, so this downloads real files into a temp
 * folder. It is read-only as far as the portal is concerned.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const scraper = require('../src/scraper/index.js');

const quiet = {
  info: () => {}, warn: () => {}, debug: () => {}, ok: () => {}, error: () => {},
  step: () => () => {},
};
const loud = {
  info: (m) => console.log('  [info]', m),
  warn: (m) => console.log('  [warn]', m),
  debug: () => {},
  ok: (m) => console.log('  [ok]', m),
  error: (m) => console.log('  [error]', m),
  step: (m) => { console.log('  [step]', m); return () => {}; },
};

/** Put a text filter back to blank — what the portal hands over before the run touches it. */
async function clearField(page, label) {
  const handle = await scraper.findFieldByLabel(page, label);
  if (!handle) return 'field not found';
  await handle.evaluate((el) => {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return 'cleared';
}

/** Tick the tax scheme list, optionally skipping its unlabelled "everything" entry. */
async function selectTaxSchemes(page, { includeAggregate }) {
  const handle = await scraper.findFieldByLabel(page, 'Purchase Tax Scheme');
  if (!handle) throw new Error('Purchase Tax Scheme not found');
  return handle.evaluate((el, withAggregate) => {
    let on = 0;
    for (const o of el.options) {
      // The aggregate entry is the one with no label whose value is a list.
      const aggregate = !o.textContent.trim() && o.value.includes(',');
      o.selected = aggregate ? withAggregate : true;
      if (o.selected) on += 1;
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return on;
  }, includeAggregate);
}

const VARIANTS = [
  {
    name: 'as the run does it today',
    note: 'GrnType="All", GrnStatus="ALL", all 52 tax options',
    async apply(page) {
      const t = await scraper.findFieldByLabel(page, 'grn type');
      if (t) await scraper.selectDropdownValue(page, t, 'All').catch(() => {});
      const s = await scraper.findFieldByLabel(page, 'grn status');
      if (s) await scraper.selectDropdownValue(page, s, 'ALL').catch(() => {});
      await selectTaxSchemes(page, { includeAggregate: true });
    },
  },
  {
    name: 'GrnType / GrnStatus left blank',
    note: 'the two text filters untouched, all 52 tax options',
    async apply(page) {
      await clearField(page, 'grn type');
      await clearField(page, 'grn status');
      await selectTaxSchemes(page, { includeAggregate: true });
    },
  },
  {
    name: 'tax schemes without the aggregate entry',
    note: 'GrnType="All", GrnStatus="ALL", 51 real tax options only',
    async apply(page) {
      const t = await scraper.findFieldByLabel(page, 'grn type');
      if (t) await scraper.selectDropdownValue(page, t, 'All').catch(() => {});
      const s = await scraper.findFieldByLabel(page, 'grn status');
      if (s) await scraper.selectDropdownValue(page, s, 'ALL').catch(() => {});
      await selectTaxSchemes(page, { includeAggregate: false });
    },
  },
  {
    name: 'both changes together',
    note: 'filters blank, 51 real tax options only',
    async apply(page) {
      await clearField(page, 'grn type');
      await clearField(page, 'grn status');
      await selectTaxSchemes(page, { includeAggregate: false });
    },
  },
];

async function main() {
  const date = process.argv[2];
  if (!date) { console.error('Usage: node tools/probe-purchase-filters.js yyyy-mm-dd'); process.exit(1); }
  const username = process.env.HIS_USER;
  const password = process.env.HIS_PASS;
  if (!username || !password) { console.error('Set HIS_USER and HIS_PASS.'); process.exit(1); }

  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmis-probe-'));
  const results = [];
  let session;

  try {
    session = await scraper.startSession({ username, password }, loud);
    const { page } = session;

    for (const variant of VARIANTS) {
      console.log(`\n=== ${variant.name} — ${variant.note} ===`);
      let outcome;
      try {
        await scraper.navigateToReport(page, 'Purchase Report Pharmacy Detail', quiet);
        await scraper.setDateRange(page, date, date, quiet);
        await variant.apply(page);
        await scraper.selectReportFormat(page, 'CSV', quiet);

        const file = await scraper.runReportAndWaitForDownload(
          page, { downloadDir, label: 'probe' }, quiet,
        );
        if (!file) {
          outcome = 'EMPTY — the portal raised its "report is empty" alert';
        } else {
          const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).length;
          outcome = `ROWS — ${path.basename(file)}, ${rows} line(s) including the header`;
          fs.rmSync(file, { force: true });
        }
      } catch (err) {
        outcome = err.emptyReport
          ? 'EMPTY — the portal raised its "report is empty" alert'
          : 'ERROR — ' + err.message.split('\n')[0];
      }
      console.log('  => ' + outcome);
      results.push({ variant: variant.name, outcome });
    }
  } catch (err) {
    console.log('FAILED before probing:', err.message);
    if (err.screenshot) console.log('screenshot:', err.screenshot);
  } finally {
    if (session) await scraper.closeSession(session);
    try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch { /* leave it */ }
  }

  console.log(`\n===== ${date} =====`);
  for (const r of results) console.log(`  ${r.outcome.startsWith('ROWS') ? 'ROWS ' : '     '} ${r.variant}\n          ${r.outcome}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
