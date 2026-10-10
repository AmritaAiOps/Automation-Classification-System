const { startSession, closeSession } = require('./src/scraper');

const log = {
  debug: (m) => console.log('[debug]', m), info: (m) => console.log('[info]', m),
  ok: (m) => console.log('[ok]', m), warn: (m) => console.log('[warn]', m),
  error: (m) => console.log('[error]', m), step: (m) => { console.log('[step]', m); return () => {}; },
};

async function openViaSearch(page, label) {
  const mf = page.mainFrame();
  const closed = await mf.evaluate(() => document.body.classList.contains('page-sidebar-closed'));
  console.log('  sidebar closed?', closed);
  if (closed) {
    await mf.evaluate(() => document.querySelector('.sidebar-toggler').click());
    await new Promise((r) => setTimeout(r, 500));
  }
  const rect = await mf.evaluate(() => {
    const el = document.getElementById('txtMenuSearch');
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  console.log('  txtMenuSearch rect:', JSON.stringify(rect));

  const handle = await page.$('#txtMenuSearch');
  await handle.evaluate((el) => { el.value = ''; el.focus(); });
  await page.keyboard.type(label, { delay: 20 });
  await new Promise((r) => setTimeout(r, 1500));

  const clicked = await mf.evaluate((want) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = norm(want);
    const els = [...document.querySelectorAll('li, a, div[role="option"], td')]
      .filter((el) => el.offsetParent !== null && norm(el.textContent).includes(target));
    if (els.length) { els[0].click(); return els[0].textContent.trim(); }
    return null;
  }, label);
  console.log('  clicked entry:', clicked);
  await new Promise((r) => setTimeout(r, 2000));
  return clicked;
}

(async () => {
  let session;
  try {
    session = await startSession({ username: process.argv[2], password: process.argv[3] }, log);
    const { page } = session;
    await new Promise((r) => setTimeout(r, 2000));

    console.log('--- Report 1: Purchase Report Pharmacy Detail ---');
    await openViaSearch(page, 'Purchase Report Pharmacy Detail');
    console.log('  URL now:', page.url());
    const title1 = await page.mainFrame().evaluate(() => document.querySelector('h1, h2, h3')?.textContent || document.title);
    console.log('  page heading:', title1);

    console.log('--- Report 2: Received Items Pharmacy ---');
    await openViaSearch(page, 'Received Items Pharmacy');
    const title2 = await page.mainFrame().evaluate(() => document.querySelector('h1, h2, h3')?.textContent || document.title);
    console.log('  page heading:', title2);

    console.log('--- Report 3: Pharmacy PO Browser ---');
    await openViaSearch(page, 'Pharmacy PO Browser');
    const title3 = await page.mainFrame().evaluate(() => document.querySelector('h1, h2, h3')?.textContent || document.title);
    console.log('  page heading:', title3);
  } catch (err) {
    console.log('FAILURE:', err.message);
  } finally {
    if (session) await closeSession(session);
  }
})();
