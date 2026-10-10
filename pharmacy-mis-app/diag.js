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
    console.log('SIGNED IN, inspecting DOM...');

    // give the sidebar frame a moment to render
    await new Promise((r) => setTimeout(r, 3000));

    for (const frame of page.frames()) {
      console.log('\n=== FRAME:', frame.url(), '===');
      let inputs;
      try {
        inputs = await frame.evaluate(() => {
          return [...document.querySelectorAll('input, textarea')].map((el) => ({
            tag: el.tagName,
            type: el.type,
            placeholder: el.placeholder,
            ariaLabel: el.getAttribute('aria-label'),
            name: el.name,
            id: el.id,
            className: el.className,
            visible: el.offsetParent !== null,
            rect: (() => { const r = el.getBoundingClientRect(); return `${r.width}x${r.height} @ ${r.x},${r.y}`; })(),
            outerHTMLStart: el.outerHTML.slice(0, 200),
          }));
        });
      } catch (e) {
        console.log('  (could not evaluate:', e.message, ')');
        continue;
      }
      console.log('  input/textarea count:', inputs.length);
      inputs.forEach((i, idx) => console.log(`  [${idx}]`, JSON.stringify(i)));
    }

    console.log('\n=== Pressing Ctrl+I ===');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyI');
    await page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 1000));

    for (const frame of page.frames()) {
      let active;
      try {
        active = await frame.evaluate(() => {
          const el = document.activeElement;
          return el ? { tag: el.tagName, id: el.id, className: el.className, outerHTMLStart: el.outerHTML.slice(0, 200) } : null;
        });
      } catch (e) {
        active = 'ERR: ' + e.message;
      }
      console.log('Frame', frame.url(), 'activeElement:', JSON.stringify(active));
    }

    // Search for any element containing "search" text anywhere (case-insensitive), to find the hint text container
    console.log('\n=== Searching for "search" text nodes ===');
    for (const frame of page.frames()) {
      let matches;
      try {
        matches = await frame.evaluate(() => {
          const results = [];
          const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
          let node = walker.currentNode;
          while (node) {
            if (node.children.length === 0 && node.textContent && /search/i.test(node.textContent) && node.textContent.length < 60) {
              const r = node.getBoundingClientRect();
              results.push({ tag: node.tagName, text: node.textContent.trim(), className: node.className, rect: `${r.width}x${r.height}` });
            }
            node = walker.nextNode();
          }
          return results.slice(0, 20);
        });
      } catch (e) {
        matches = [];
      }
      if (matches.length) {
        console.log('Frame', frame.url());
        matches.forEach((m) => console.log('  ', JSON.stringify(m)));
      }
    }
  } catch (err) {
    console.log('FAILURE:', err.message);
  } finally {
    if (session) await closeSession(session);
  }
})();
