const { startSession, closeSession } = require('./src/scraper');

const log = {
  debug: (m) => console.log('[debug]', m), info: (m) => console.log('[info]', m),
  ok: (m) => console.log('[ok]', m), warn: (m) => console.log('[warn]', m),
  error: (m) => console.log('[error]', m), step: (m) => { console.log('[step]', m); return () => {}; },
};

(async () => {
  let session;
  try {
    session = await startSession({ username: process.argv[2], password: process.argv[3] }, log);
    const { page } = session;
    const mf = page.mainFrame();
    await new Promise((r) => setTimeout(r, 2000));

    // Try 1: native .click() via evaluate on the div
    await mf.evaluate(() => document.querySelector('.sidebar-toggler').click());
    await new Promise((r) => setTimeout(r, 500));
    console.log('after native .click() on div:', await mf.evaluate(() => document.body.className));

    // Try 2: click the LI wrapper via Puppeteer mouse
    const li = await page.$('.sidebar-toggler-wrapper');
    if (li) { await li.click(); await new Promise((r) => setTimeout(r, 500)); }
    console.log('after Puppeteer click on LI wrapper:', await mf.evaluate(() => document.body.className));

    // Try 3: check for jQuery and any bound click handlers info
    const jqInfo = await mf.evaluate(() => {
      const out = {};
      out.hasJQuery = typeof window.jQuery !== 'undefined';
      if (out.hasJQuery) {
        try {
          const $el = window.jQuery('.sidebar-toggler-wrapper, .sidebar-toggler');
          out.count = $el.length;
        } catch (e) { out.jqErr = e.message; }
      }
      out.layoutObj = typeof window.Layout !== 'undefined';
      out.appObj = typeof window.App !== 'undefined';
      return out;
    });
    console.log('jQuery/global info:', JSON.stringify(jqInfo));

    // Try 4: trigger via jQuery click if available
    if (jqInfo.hasJQuery) {
      await mf.evaluate(() => window.jQuery('.sidebar-toggler-wrapper').trigger('click'));
      await new Promise((r) => setTimeout(r, 500));
      console.log('after jQuery trigger click on LI:', await mf.evaluate(() => document.body.className));

      await mf.evaluate(() => window.jQuery('.sidebar-toggler').trigger('click'));
      await new Promise((r) => setTimeout(r, 500));
      console.log('after jQuery trigger click on DIV:', await mf.evaluate(() => document.body.className));
    }

    // Try 5: keyboard shortcut Ctrl+I via CDP dispatched directly with focus on body first
    await mf.evaluate(() => document.body.focus());
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyI');
    await page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 500));
    console.log('after ctrl+i (focus body first):', await mf.evaluate(() => document.body.className));
  } catch (err) {
    console.log('FAILURE:', err.message);
  } finally {
    if (session) await closeSession(session);
  }
})();
