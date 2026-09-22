'use strict';

/** Local DOM regression check for the report multi-select safeguards. */

const assert = require('assert');
const puppeteer = require('puppeteer');
const scraper = require('../src/scraper');

const log = { info() {}, ok() {}, warn() {} };

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <label for="creation">Creation Status</label>
      <select id="creation" multiple>
        <option>ALL</option>
        <option>Created</option><option>Approved</option><option>Rejected</option>
      </select>
      <label for="processing">Processing Status</label>
      <select id="processing" multiple>
        <option>ALL</option>
        <option>Pending</option><option>Processed</option>
      </select>
      <label for="department">Department</label>
      <select id="department" multiple>
        <option>Pharmacy</option><option>Stores</option>
      </select>
    `);

    await scraper.selectAllOptions(page, 'Creation Status', log);
    await scraper.selectAllOptions(page, 'Processing Status', log);
    await scraper.selectAllVisibleMultiSelects(page, log, {
      exclude: ['Creation Status', 'Processing Status'],
    });
    const complete = await scraper.auditFormFields(page, 'local PO form', log);
    assert.strictEqual(complete.complete, true);

    await page.evaluate(() => {
      const field = document.querySelector('#processing');
      field.options[1].selected = false;
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const partial = await scraper.auditFormFields(page, 'local PO form', log);
    assert.strictEqual(partial.complete, false);
    assert.ok(partial.underselected.some((value) => /Processing Status/i.test(value)));
    console.log('scraper field selection checks passed');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
