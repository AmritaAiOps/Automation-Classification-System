'use strict';

/**
 * Dumps the Purchase Report Pharmacy Detail form, twice: exactly as the portal
 * hands it over, and again after the run has set everything it sets.
 *
 *   HIS_USER=... HIS_PASS=... node tools/inspect-purchase-form.js [yyyy-mm-dd]
 *
 * Why this exists: the run reported that date as a genuine zero, and it is not
 * one — the same date returns rows when the form is filled in by hand. So a
 * filter the run leaves narrow is hiding them, and auditFormFields() did not
 * notice, which means it is looking at the wrong thing. This dumps every
 * control without assuming which kind it is, so what is actually still narrow
 * has somewhere to show up.
 *
 * Reads only. It does not run the report, so nothing here can produce a file
 * or a number that could be mistaken for a result.
 */

const scraper = require('../src/scraper/index.js');

const log = {
  info: (m) => console.log('[info]', m),
  warn: (m) => console.log('[warn]', m),
  debug: () => {},
  ok: (m) => console.log('[ok]', m),
  error: (m) => console.log('[error]', m),
  step: (m) => { console.log('[step]', m); return () => {}; },
};

/**
 * Everything on the form, by brute force.
 *
 * Deliberately not clever about widget types: the reason the form looked
 * complete last time is that the audit decided in advance what a list looks
 * like, and the controls that matter did not look like one. So every field is
 * reported the same way — what it is, what it holds, and for anything with
 * options, all of them and which are on.
 */
async function dumpForm(page, heading) {
  console.log(`\n===== ${heading} =====`);
  for (const frame of scraper.allFrames(page)) {
    let fields;
    try {
      fields = await frame.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          return el.offsetParent !== null && r.width > 0 && r.height > 0;
        };
        const labelOf = (el) => {
          if (el.id) {
            const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lab && norm(lab.textContent)) return norm(lab.textContent);
          }
          const cell = el.closest('td');
          if (cell && cell.previousElementSibling) {
            const t = norm(cell.previousElementSibling.textContent);
            if (t) return t;
          }
          let prev = el.previousElementSibling;
          for (let i = 0; i < 3 && prev; i += 1) {
            const t = norm(prev.textContent);
            if (t) return t;
            prev = prev.previousElementSibling;
          }
          return norm(el.name || el.id) || '(unlabelled)';
        };

        const out = [];

        for (const el of document.querySelectorAll('select')) {
          if (!visible(el)) continue;
          const options = [...el.options].map((o) => ({ text: norm(o.textContent), value: o.value, on: o.selected }));
          out.push({
            label: labelOf(el),
            kind: el.multiple ? 'select[multiple]' : 'select',
            selected: options.filter((o) => o.on).length,
            total: options.length,
            options,
          });
        }

        for (const el of document.querySelectorAll('input, textarea')) {
          if (!visible(el)) continue;
          const type = (el.type || 'text').toLowerCase();
          if (type === 'hidden') continue;
          out.push({
            label: labelOf(el),
            kind: `input[${type}]`,
            value: type === 'checkbox' || type === 'radio' ? String(el.checked) : norm(el.value),
            name: el.name || el.id || '',
          });
        }

        // Anything behaving like a list without being one: a group of
        // checkboxes, or a widget with role=option children. This is the shape
        // the audit missed.
        for (const group of document.querySelectorAll('[role="listbox"], .multiselect, .multiselect-dropdown, ul')) {
          const opts = group.querySelectorAll('[role="option"], li input[type="checkbox"]');
          if (opts.length < 2) continue;
          if (!visible(group)) continue;
          let on = 0;
          opts.forEach((o) => {
            const box = o.matches('input[type="checkbox"]') ? o : o.querySelector('input[type="checkbox"]');
            if (box ? box.checked : o.getAttribute('aria-selected') === 'true') on += 1;
          });
          out.push({ label: labelOf(group), kind: 'option-group', selected: on, total: opts.length });
        }

        return out;
      });
    } catch {
      continue; // frame went away mid-read
    }

    if (!fields.length) continue;
    console.log(`  --- frame ${frame.url().slice(0, 90)} ---`);
    for (const f of fields) {
      if (f.options) {
        const flag = f.selected === f.total ? '' : '   <-- NOT everything';
        console.log(`  ${f.label} [${f.kind}] ${f.selected}/${f.total} selected${flag}`);
        for (const o of f.options) console.log(`        ${o.on ? '[x]' : '[ ]'} ${o.text} (value=${JSON.stringify(o.value)})`);
      } else if (f.kind === 'option-group') {
        const flag = f.selected === f.total ? '' : '   <-- NOT everything';
        console.log(`  ${f.label} [${f.kind}] ${f.selected}/${f.total} selected${flag}`);
      } else {
        console.log(`  ${f.label} [${f.kind}] ${JSON.stringify(f.value)}${f.name ? ` name=${f.name}` : ''}`);
      }
    }
  }
}

async function main() {
  const date = process.argv[2] || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const username = process.env.HIS_USER;
  const password = process.env.HIS_PASS;
  if (!username || !password) {
    console.error('Set HIS_USER and HIS_PASS in the environment.');
    process.exit(1);
  }

  let session;
  try {
    session = await scraper.startSession({ username, password }, log);
    const { page } = session;

    await scraper.navigateToReport(page, 'Purchase Report Pharmacy Detail', log);
    await dumpForm(page, 'AS THE PORTAL HANDS IT OVER');

    await scraper.setDateRange(page, date, date, log);

    const grnType = await scraper.findFieldByLabel(page, 'grn type');
    if (grnType) await scraper.selectDropdownValue(page, grnType, 'All').catch((e) => log.warn('GRN Type: ' + e.message));
    const grnStatus = await scraper.findFieldByLabel(page, 'grn status');
    if (grnStatus) await scraper.selectDropdownValue(page, grnStatus, 'ALL').catch((e) => log.warn('GRN Status: ' + e.message));
    await scraper.selectAllOptions(page, 'Purchase Tax Scheme', log).catch((e) => log.warn('Tax Scheme: ' + e.message));

    await dumpForm(page, `AFTER THE RUN'S OWN SELECTIONS (date ${date})`);
    console.log('\nThe report was NOT run. Anything flagged "NOT everything" above is a '
      + 'filter the run leaves narrower than a person filling this in by hand would.');
  } catch (err) {
    console.log('FAILED:', err.message);
    if (err.screenshot) console.log('screenshot:', err.screenshot);
  } finally {
    if (session) await scraper.closeSession(session);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
