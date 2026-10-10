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

    const homeFrame = () => page.frames().find((f) => f.url().includes('HisHome.jsp'));
    console.log('BEFORE click, HisHome frame URL:', homeFrame()?.url());

    if (await mf.evaluate(() => document.body.classList.contains('page-sidebar-closed'))) {
      await mf.evaluate(() => document.querySelector('.sidebar-toggler').click());
      await new Promise((r) => setTimeout(r, 500));
    }

    const handle = await page.$('#txtMenuSearch');
    await handle.evaluate((el) => { el.value = ''; el.focus(); });
    await page.keyboard.type('Purchase Report Pharmacy Detail', { delay: 20 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 3000));

    console.log('AFTER Enter, HisHome frame URL:', homeFrame()?.url());
    console.log('All frame URLs now:', page.frames().map((f) => f.url()));

    const hf = homeFrame();
    if (hf) {
      const text = await hf.evaluate(() => document.body.innerText.slice(0, 500));
      console.log('HisHome frame body text:', text);
    }
  } catch (err) {
    console.log('FAILURE:', err.message);
  } finally {
    if (session) await closeSession(session);
  }
})();
