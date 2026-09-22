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
    await new Promise((r) => setTimeout(r, 2000));

    const mainFrame = page.mainFrame();
    const candidates = await mainFrame.evaluate(() => {
      const results = [];
      const sels = ['.menu-toggler', '.sidebar-toggler', '[class*="toggl" i]', 'a[href="javascript:;"]', 'button', '.page-sidebar-menu-toggler', '[onclick*="sidebar" i]', '[onclick*="menu" i]', '[data-toggle]'];
      const seen = new Set();
      sels.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => {
          if (seen.has(el)) return;
          seen.add(el);
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.top < 200) {
            results.push({
              tag: el.tagName, className: el.className, id: el.id,
              onclick: el.getAttribute('onclick'), href: el.getAttribute('href'),
              rect: `${r.width}x${r.height} @ ${r.x},${r.y}`,
              outerHTMLStart: el.outerHTML.slice(0, 200),
            });
          }
        });
      });
      return results;
    });
    console.log('Toggle candidates near top of page:');
    candidates.forEach((c, i) => console.log(`[${i}]`, JSON.stringify(c)));

    console.log('\nbody class:', await mainFrame.evaluate(() => document.body.className));
  } catch (err) {
    console.log('FAILURE:', err.message);
  } finally {
    if (session) await closeSession(session);
  }
})();
