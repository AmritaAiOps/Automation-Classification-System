const { startSession, closeSession, ensureSidebarOpen, findFieldByLabel, focusAndType, clickMenuItemByText, realClick } = require('./src/scraper');

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
    await new Promise((r) => setTimeout(r, 2000));

    await ensureSidebarOpen(page);
    console.log('sidebar ensured open');

    const searchBox = await findFieldByLabel(page, 'search');
    console.log('searchBox found:', !!searchBox);
    await focusAndType(page, searchBox, 'Purchase Report Pharmacy Detail');
    console.log('typed');
    await new Promise((r) => setTimeout(r, 2000));

    const homeFrame = () => page.frames().find((f) => f.url().includes('HisHome.jsp'));
    console.log('before click, home frame url:', homeFrame()?.url());

    const opened = await clickMenuItemByText(page, 'Purchase Report Pharmacy Detail');
    console.log('clickMenuItemByText returned:', opened);

    await new Promise((r) => setTimeout(r, 3000));
    console.log('after click, home frame url:', homeFrame()?.url());
    console.log('all frame urls:', page.frames().map((f) => f.url()));
  } catch (err) {
    console.log('FAILURE:', err.message, err.stack);
  } finally {
    if (session) await closeSession(session);
  }
})();
