const { startSession, closeSession, ensureSidebarOpen, findFieldByLabel, focusAndType, clickMenuItemByText, reportPageLooksOpen, describePage } = require('./src/scraper');

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
    const searchBox = await findFieldByLabel(page, 'search');
    await focusAndType(page, searchBox, 'Purchase Report Pharmacy Detail');
    await new Promise((r) => setTimeout(r, 2000));
    const opened = await clickMenuItemByText(page, 'Purchase Report Pharmacy Detail');
    console.log('clicked:', opened);
    await new Promise((r) => setTimeout(r, 3000));

    const looksOpen = await reportPageLooksOpen(page, 'Purchase Report Pharmacy Detail');
    console.log('reportPageLooksOpen:', looksOpen);
    console.log(await describePage(page));

    // Dump the report frame's actual heading elements & date inputs
    const rf = page.frames().find((f) => f.url().includes('AdapterHTTP'));
    if (rf) {
      const details = await rf.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const headings = [...document.querySelectorAll('h1,h2,h3,h4,caption,legend,td,div,span,b,font')]
          .filter((el) => el.children.length === 0 && norm(el.textContent).length > 0 && norm(el.textContent).length < 60)
          .map((el) => `${el.tagName}:"${norm(el.textContent)}"`);
        const inputs = [...document.querySelectorAll('input')].map((el) => ({
          name: el.name, id: el.id, placeholder: el.placeholder, type: el.type, visible: el.offsetParent !== null,
        }));
        return { headings: headings.slice(0, 30), inputs };
      });
      console.log('report frame headings:', JSON.stringify(details.headings, null, 2));
      console.log('report frame inputs:', JSON.stringify(details.inputs, null, 2));
    } else {
      console.log('NO report frame found; all frames:', page.frames().map((f) => f.url()));
    }
  } catch (err) {
    console.log('FAILURE:', err.message);
  } finally {
    if (session) await closeSession(session);
  }
})();
