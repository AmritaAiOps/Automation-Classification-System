const { startSession, closeSession } = require('./src/scraper');

const log = {
  debug: (m) => console.log('[debug]', m),
  info: (m) => console.log('[info]', m),
  ok: (m) => console.log('[ok]', m),
  warn: (m) => console.log('[warn]', m),
  error: (m) => console.log('[error]', m),
  step: (m) => { console.log('[step]', m); return () => {}; },
};

(async () => {
  let session;
  try {
    session = await startSession({ username: process.argv[2], password: process.argv[3] }, log);
    const { page } = session;
    const mainFrame = page.mainFrame();
    await new Promise((r) => setTimeout(r, 2000));

    console.log('body class before:', await mainFrame.evaluate(() => document.body.className));

    const toggler = await page.$('.sidebar-toggler');
    console.log('toggler found:', !!toggler);
    await toggler.click();
    await new Promise((r) => setTimeout(r, 800));

    console.log('body class after click:', await mainFrame.evaluate(() => document.body.className));

    const searchRect = await mainFrame.evaluate(() => {
      const el = document.getElementById('txtMenuSearch');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height, x: r.x, y: r.y, visible: el.offsetParent !== null };
    });
    console.log('txtMenuSearch rect after toggle:', JSON.stringify(searchRect));

    if (searchRect && searchRect.width > 0) {
      const handle = await page.$('#txtMenuSearch');
      await handle.evaluate((el) => el.focus());
      await page.keyboard.type('Purchase Report Pharmacy Detail', { delay: 20 });
      await new Promise((r) => setTimeout(r, 1500));
      const matches = await mainFrame.evaluate((label) => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const want = norm(label);
        return [...document.querySelectorAll('li, a, div[role="option"], td')]
          .filter((el) => el.offsetParent !== null && norm(el.textContent).includes(want))
          .map((el) => el.tagName + ':' + el.textContent.trim().slice(0, 60));
      }, 'Purchase Report Pharmacy Detail');
      console.log('Matching visible entries after typing:', JSON.stringify(matches));
    }
  } catch (err) {
    console.log('FAILURE:', err.message);
  } finally {
    if (session) await closeSession(session);
  }
})();
