'use strict';

/**
 * Proves an alert raised by a tab the portal opens for itself gets answered.
 *
 *   node tools/check-alert-capture.js
 *
 * The portal answers an empty report with a plain window.alert() on the report
 * tab (/amritareports/SQRServlet), not on the tab the run drives. Nothing in
 * the normal, happy path ever exercises that — so it is provoked here against a
 * local page that behaves the same way.
 *
 * Kept out of npm test on purpose: this one launches a real browser, and the
 * self-test is meant to stay fast and browser-free.
 *
 * Why it is worth a check of its own: when this breaks it does not look like a
 * bug. The alert stays up, that tab's renderer stays blocked, no file ever
 * lands, and the run sits in its download wait for the full five minutes before
 * dying as a timeout that says nothing about what happened. The failure mode is
 * silence, which is exactly the kind that comes back.
 *
 * The first case is the one that matters. An alert raised while the document is
 * still being parsed leaves no window at all to attach to after the fact:
 * Page.enable never answers on a blocked renderer, and Page.handleJavaScriptDialog
 * is refused while the Page domain is disabled, so a capture armed even slightly
 * late can neither read the alert nor clear it. It has to be armed while the tab
 * is still paused at waitForDebuggerOnStart, before a line of its script runs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer');

const scraper = require('../src/scraper/index.js');

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const ALERT = 'The report is empty. Please try different parameters.';

const HOME = `<html><body>
<script>function go(u){window.open(u,'_blank');}</script>
<button id="empty" onclick="go('/report')">Empty</button>
<button id="file" onclick="go('/download')">File</button>
<button id="same" onclick="location.href='/report'">Same tab</button>
</body></html>`;

/** A local stand-in for the portal: home page, a report tab that alerts, a report tab that downloads. */
function serve(alertDelayMs) {
  const report = alertDelayMs === 0
    ? `<html><body><script>alert(${JSON.stringify(ALERT)});</script></body></html>`
    : `<html><body><script>setTimeout(function(){alert(${JSON.stringify(ALERT)});},${alertDelayMs});</script></body></html>`;

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/download') {
        res.writeHead(200, {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="report.csv"',
        });
        res.end('a,b\n1,2\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(req.url === '/report' ? report : HOME);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Swallows the run's own log lines; what is being checked is behaviour, not output. */
const quiet = { info() {}, warn() {}, debug() {}, ok() {}, error() {} };

async function withPortal(alertDelayMs, body) {
  const { server, port } = await serve(alertDelayMs);
  // protocolTimeout well under the check's own patience: a blocked renderer
  // should surface as a failed check, not as this script hanging.
  const browser = await puppeteer.launch({ headless: true, protocolTimeout: 15000 });
  try {
    const page = (await browser.pages())[0];
    scraper.attachDialogCapture(page, quiet);
    await scraper.captureDialogsEverywhere(browser, quiet);
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    return await body({ browser, page });
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

/** The portal alerted: it must be caught, read back once, and leave a usable tab behind. */
async function alertIsAnswered(name, alertDelayMs, button) {
  return withPortal(alertDelayMs, async ({ browser, page }) => {
    await page.click(button);

    const deadline = Date.now() + 15000;
    let seen = null;
    while (Date.now() < deadline && !seen) {
      seen = scraper.takeDialog(page);
      await sleep(250);
    }
    if (!seen) return { name, ok: false, detail: 'the alert was never answered (this is the hang)' };
    if (seen.message !== ALERT) return { name, ok: false, detail: `read back the wrong message: "${seen.message}"` };

    // Dismissed, not merely observed: a tab still blocked on the alert answers
    // nothing, and that is what the whole run was stuck behind.
    const blocked = (await browser.pages()).find((p) => p.url().endsWith('/report'));
    if (blocked) {
      const alive = await Promise.race([
        blocked.evaluate(() => true),
        sleep(5000).then(() => false),
      ]).catch(() => false);
      if (!alive) return { name, ok: false, detail: 'the alert was read but never cleared — the tab is still blocked' };
    }

    // Cleared on read, so the next report does not inherit this one's answer
    // and record a zero against a day that had data.
    if (scraper.takeDialog(page) !== null) {
      return { name, ok: false, detail: 'the alert was still there on a second read' };
    }

    return { name, ok: true, detail: `answered "${seen.message}"` };
  });
}

/** Taking over CDP's auto-attach must not disturb a report that downloads normally. */
async function downloadStillWorks() {
  const name = 'a report that downloads normally is unaffected';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmis-alertcheck-'));
  try {
    return await withPortal(0, async ({ browser, page }) => {
      const client = await browser.target().createCDPSession();
      await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
      await page.click('#file');

      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const landed = fs.readdirSync(dir).filter((n) => !n.endsWith('.crdownload'));
        if (landed.length) return { name, ok: true, detail: `download landed: ${landed[0]}` };
        await sleep(250);
      }
      return { name, ok: false, detail: 'no file arrived — the auto-attach broke downloads' };
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* leave it */ }
  }
}

async function main() {
  const results = [];
  results.push(await alertIsAnswered('a report tab that alerts while it is still parsing', 0, '#empty'));
  results.push(await alertIsAnswered('a report tab that alerts after it has loaded', 300, '#empty'));
  results.push(await alertIsAnswered('an alert on the tab the run drives', 0, '#same'));
  results.push(await downloadStillWorks());

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
