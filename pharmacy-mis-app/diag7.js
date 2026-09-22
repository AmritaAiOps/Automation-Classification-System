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

    console.log('Pressing Enter...');
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 3000));
    console.log('URL after Enter:', page.url());
    const heading = await mf.evaluate(() => document.querySelector('h1,h2,h3,.caption')?.textContent || document.title);
    console.log('heading after Enter:', heading);

    // Also dump body class + any visible form fields to see if report opened
    const info = await mf.evaluate(() => ({
      bodyClass: document.body.className,
      inputCount: document.querySelectorAll('input').length,
      hasFromDate: !!document.body.innerText.match(/from date/i),
    }));
    console.log('page info:', JSON.stringify(info));
  } catch (err) {
    console.log('FAILURE:', err.message);
  } finally {
    if (session) await closeSession(session);
  }
})();
