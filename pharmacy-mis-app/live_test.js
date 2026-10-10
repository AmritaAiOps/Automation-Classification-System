const os = require('os');
const path = require('path');
const fs = require('fs');
const { startSession, runReports, closeSession } = require('./src/scraper');
const { resolveLayout, getPreviousCalendarDay } = require('./src/core/paths');

const log = {
  debug: (m) => console.log('[debug]', m),
  info: (m) => console.log('[info]', m),
  ok: (m) => console.log('[ok]', m),
  warn: (m) => console.log('[warn]', m),
  error: (m) => console.log('[error]', m),
  step: (m) => { console.log('[step]', m); return () => {}; },
};

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-mis-livetest-'));
  const reportDate = getPreviousCalendarDay().iso;
  const layout = resolveLayout(testRoot, reportDate);
  console.log('Test archive root:', testRoot);
  console.log('Report date:', reportDate);

  let session;
  try {
    session = await startSession({ username: process.argv[2], password: process.argv[3] }, log);
    console.log('SIGN-IN OK');
    if (process.env.PHARMACY_MIS_DEBUG_CLICK) {
      session.page.on('console', (msg) => console.log('[BROWSER]', msg.text()));
      for (const frame of session.page.frames()) {
        await frame.evaluate(() => { window.__PHARMACY_MIS_DEBUG_CLICK__ = true; }).catch(() => {});
      }
      session.page.on('frameattached', async (f) => {
        await f.evaluate(() => { window.__PHARMACY_MIS_DEBUG_CLICK__ = true; }).catch(() => {});
      });
    }
    if (process.env.PHARMACY_MIS_DEBUG_CLICK) {
      session.page.on('framenavigated', () => {});
    }
    const result = await runReports(session, { layout }, log);
    console.log('RUN REPORTS OK');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.log('FAILURE:', err.message);
    console.log('SCREENSHOT:', err.screenshot);
  } finally {
    if (session) await closeSession(session);
  }
})();
