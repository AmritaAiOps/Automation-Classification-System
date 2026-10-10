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

    if (await mf.evaluate(() => document.body.classList.contains('page-sidebar-closed'))) {
      await mf.evaluate(() => document.querySelector('.sidebar-toggler').click());
      await new Promise((r) => setTimeout(r, 500));
    }

    const handle = await page.$('#txtMenuSearch');
    await handle.evaluate((el) => { el.value = ''; el.focus(); });
    await page.keyboard.type('Purchase Report Pharmacy Detail', { delay: 20 });
    await new Promise((r) => setTimeout(r, 1500));

    // Find the exact leaf <a> for the filtered item
    const target = await mf.evaluateHandle((want) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const w = norm(want);
      const els = [...document.querySelectorAll('a, li')]
        .filter((el) => el.offsetParent !== null && norm(el.textContent) === w);
      els.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      const best = els[0];
      if (!best) return null;
      return best.tagName === 'A' ? best : best.querySelector('a') || best;
    }, 'Purchase Report Pharmacy Detail');

    const el = target.asElement();
    console.log('target found:', !!el);
    if (el) {
      const info = await el.evaluate((n) => ({ tag: n.tagName, text: n.textContent.trim(), href: n.getAttribute('href'), outerHTML: n.outerHTML.slice(0, 300) }));
      console.log('target info:', JSON.stringify(info));

      console.log('Attempting real Puppeteer click...');
      await el.click();
      await new Promise((r) => setTimeout(r, 3000));
      console.log('URL after real click:', page.url());
      const heading = await mf.evaluate(() => document.querySelector('h1,h2,h3,.caption')?.textContent || document.title);
      console.log('heading after real click:', heading);
    }
  } catch (err) {
    console.log('FAILURE:', err.message, err.stack);
  } finally {
    if (session) await closeSession(session);
  }
})();
