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

    // Inspect jQuery bound events on likely menu containers
    const evInfo = await mf.evaluate(() => {
      const out = {};
      try {
        const $ = window.jQuery;
        const targets = {
          document: document,
          menu: document.querySelector('.page-sidebar-menu'),
          ul: document.querySelector('.page-sidebar-menu ul'),
          searchInput: document.getElementById('txtMenuSearch'),
        };
        for (const [name, el] of Object.entries(targets)) {
          if (!el) { out[name] = 'NOT FOUND'; continue; }
          const data = $._data ? $._data(el, 'events') : (undefined);
          out[name] = data ? Object.keys(data).map((k) => `${k}(${data[k].length})`).join(',') : 'no events data';
        }
      } catch (e) { out.error = e.message; }
      return out;
    });
    console.log('jQuery event bindings:', JSON.stringify(evInfo, null, 2));

    const handle = await page.$('#txtMenuSearch');
    await handle.evaluate((el) => { el.value = ''; el.focus(); });
    await page.keyboard.type('Purchase Report Pharmacy Detail', { delay: 20 });
    await new Promise((r) => setTimeout(r, 1500));

    // check events on the matched <a> and its ancestors now that it's rendered
    const target = await mf.evaluateHandle((want) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const w = norm(want);
      const els = [...document.querySelectorAll('a, li')]
        .filter((el) => el.offsetParent !== null && norm(el.textContent) === w);
      els.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      return els[0] || null;
    }, 'Purchase Report Pharmacy Detail');
    const el = target.asElement();
    if (el) {
      const box = await el.boundingBox();
      console.log('target boundingBox:', JSON.stringify(box));

      const ancestorInfo = await el.evaluate((node) => {
        const $ = window.jQuery;
        const chain = [];
        let cur = node;
        for (let i = 0; i < 6 && cur; i++) {
          const data = $._data ? $._data(cur, 'events') : null;
          chain.push({ tag: cur.tagName, cls: cur.className, events: data ? Object.keys(data) : [] });
          cur = cur.parentElement;
        }
        return chain;
      });
      console.log('ancestor chain + events:', JSON.stringify(ancestorInfo, null, 2));

      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        console.log('Manual mouse click at', x, y);
        await page.mouse.move(x, y);
        await new Promise((r) => setTimeout(r, 200));
        await page.mouse.down();
        await new Promise((r) => setTimeout(r, 150));
        await page.mouse.up();
        await new Promise((r) => setTimeout(r, 3000));
        const hf = page.frames().find((f) => f.url().includes('HisHome.jsp'));
        console.log('HisHome frame URL after manual click:', hf?.url());
        console.log('ALL frame urls after click:', page.frames().map((f) => f.url()));
        for (const f of page.frames()) { try { console.log('  frame', f.url(), 'text:', (await f.evaluate(() => document.body.innerText)).slice(0,200)); } catch(e) {} }
      }
    } else {
      console.log('target not found for event inspection');
    }
  } catch (err) {
    console.log('FAILURE:', err.message);
  } finally {
    if (session) await closeSession(session);
  }
})();
