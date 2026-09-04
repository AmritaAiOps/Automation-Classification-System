'use strict';

/**
 * Part 1 of the project: the Puppeteer pull.
 *
 * WHY THIS IS A STUB
 * ------------------
 * The pharmacy portal is reachable only from the admin machine, so this half
 * cannot be developed or run on a personal computer. What is real here is the
 * INTERFACE and the wiring: the app already calls fetchDailyInputs() at the
 * front of a run, streams its log lines into the same window as everything
 * else, and drops the downloaded files exactly where the mapping half expects
 * to find them. On the admin machine only the body of pullFromPortal() has to
 * be filled in - nothing above or around it changes.
 *
 * The contract it must honour:
 *
 *   fetchDailyInputs({ layout, credentials, log }) -> {
 *     files: string[],     absolute paths of everything downloaded
 *     date:  'YYYY-MM-DD', the date the pull covers
 *   }
 *
 * Files must land in layout.dayInputsDir (Pharmacy-MIS/<yyyy>/<mm-Month>/
 * inputs/<yyyy-mm-dd>/). The mapping half then identifies them by their column
 * layout, so the download filenames do not matter.
 */

const fs = require('fs');
const { ensureDir } = require('../core/paths');

/** Reports whether the Puppeteer half is available in this build. */
function isAvailable() {
  try {
    require.resolve('puppeteer');
    return true;
  } catch {
    return false;
  }
}

const REPORTS = [
  {
    key: 'PRQ',
    label: 'Pharmacy PRQ Details',
    // Fill in on the admin machine: menu path / report URL, and the export
    // control to click. Keep the shape - the runner below iterates this list.
    navigate: 'Purchase > Reports > Pharmacy PRQ Details',
    exportAs: 'CSV',
  },
  {
    key: 'PO',
    label: 'Purchase Order Detail Report - Pharmacy',
    navigate: 'Purchase > Reports > Purchase Order Detail Report',
    exportAs: 'XLSX',
  },
  {
    key: 'GRN',
    label: 'Purchase Report Pharmacy Detail',
    navigate: 'Purchase > Reports > Purchase Report Pharmacy Detail',
    exportAs: 'CSV',
  },
];

/**
 * Pull the day's three raw files from the portal into layout.dayInputsDir.
 *
 * Throws a clear, actionable error when Puppeteer is not installed, rather
 * than failing deep inside a require - the mapping half stays fully usable
 * either way.
 */
async function fetchDailyInputs({ layout, credentials = {}, log }) {
  const close = log.step('Portal pull (Puppeteer)');
  try {
    if (!isAvailable()) {
      log.warn('Puppeteer is not installed in this build - the portal pull is unavailable here.');
      log.info('This half runs on the admin machine only. Use "Pick inputs folder" or the three file');
      log.info('pickers to map files that were pulled or exported by hand.');
      throw new Error(
        'Portal pull unavailable: Puppeteer is not part of this build. '
        + 'Install it on the admin machine (npm install puppeteer) and implement pullFromPortal().',
      );
    }

    ensureDir(layout.dayInputsDir);
    log.info(`downloads will land in ${layout.dayInputsDir}`);

    const files = await pullFromPortal({ layout, credentials, log });

    const present = files.filter((f) => fs.existsSync(f));
    if (present.length !== files.length) {
      log.warn(`${files.length - present.length} expected download(s) did not appear on disk`);
    }
    log.ok(`pulled ${present.length} file(s)`);
    return { files: present, date: layout.date.iso };
  } finally {
    close();
  }
}

/**
 * THE ONE FUNCTION TO IMPLEMENT ON THE ADMIN MACHINE.
 *
 * Sketch of what it needs to do, per entry in REPORTS:
 *   1. launch (headless: false is easier to debug on first run) with a
 *      downloadPath set to layout.dayInputsDir
 *   2. log in with credentials.username / credentials.password
 *   3. navigate to the report, set the date filter to layout.date.iso
 *      (the portal's own fields are DD-MM-YYYY - see parseReportDate, which
 *      already accepts that form)
 *   4. trigger the export and wait for the file to settle in the folder
 *   5. log.ok(...) each file as it arrives, and return the absolute paths
 *
 * Log through `log` rather than console, so the window shows the pull live
 * alongside the mapping stages.
 */
async function pullFromPortal({ layout, credentials, log }) {
  void layout;
  void credentials;
  for (const report of REPORTS) {
    log.info(`would fetch: ${report.label} (${report.navigate}) as ${report.exportAs}`);
  }
  throw new Error('pullFromPortal() is not implemented - see src/scraper/index.js');
}

module.exports = { fetchDailyInputs, isAvailable, REPORTS };
