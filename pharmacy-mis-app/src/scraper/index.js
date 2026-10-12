'use strict';

/**
 * The Puppeteer pull from Amrita HIS: sign in (the user never types into the
 * browser), then download three CSVs into layout.dayInputsDir, where the
 * mapping pipeline (src/pipeline.js) already looks:
 *   Pharmacy PRQ Details, Purchase Order Detail Report - Pharmacy,
 *   Purchase Report Pharmacy Detail (GRN Type/Status = All).
 * The pipeline identifies files by their columns (src/core/detect.js), so
 * nothing here needs to know which report a download is.
 *
 * Past sign-in everything is found by LABEL TEXT, not guessed IDs/classes; if
 * a label's wording differs on the live portal, change the string passed to
 * findFieldByLabel()/clickButtonByText(). See README.md "Live-portal testing".
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { ensureDir, formatPortalDate } = require('../core/paths');
const { screenshotDir } = require('../core/appdata');

/** Reports whether the Puppeteer half is available in this build. */
function isAvailable() {
  try {
    require.resolve('puppeteer');
    return true;
  } catch {
    return false;
  }
}

/**
 * Load Puppeteer. Not require()able: since v23 it is ESM only, so require()
 * throws ERR_REQUIRE_ESM even though require.resolve() succeeds (which is why
 * isAvailable() can be true for a build that cannot load it). Imported by file
 * URL because import() rejects a bare Windows path.
 */
async function loadPuppeteer() {
  const entry = require.resolve('puppeteer');
  const mod = await import(pathToFileURL(entry).href);
  return mod.default || mod;
}

/** Shown in the UI's "portal pull" badge. Purely informational. */
const REPORTS = [
  { key: 'PRQ', label: 'Pharmacy PRQ Details', exportAs: 'CSV' },
  { key: 'PO', label: 'Purchase Order Detail Report - Pharmacy', exportAs: 'CSV' },
  { key: 'GRN', label: 'Purchase Report Pharmacy Detail', exportAs: 'CSV' },
];

/**
 * The HIS home URL (overridable via AMRITA_HIS_URL). Must be the HIS host
 * (aefbd), not Keycloak's (ahisfbd): HIS issues the 302 into Keycloak whose
 * redirect_uri brings the browser back into HIS after sign-in.
 */
const PORTAL_URL = process.env.AMRITA_HIS_URL
  || 'https://aefbd.amritahospitals.org/his/Jsp/Core_Common/index.jsp?task=off';

const TIMEOUTS = {
  navigation: 45000,
  login: 30000,
  reportLoad: 30000,
  // Generous: all 52 tax schemes are selected and the portal loads the report in its own tab for minutes on a busy day.
  download: Number(process.env.PHARMACY_MIS_DOWNLOAD_TIMEOUT_MS) || 300000,
};

/**
 * Selectors in one place. The login ones are Keycloak's default theme IDs,
 * with name= fallbacks in case the theme is customised.
 */
const SELECTORS = {
  login: {
    username: '#username, input[name="username"]',
    password: '#password, input[name="password"]',
    submit: '#kc-login, button[type="submit"], input[type="submit"]',
    // Keycloak's default theme surfaces a field-level error near the inputs
    // and/or a page-level one; both are covered.
    error: '#input-error, #input-error-username, #input-error-password, .alert-error .kc-feedback-text, .alert-error, [id*="error" i]',
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * Generic, label-driven DOM helpers
 *
 * Deliberately not ID/class-based: the report pages inside Amrita HIS were
 * only seen in the reference video, not inspected live, so anything that
 * would break on a regenerated class name is avoided. These instead read the
 * page the way a person does — by the text next to a field.
 * ------------------------------------------------------------------ */

/**
 * Every frame of the page, the main document first. The portal keeps its URL at
 * index.jsp and puts the real content in a frame, so a top-document-only search
 * finds the sidebar and no form fields. First match wins, so main-document forms behave as before.
 */
function allFrames(page) {
  const main = page.mainFrame();
  return [main, ...page.frames().filter((f) => f !== main)];
}

/** Run a predicate in each frame, stopping at the first that returns truthy. */
async function someFrame(page, pageFunction, ...args) {
  for (const frame of allFrames(page)) {
    try {
      if (await frame.evaluate(pageFunction, ...args)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * True for errors meaning "this handle's document is gone". A handle from a
 * replaced frame fails with "Argument should belong to the same JavaScript
 * world", which looks like a call bug; the fix is to look the element up again.
 */
function isStaleHandleError(err) {
  return /same JavaScript world|Execution context was destroyed|Cannot find context|detached Frame|Target closed/i
    .test(err && err.message ? err.message : '');
}

/**
 * Run an in-page finder against every frame, returning the first element found.
 * Handles stay bound to their frame, so use handle.evaluate(), not page.evaluate().
 */
async function findInFrames(page, pageFunction, ...args) {
  for (const frame of allFrames(page)) {
    // A discarded frame lingers in page.frames() and still answers searches with unusable elements.
    if (frame.detached) continue;

    let handle;
    try {
      handle = await frame.evaluateHandle(pageFunction, ...args);
    } catch {
      continue; // a frame can navigate or be cross-origin mid-search
    }
    const el = handle.asElement();
    if (el) {
      // evaluateHandle() succeeding does not prove the handle is live; check now so a swapped frame is not an unrelated failure later.
      try {
        await el.evaluate(() => true);
        return el;
      } catch (err) {
        if (!isStaleHandleError(err)) return el; // a real page problem, not a dead handle
        await el.dispose().catch(() => {});
        continue;
      }
    }
    await handle.dispose().catch(() => {});
  }
  return null;
}

/**
 * Run a lookup-then-act step, retrying from the lookup if the handle dies (the
 * portal reloads its menu frame while the search is typed into). The lookup
 * must be inside attemptFn: a dead handle cannot be revived.
 */
async function withFreshHandle(attemptFn, { attempts = 3, label = 'the field' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await attemptFn();
    } catch (err) {
      if (!isStaleHandleError(err)) throw err;
      lastErr = err;
      await sleep(400); // let the replacement document finish arriving
    }
  }
  throw new Error(`${label} kept being replaced while it was being used (${lastErr.message})`);
}

/** Find the input/select/textarea associated with a visible label's text. */
async function findFieldByLabel(page, labelText, { exact = false } = {}) {
  return findInFrames(page, (label, wantExact) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    // Whitespace is stripped for comparison: the portal labels fields "FromDate"/"GrnStatus" but callers pass "from date".
    const squash = (s) => norm(s).replace(/\s+/g, '');
    const want = norm(label);
    const wantSquashed = squash(label);
    const matches = (text) => (wantExact
      ? norm(text) === want || squash(text) === wantSquashed
      : norm(text).includes(want) || squash(text).includes(wantSquashed));
    // offsetParent alone is not enough: a field in a collapsed panel has one but no box, and Puppeteer cannot click it.
    const visible = (el) => {
      if (!el || el.disabled || el.offsetParent === null) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    // 1. <label for="id"> or a field nested inside the label
    for (const lab of document.querySelectorAll('label')) {
      if (!matches(lab.textContent)) continue;
      const forId = lab.getAttribute('for');
      if (forId) {
        const el = document.getElementById(forId);
        if (visible(el)) return el;
      }
      const nested = lab.querySelector('input, select, textarea');
      if (visible(nested)) return nested;
    }

    // 2. a label-like element immediately followed by, or sharing a row/cell
    // parent with, a field — the common table/flex-row form layout.
    const labelish = document.querySelectorAll('label, span, div, td, th, p, strong');
    for (const el of labelish) {
      if (el.children.length > 1) continue; // skip containers, not leaf labels
      if (!matches(el.textContent)) continue;

      let sib = el.nextElementSibling;
      for (let i = 0; i < 4 && sib; i += 1) {
        if (/^(input|select|textarea)$/i.test(sib.tagName) && visible(sib)) return sib;
        const inner = sib.querySelector && sib.querySelector('input, select, textarea');
        if (visible(inner)) return inner;
        sib = sib.nextElementSibling;
      }

      const parent = el.parentElement;
      if (parent) {
        const inner = parent.querySelector('input, select, textarea');
        if (inner && inner !== el && visible(inner)) return inner;
      }
    }

    // 3. placeholder / aria-label / name / id text matching the label
    for (const el of document.querySelectorAll('input, select, textarea')) {
      const hay = [el.placeholder, el.getAttribute('aria-label'), el.name, el.id].join(' ');
      if (matches(hay) && visible(el)) return el;
    }

    return null;
  }, labelText, exact);
}

/**
 * Focus a field through the DOM and type on the keyboard. Never ElementHandle.click(),
 * which fails on anything without a scrollable box (the sidebar search).
 * 90ms/char, not 15: the portal's barcode-scanner listener treats fast bursts as
 * a scan and then the menu search never filters.
 */
async function focusAndType(page, handle, text, { delay = 90 } = {}) {
  await handle.evaluate((el) => {
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.focus();
    if ('value' in el) el.value = '';
  });
  // The keyboard belongs to the page and types wherever the focus is, so this
  // reaches a field inside a frame without any extra ceremony.
  await page.keyboard.type(text, { delay });
}

/** Set a form field's value the way a framework-controlled input expects — through the native setter, so React/Angular/Vue see the change. */
async function setInputValue(handle, value) {
  await handle.evaluate((el, val) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

/**
 * Click like a person: move, pause, press, pause, release. The menu-search
 * results have a real jQuery click handler that ignores both ElementHandle.click()
 * and dispatched MouseEvents (silent failure), but responds to separately-timed
 * mouse events. Falls back to in-page events when there is no bounding box.
 */
async function realClick(page, handle) {
  await handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  if (process.env.PHARMACY_MIS_DEBUG_CLICK) {
    const info = await handle.evaluate((el) => ({ tag: el.tagName, html: el.outerHTML.slice(0, 200), href: el.getAttribute && el.getAttribute('href') }));
    console.error('[DEBUG realClick target]', JSON.stringify(info));
  }
  const box = await handle.boundingBox().catch(() => null);
  if (process.env.PHARMACY_MIS_DEBUG_CLICK) console.error('[DEBUG realClick box]', JSON.stringify(box));
  if (box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await sleep(50);
    await page.mouse.down();
    await sleep(60);
    await page.mouse.up();
    return;
  }
  await handle.evaluate((el) => {
    for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  });
}

/** Click whatever on the page has visible text matching label (button, link, submit input). */
async function clickButtonByText(page, label) {
  const target = await findInFrames(page, (text) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const want = norm(text);
    const els = document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]');
    for (const el of els) {
      const t = el.tagName === 'INPUT' ? el.value : el.textContent;
      if ((norm(t) === want || norm(t).includes(want)) && el.offsetParent !== null && !el.disabled) return el;
    }
    return null;
  }, label);
  if (!target) return false;
  await realClick(page, target);
  return true;
}

/**
 * Click a menu entry (search result or leaf). Separate from clickButtonByText
 * because entries are list items its selector would miss. Picks the deepest
 * element whose text matches, preferring an exact match over a container.
 */
async function clickMenuItemByText(page, label) {
  const target = await findInFrames(page, (text) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const want = norm(text);
    const boxed = (el) => {
      const r = el.getBoundingClientRect();
      return el.offsetParent !== null && r.width > 0 && r.height > 0;
    };

    const candidates = [...document.querySelectorAll(
      'a, li, td, span, div, [role="option"], [role="menuitem"], [role="treeitem"]',
    )].filter((el) => norm(el.textContent).includes(want) && boxed(el));
    if (!candidates.length) return null;

    const exact = candidates.filter((el) => norm(el.textContent) === want);
    const pool = exact.length ? exact : candidates;
    // Fewest descendants = closest to the text itself.
    pool.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);

    if (window.__PHARMACY_MIS_DEBUG_CLICK__) {
      console.log('[DEBUG clickMenuItemByText] candidates=' + candidates.length + ' exact=' + exact.length);
      console.log('[DEBUG pool[0]]', pool[0] ? pool[0].tagName + ' class="' + pool[0].className + '" text="' + norm(pool[0].textContent).slice(0, 80) + '" descendants=' + pool[0].querySelectorAll('*').length : 'none');
    }

    // The portal's click handler is bound to the <a>, not the leaf label inside it (which "fewest descendants" picks).
    return pool[0].closest('a') || pool[0].querySelector('a') || pool[0];
  }, label);
  if (!target) return false;
  await realClick(page, target);
  return true;
}

/** Set a native <select> to the option whose text or value matches; false if handle is not a select or has no such option. */
const setNativeSelect = (handle, valueText) => handle.evaluate((el, val) => {
  if (el.tagName !== 'SELECT') return false;
  const norm = (s) => (s || '').trim().toLowerCase();
  const opt = [...el.options].find((o) => norm(o.textContent) === norm(val) || norm(o.value) === norm(val));
  if (!opt) return false;
  el.value = opt.value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, valueText);

/** Set a <select>, or a button/radio group, to the option whose text matches valueText. */
async function selectDropdownValue(page, handle, valueText) {
  const tag = await handle.evaluate((el) => el.tagName);
  if (tag === 'SELECT') {
    if (!await setNativeSelect(handle, valueText)) throw new Error(`option "${valueText}" not found in the dropdown`);
    return;
  }
  await openControl(handle);

  // The option list can still be rendering when the first search runs (the
  // GRN Type panel on a live run was seen open in a failure screenshot with
  // "All" visible but never clicked), so this is retried for a couple of
  // seconds rather than checked once.
  const deadline = Date.now() + 2500;
  let clicked = false;
  while (!clicked && Date.now() < deadline) {
    clicked = await clickButtonByText(page, valueText) || await clickMenuItemByText(page, valueText);
    if (!clicked) await sleep(200);
  }

  if (!clicked) {
    // A native <select> opened by a synthetic click renders its list as an OS
    // popup outside the DOM, so nothing above can click it. Escape closes it and
    // setting .value still works, so try that last.
    await page.keyboard.press('Escape').catch(() => {});
    const fallback = await setNativeSelect(handle, valueText).catch(() => false);
    if (fallback) return;

    const detail = await handle.evaluate((el) => `<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ''}${el.className ? ` class="${el.className}"` : ''}>`).catch(() => '(unknown element)');
    throw new Error(`option "${valueText}" not found (field was ${detail})`);
  }
}

/**
 * Open a custom control from inside the page rather than by driving the mouse
 * at it. ElementHandle.click() needs the element to have a box it can scroll to
 * and aim at, and throws "Node is either not clickable or not an Element" when
 * it does not — a form in a scrolling frame gives that no end of opportunities.
 */
async function openControl(handle) {
  await handle.evaluate((el) => {
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.focus();
    for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  });
}

/**
 * Real options only: blank-text entries (the Purchase Tax Scheme list's internal
 * "everything" row) and explicit "ALL" rows are aliases, not choices. Shared with
 * the audit so both agree on what "all of them" means.
 */
const REAL_OPTIONS = (el) => [...el.options]
  .map((o, i) => ({ i, text: (o.textContent || '').trim(), value: o.value }))
  .filter((o) => o.text !== '' && !/^all$/i.test(o.text));

/**
 * Select every real option in a <select multiple> by clicking the first and
 * shift-clicking the last, the only gesture this portal registers. This is
 * SpagoBI: an ExtJS layer submits from its own selection record, so assigning
 * option.selected leaves the DOM reading "52/52" while the request carries one
 * value (captured on the wire: 'sent "21"' -> empty report, versus click +
 * shift-click -> 227 rows). Falls back to DOM assignment if the options cannot
 * be clicked, and warns that this is known not to register.
 */
async function selectAllByRealClicks(page, field, labelText, log) {
  const options = await field.evaluate(REAL_OPTIONS);
  if (!options.length) throw new Error('the dropdown has no options to select');

  // Close anything left hanging over the form, or the first click is spent dismissing it instead of anchoring the range.
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(80);

  const handles = await field.$$('option');
  const first = options[0].i;
  const last = options[options.length - 1].i;

  const clickOption = async (index, withShift) => {
    const handle = handles[index];
    if (!handle) throw new Error(`no option at index ${index}`);
    await handle.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
    await sleep(60);
    const box = await handle.boundingBox();
    if (!box) throw new Error(`option ${index} has no clickable box`);
    if (withShift) await page.keyboard.down('Shift');
    // Aimed left of centre: a long option label can run wider than the list,
    // and the middle of the box can land outside the visible list area.
    await page.mouse.click(box.x + Math.min(box.width / 2, 60), box.y + box.height / 2);
    if (withShift) await page.keyboard.up('Shift');
    await sleep(60);
  };

  try {
    await clickOption(first, false);
    if (last !== first) await clickOption(last, true);
  } catch (err) {
    log.warn(`${labelText}: could not be selected by clicking (${err.message}). `
      + 'Falling back to setting the selection directly, which this portal may ignore.');
    return field.evaluate((el) => {
      const real = [...el.options].filter((o) => {
        const text = (o.textContent || '').trim();
        return text !== '' && !/^all$/i.test(text);
      });
      real.forEach((o) => { o.selected = true; });
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return real.length;
    });
  }

  // The click either took or it did not, and "did not" has to be loud: a
  // partial selection here is a wrong number in the master report that looks
  // exactly like a right one.
  const got = await field.evaluate((el) => [...el.options]
    .filter((o) => o.selected && (o.textContent || '').trim() !== '').length);
  if (got !== options.length) {
    throw new Error(`clicking selected ${got} of ${options.length} option(s)`);
  }
  return got;
}

/**
 * Every visible checkbox/option inside a multi-select control, or a
 * <select multiple>, ticked ON. Used for "Delivery Status = ALL" and
 * "Creation Status = ALL" — the option list is read from the live DOM rather
 * than a hard-coded list, so it stays correct if the portal adds a status.
 */
async function selectAllOptions(page, labelText, log, { exact = false } = {}) {
  const field = await findFieldByLabel(page, labelText, { exact });
  if (!field) throw new Error(`field not found`);

  const tag = await field.evaluate((el) => el.tagName);

  if (tag === 'SELECT') {
    const count = await selectAllByRealClicks(page, field, labelText, log);
    log.ok(`${labelText} = ALL (${count} option(s))`);
    return;
  }

  // A custom widget: open it, then tick every option it reveals — preferring
  // the widget's own "select all" control if it has one.
  await openControl(field).catch(() => {});
  await sleep(200);
  // Evaluated through the field so the panel is looked for in the same document
  // the field lives in, which is not the top one when the form is in a frame.
  const result = await field.evaluate(() => {
    const panel = document.querySelector(
      '[role="listbox"]:not([hidden]), .dropdown-menu.show, .multiselect-dropdown, .p-multiselect-panel, .ant-select-dropdown',
    ) || document.body;
    const selectAll = panel.querySelector(
      '[data-action="select-all" i], .select-all, input[type="checkbox"][name*="all" i], label[for*="all" i]',
    );
    if (selectAll) { selectAll.click(); return { usedSelectAll: true, count: 0 }; }
    const boxes = panel.querySelectorAll('[role="option"] input[type="checkbox"], [role="option"], li input[type="checkbox"]');
    let n = 0;
    boxes.forEach((b) => {
      const input = b.matches('input[type="checkbox"]') ? b : b.querySelector('input[type="checkbox"]');
      if (input && !input.checked) { input.click(); n += 1; }
      else if (!input && b.offsetParent !== null) { b.click(); n += 1; }
    });
    return { usedSelectAll: false, count: n };
  });
  await page.keyboard.press('Escape').catch(() => {});

  if (!result.usedSelectAll && result.count === 0) throw new Error('no options found in the dropdown panel');
  log.ok(`${labelText} = ALL${result.count ? ` (${result.count} option(s))` : ''}`);
}

/**
 * Select every visible native multi-select that represents a report filter.
 * The PO report has changed its status-field set across portal deployments,
 * so Creation Status and Processing Status are selected explicitly below,
 * while this discovery pass catches additional status/filter lists without
 * hard-coding their names.
 */
async function selectAllVisibleMultiSelects(page, log, { exclude = [] } = {}) {
  const excluded = new Set(exclude.map((s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase()));
  const labels = new Set();

  for (const frame of allFrames(page)) {
    try {
      const found = await frame.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el || el.disabled || el.offsetParent === null) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const labelFor = (el) => {
          if (el.id) {
            const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lab && norm(lab.textContent)) return norm(lab.textContent);
          }
          const cell = el.closest('td');
          if (cell && cell.previousElementSibling && norm(cell.previousElementSibling.textContent)) {
            return norm(cell.previousElementSibling.textContent);
          }
          let prev = el.previousElementSibling;
          for (let i = 0; i < 3 && prev; i += 1) {
            if (norm(prev.textContent)) return norm(prev.textContent);
            prev = prev.previousElementSibling;
          }
          return norm(el.getAttribute('aria-label') || el.name || el.id);
        };
        return [...document.querySelectorAll('select[multiple]')]
          .filter(visible)
          .map(labelFor)
          .filter(Boolean);
      });
      for (const label of found) labels.add(label);
    } catch { /* frame may be navigating */ }
  }

  for (const label of labels) {
    if (excluded.has(label.toLowerCase())) continue;
    await selectAllOptions(page, label, log, { exact: true });
  }
  return [...labels].filter((label) => !excluded.has(label.toLowerCase()));
}

/**
 * Every field on the report form just before the report runs, with how much of
 * each list is selected. A multi-select left on the portal default silently
 * narrows the report and looks like a quiet day; any list not fully selected is
 * called out by name. Diagnostic, behind PHARMACY_MIS_AUDIT_FIELDS.
 *
 * It reads the DOM, which on this portal is not what gets submitted, so a clean
 * audit means "nothing looks narrow", not "the request is right"; that is what
 * selectAllByRealClicks() guarantees by clicking like a person and failing loudly.
 */
async function auditFormFields(page, label, log) {
  const verbose = !!process.env.PHARMACY_MIS_AUDIT_FIELDS;
  if (verbose) log.info(`--- field audit: ${label} ---`);
  const underselected = [];

  for (const frame of allFrames(page)) {
    let fields;
    try {
      fields = await frame.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const boxed = (el) => {
          const r = el.getBoundingClientRect();
          return el.offsetParent !== null && r.width > 0 && r.height > 0;
        };
        const labelFor = (el) => {
          if (el.id) {
            const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lab && norm(lab.textContent)) return norm(lab.textContent);
          }
          const cell = el.closest('td');
          if (cell && cell.previousElementSibling) {
            const text = norm(cell.previousElementSibling.textContent);
            if (text) return text;
          }
          let prev = el.previousElementSibling;
          for (let i = 0; i < 3 && prev; i += 1) {
            const text = norm(prev.textContent);
            if (text) return text;
            prev = prev.previousElementSibling;
          }
          return norm(el.name || el.id) || '(unlabelled)';
        };

        return [...document.querySelectorAll('select, input, textarea')]
          .filter(boxed)
          .filter((el) => !/^(hidden|submit|button|image)$/i.test(el.type || ''))
          .map((el) => {
            const base = { label: labelFor(el), tag: el.tagName.toLowerCase(), type: el.type || '' };
            if (el.tagName === 'SELECT') {
              // Real options only — blank entries and the portal's explicit
              // ALL row are aliases/controls, not individual choices.
              const real = [...el.options].filter((o) => {
                const text = (o.textContent || '').trim();
                return text !== '' && !/^all$/i.test(text);
              });
              return {
                ...base,
                multiple: el.multiple,
                options: real.length,
                selected: real.filter((o) => o.selected).length,
              };
            }
            return { ...base, value: norm(el.value).slice(0, 40), checked: !!el.checked };
          });
      });
    } catch {
      continue; // a frame can navigate or be cross-origin mid-audit
    }

    for (const field of fields) {
      if (field.tag === 'select') {
        const kind = field.multiple ? 'multi-select' : 'dropdown';
        const incomplete = field.multiple && field.selected < field.options;
        if (incomplete) underselected.push(`${field.label} (${field.selected}/${field.options})`);
        if (verbose) {
          log.info(`  ${field.label} [${kind}] ${field.selected}/${field.options} selected`
            + (incomplete ? '   <-- NOT all selected' : ''));
        }
      } else if (verbose && /^(radio|checkbox)$/i.test(field.type)) {
        log.info(`  ${field.label} [${field.type}] "${field.value}"${field.checked ? ' (on)' : ''}`);
      } else if (verbose) {
        log.info(`  ${field.label} [${field.type || field.tag}] "${field.value}"`);
      }
    }
  }

  if (underselected.length) {
    log.warn(`${label}: ${underselected.length} list(s) are not fully selected — ${underselected.join(', ')}`);
  }
  if (verbose) log.info('--- end field audit ---');

  return { complete: underselected.length === 0, underselected };
}

/* ------------------------------------------------------------------ *
 * What the portal says back
 * ------------------------------------------------------------------ */

/**
 * Record an alert the portal raised, wherever it was raised.
 *
 * Kept on the browser rather than a page: the alert can come from the report
 * window the portal opens rather than the one being driven, and whichever step
 * is waiting needs to see it wherever it came from. Two capture paths run at
 * once (see below) and can both see the same alert, so a repeat of the same
 * message within a couple of seconds is treated as one event and logged once.
 */
function recordDialog(browser, message, log) {
  const now = Date.now();
  const previous = browser.__lastDialog;
  if (previous && previous.message === message && now - previous.at < 2000) return false;
  browser.__lastDialog = { message, at: now };
  log.info(`the portal said: "${message}" — clicking OK`);
  return true;
}

/**
 * The portal answers some runs with a plain window.alert() rather than a file
 * — "The report is empty. Please try different parameters." is the one that
 * matters here. An alert blocks the page's own JavaScript until it is
 * dismissed, and Puppeteer (25.x) never dismisses one on its own: with nothing
 * listening it simply re-emits the event and leaves the dialog standing, so the
 * download wait runs its full timeout and fails as a timeout, which says
 * nothing about what actually happened. Captured and dismissed here; whichever
 * step is in flight reads it back with takeDialog().
 *
 * This covers the page the run drives directly. The report tab the portal opens
 * for itself is covered by captureDialogsEverywhere(), which has to work much
 * harder for it.
 */
function attachDialogCapture(page, log) {
  page.on('dialog', async (dialog) => {
    const message = (dialog.message() || '').replace(/\s+/g, ' ').trim();
    try { recordDialog(page.browser(), message, log); } catch { /* browser already gone */ }
    await dialog.accept().catch(() => dialog.dismiss().catch(() => {}));
  });
}

/**
 * Dialog capture on every page this browser opens, present and future.
 *
 * A page-only handler is not enough: an alert raised on the report tab the
 * portal opens is nobody's dialog as far as the driven page is concerned, so it
 * goes unanswered, blocks that renderer, and the run waits out its whole
 * download timeout next to an OK button nothing will ever click.
 *
 * The obvious version of this — browser.on('targetcreated') and then
 * await target.page() — cannot work, and the reason is worth writing down,
 * because it fails in a way that looks like a hang rather than a bug.
 * Reproduced locally against a page that alerts as it parses:
 *
 *   1. Puppeteer emits 'targetcreated' for the report tab only once that tab
 *      has already been resumed and navigated (observed: url was already the
 *      report's, not about:blank).
 *   2. By then the alert is up and the tab's renderer is blocked on it.
 *   3. target.page() runs Page.enable / Runtime.enable / Network.enable against
 *      that renderer, and a blocked renderer answers none of them. It does not
 *      reject — it hangs for the full protocolTimeout (180s by default).
 *   4. So the 'dialog' listener is never attached at all. Not a race that is
 *      sometimes lost: a deadlock that is never won.
 *
 * Page.enable is also the one command needed to dismiss a dialog
 * (Page.handleJavaScriptDialog is refused while the Page domain is disabled),
 * so once the alert is up, nothing can clear it. It has to be caught before it
 * opens.
 *
 * Which is what this does: it takes over CDP's auto-attach at the browser
 * level, so a new tab is seen the moment it is created — still at url "" and
 * still paused at waitForDebuggerOnStart, before a line of its script has run.
 * Page.enable answers fine while a target is paused. Only then is the target
 * resumed. Verified against the worst case (alert during the first parse, no
 * load delay at all): caught, where every after-the-fact approach fails.
 */
async function captureDialogsEverywhere(browser, log) {
  let root;
  try {
    root = await browser.target().createCDPSession();
  } catch (err) {
    // Not fatal (the driven page has its own handler), but an unanswered alert turns "report is empty" into a timeout.
    log.warn(`browser-wide alert capture could not be installed (${err.message}). `
      + 'An alert raised on a report tab would go unanswered.');
    return;
  }

  root.on('Target.attachedToTarget', async (event) => {
    const { sessionId, targetInfo, waitingForDebugger } = event;
    const session = root.connection()?.session(sessionId);
    if (!session) return;

    try {
      if (targetInfo.type === 'page') {
        session.on('Page.javascriptDialogOpening', async (dialog) => {
          const message = (dialog.message || '').replace(/\s+/g, ' ').trim();
          recordDialog(browser, message, log);
          // First handler to answer wins; the loser is correctly told nothing is showing.
          await session.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        });
        // Capped: Edge's download panel never answers while Edge is behind another window.
        await withTimeout(session.send('Page.enable'), 5000, new Error('Page.enable did not answer'));
        // Focus emulation keeps Edge from throttling the report tab while it builds its CSV.
        await withTimeout(session.send('Emulation.setFocusEmulationEnabled', { enabled: true }), 3000, null).catch(() => {});
      }
    } catch (err) {
      log.debug(`alert capture could not be armed for ${targetInfo.url || 'a new tab'}: ${err.message}`);
    } finally {
      // Always resume, even after a failure: a paused target never loads.
      if (waitingForDebugger) await session.send('Runtime.runIfWaitingForDebugger').catch(() => {});
    }
  });

  await root.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
}

/** The last dialog the portal raised anywhere in this browser, cleared as it is read. */
function takeDialog(page) {
  let browser;
  try { browser = page.browser(); } catch { return null; }
  const dialog = browser.__lastDialog || null;
  browser.__lastDialog = null;
  return dialog;
}

const EMPTY_REPORT = /report is empty/i;

/* ------------------------------------------------------------------ *
 * Downloads
 * ------------------------------------------------------------------ */

/**
 * Point Chromium's downloads at dir, browser-wide (the portal can deliver a
 * report through a window other than the driven one); page-level as a fallback.
 */
async function routeDownloadsTo(page, dir) {
  try {
    const client = await page.browser().target().createCDPSession();
    await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    return;
  } catch { /* fall through to the page-level call */ }
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
}

/**
 * Wait for a file that was not present in `before` to appear in dir and stop
 * growing. No fixed sleeps: this polls a real filesystem condition (a new,
 * size-stable file) rather than waiting a guessed number of seconds.
 */
async function waitForNewDownload(dir, before, { timeout = TIMEOUTS.download, label = 'report', page = null, log = null } = {}) {
  const deadline = Date.now() + timeout;
  const startedAt = Date.now();
  let nextHeartbeat = startedAt + 15000;

  let candidate = null;
  while (Date.now() < deadline) {
    const names = fs.readdirSync(dir).filter((n) => !n.endsWith('.crdownload') && !n.endsWith('.tmp'));
    const fresh = names.find((n) => !before.has(n));
    if (fresh) { candidate = path.join(dir, fresh); break; }

    // Heartbeat every 15s so a long wait is distinguishable from a hang.
    if (log && Date.now() >= nextHeartbeat) {
      nextHeartbeat = Date.now() + 15000;
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      let where = '';
      try {
        // targets(), not pages(): pages() can hang on Edge's download panel (see closeLeftoverReportTabs()).
        where = page.browser().targets()
          .filter((t) => t.type() === 'page')
          .map((t) => shortUrl(t.url()))
          .join(' | ');
      } catch { where = '(could not read the open pages)'; }
      log.info(`still waiting after ${seconds}s — open tab(s): ${where}`);
    }

    // A portal alert is an answer; do not wait out the full timeout after it.
    const dialog = page && takeDialog(page);
    if (dialog) {
      const err = new Error(`${label}: the portal answered "${dialog.message}" instead of producing a file.`);
      err.portalDialog = dialog.message;
      err.emptyReport = EMPTY_REPORT.test(dialog.message);
      throw err;
    }

    await sleep(250);
  }
  if (!candidate) throw new Error(`${label} download timed out.`);

  let lastSize = -1;
  while (Date.now() < deadline) {
    let size;
    try { size = fs.statSync(candidate).size; } catch { size = -1; }
    if (size === lastSize && size > 0) return candidate;
    lastSize = size;
    await sleep(250);
  }
  throw new Error(`${label} download timed out (file never finished writing).`);
}

async function runReportAndWaitForDownload(page, { downloadDir, label }, log) {
  ensureDir(downloadDir);
  const before = new Set(fs.readdirSync(downloadDir));
  await routeDownloadsTo(page, downloadDir);

  const audit = await auditFormFields(page, label, log);
  if (!audit.complete) {
    throw new Error(
      `${label}: one or more multi-select filters are not fully selected: `
      + `${audit.underselected.join(', ')}`,
    );
  }

  const clicked = await clickButtonByText(page, 'Run Report');
  if (!clicked) throw new Error(`${label} download timed out: the "Run Report" control was not found.`);
  log.info('report executed, waiting for the download…');

  let file;
  try {
    file = await waitForNewDownload(downloadDir, before, { timeout: TIMEOUTS.download, label, page, log });
  } catch (err) {
    // "Report is empty" is a genuine zero only if the audit was clean; a narrowed filter gives the same message.
    if (err.emptyReport && audit.complete) {
      log.warn(`${label}: the portal reported no data for this date, with every filter fully selected — a genuine zero.`);
      return null;
    }
    if (err.emptyReport) {
      throw new Error(
        `${label}: the portal said the report is empty, but ${audit.underselected.length} filter list(s) `
        + `were not fully selected (${audit.underselected.join(', ')}). That is the likelier cause than a `
        + 'day with no data, so the run was stopped rather than recording a zero.',
      );
    }
    throw err;
  }
  log.ok(`download complete: ${path.basename(file)}`);
  return file;
}

/**
 * Move a staged download into the day's inputs folder under a stable, human-readable name
 * (<report>_DD-MM-YYYY.<ext>) — never the browser's own (possibly reused) filename.
 *
 * A file already sitting at that name (the same day pulled twice) is never
 * overwritten: it is moved into a "previous" subfolder with a timestamp first.
 * It goes to a subfolder rather than beside the new file because the pipeline
 * reads every .csv/.xlsx directly inside the day's folder, and an old copy
 * next to the new one would compete with it.
 */
function movePortalFile(sourcePath, destDir, label, dateDmy) {
  const ext = path.extname(sourcePath) || '.csv';
  const base = `${label}_${dateDmy}`;
  const dest = path.join(destDir, `${base}${ext}`);
  if (fs.existsSync(dest)) {
    const prevDir = path.join(destDir, 'previous');
    ensureFolder(prevDir, 'the "previous" folder for replaced downloads');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    let archived = path.join(prevDir, `${base}_replaced-${stamp}${ext}`);
    for (let n = 2; fs.existsSync(archived); n += 1) {
      archived = path.join(prevDir, `${base}_replaced-${stamp}-${n}${ext}`);
    }
    try {
      fs.renameSync(dest, archived);
    } catch (err) {
      throw new Error(`${path.basename(dest)} already exists and could not be set aside (${err.message}). Is it open in another program?`);
    }
  }
  try {
    fs.renameSync(sourcePath, dest);
  } catch (err) {
    throw new Error(`Could not save ${path.basename(dest)} into ${destDir}: ${err.message}`);
  }
  return dest;
}

/** ensureDir() with a message that says which folder and why, for the operator. Reuses a folder that already exists. */
function ensureFolder(dir, what) {
  try {
    return ensureDir(dir);
  } catch (err) {
    throw new Error(`Could not create ${what} (${dir}): ${err.message}. Check the Input Output Files folder exists and is writable.`);
  }
}

/* ------------------------------------------------------------------ *
 * Login
 * ------------------------------------------------------------------ */

/** The host part of a URL, for logs that should not carry query strings around. */
function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

/** host + path for log lines; a just-created tab reports "" which new URL() would throw on. */
function shortUrl(url) {
  if (!url) return '(blank tab)';
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname;
  } catch {
    return String(url).slice(0, 60);
  }
}

/** Turn a failed navigation into an actionable message: "did not connect" (theirs to fix) vs "refused". */
function describeUnreachable(err) {
  const raw = err && err.message ? err.message : String(err);
  const host = hostOf(PORTAL_URL);

  if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return `Could not reach Amrita HIS at ${host}: the address did not resolve. `
      + 'Check the network connection, and the VPN if this portal needs one.';
  }
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_CONNECTION_RESET|ECONNRESET/i.test(raw)) {
    return `Could not reach Amrita HIS at ${host}: the connection was refused. `
      + 'The portal may be down, or unreachable from this network.';
  }
  if (/timeout|ERR_TIMED_OUT|ETIMEDOUT/i.test(raw)) {
    return `Could not reach Amrita HIS at ${host}: it did not answer in time. `
      + 'The portal may be down or very slow, or unreachable from this network.';
  }
  if (/ERR_CERT|CERT_|SSL/i.test(raw)) {
    return `Could not reach Amrita HIS at ${host}: its security certificate was rejected. ${raw}`;
  }
  return `Could not reach Amrita HIS at ${host}: ${raw}`;
}

/**
 * Fill and submit the real Amrita HIS sign-in form with the application-
 * supplied credentials. The user never sees or touches this browser window
 * for this step — everything below is Puppeteer acting on their behalf.
 */
async function login(page, credentials, log) {
  const close = log.step('Amrita HIS — signing in');
  try {
    if (!credentials || !credentials.username || !credentials.password) {
      throw new Error('Amrita HIS username and password are required.');
    }

    log.info(`connecting to ${hostOf(PORTAL_URL)}`);
    try {
      await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
    } catch (err) {
      throw new Error(describeUnreachable(err));
    }
    // Landing elsewhere is expected (HIS redirects into Keycloak); logging where separates "portal down" from "password rejected".
    log.ok(`connected — Amrita HIS answered, now at ${hostOf(page.url())}`);

    const userField = await page.waitForSelector(SELECTORS.login.username, { timeout: TIMEOUTS.login }).catch(() => null);
    const passField = userField && await page.$(SELECTORS.login.password);
    if (!userField || !passField) {
      throw new Error(
        'Connected to Amrita HIS, but its sign-in form was not found at '
        + `${page.url()} — the portal may be showing a maintenance page, or its `
        + 'sign-in page may have changed.',
      );
    }
    log.info('sign-in page reached — submitting credentials');

    // Typed like a person; nothing here is logged (not the username, password or its length).
    await userField.click({ clickCount: 3 });
    await userField.type(credentials.username, { delay: 12 });
    await passField.click({ clickCount: 3 });
    await passField.type(credentials.password, { delay: 12 });

    const submit = await page.$(SELECTORS.login.submit);
    if (!submit) throw new Error('Amrita HIS login page could not be loaded: the sign-in button was not found.');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: TIMEOUTS.login }).catch(() => null),
      submit.click(),
    ]);

    log.info('checking whether the credentials were accepted');
    await verifyAuthentication(page, log);
    log.ok('Credentials accepted — signed in to Amrita HIS');
  } finally {
    close();
  }
}

/**
 * Confirm the sign-in actually succeeded rather than assuming it did.
 * Checked two ways: the URL is no longer the Keycloak auth endpoint, and the
 * sign-in form itself is no longer present. Either one still showing means
 * authentication did not go through.
 */
async function verifyAuthentication(page, log) {
  const stillOnAuthUrl = /\/protocol\/openid-connect\/auth/i.test(page.url());
  const formStillPresent = await page.$(SELECTORS.login.username).then(Boolean).catch(() => false);

  if (stillOnAuthUrl || formStillPresent) {
    const errorText = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const text = el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
      return text;
    }, SELECTORS.login.error).catch(() => '');

    // Prefer the portal's own wording (account locked, disabled...); otherwise the credentials were rejected.
    if (errorText) throw new Error(`Login failed: ${errorText}`);
    throw new Error('Incorrect username or password. Please check your Amrita HIS credentials and try again.');
  }

  log.debug(`left the sign-in page — now at ${page.url()}`);
}

/** Thrown mid-run if a navigation unexpectedly lands back on the sign-in form. */
async function assertSessionAlive(page) {
  const backAtLogin = /\/protocol\/openid-connect\/auth/i.test(page.url())
    || await page.$(SELECTORS.login.username).then(Boolean).catch(() => false);
  if (backAtLogin) throw new Error('Amrita HIS session expired. Please sign in again.');
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

/**
 * Whether the report itself is on screen, as opposed to merely a menu entry
 * naming it. The portal titles each report page with its own name, and puts the
 * date fields every one of them needs on that page, so the two together
 * separate an opened report from a sidebar that merely mentions one.
 */
async function reportPageLooksOpen(page, reportLabel) {
  return someFrame(page, (label) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const want = norm(label);
    const boxed = (el) => {
      const r = el.getBoundingClientRect();
      return el.offsetParent !== null && r.width > 0 && r.height > 0;
    };

    const titled = [...document.querySelectorAll('h1, h2, h3, h4, caption, legend, td, div, span, b, font')]
      .some((el) => el.children.length === 0 && norm(el.textContent) === want && boxed(el));
    const hasDateField = [...document.querySelectorAll('input')]
      .some((el) => /date/i.test([el.name, el.id, el.placeholder].join(' ')) && boxed(el));

    return titled || hasDateField;
  }, reportLabel);
}

/**
 * A short description of what the page actually offered, appended to a
 * navigation failure. Without it "could not be located" says nothing about
 * whether the menu was missing, the search returned nothing, or the report was
 * sitting in a frame this code never looked inside.
 */
async function describePage(page) {
  try {
    const facts = await page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const boxed = (el) => {
        const r = el.getBoundingClientRect();
        return el.offsetParent !== null && r.width > 0 && r.height > 0;
      };
      const menuish = [...document.querySelectorAll('a, li, [role="menuitem"], [role="treeitem"]')]
        .filter((el) => el.children.length === 0 && boxed(el) && norm(el.textContent))
        .map((el) => norm(el.textContent))
        .filter((t) => t.length < 60);
      return {
        url: location.href,
        frames: [...document.querySelectorAll('iframe, frame')].map((f) => f.getAttribute('src') || '(no src)'),
        inputs: document.querySelectorAll('input').length,
        sample: [...new Set(menuish)].slice(0, 12),
      };
    });

    const bits = [` Page was ${facts.url}, with ${facts.inputs} input field(s).`];
    if (facts.frames.length) {
      bits.push(` It contains ${facts.frames.length} frame(s) (${facts.frames.slice(0, 3).join(', ')})`
        + ' — the report may live inside one, which this automation does not yet look into.');
    }
    if (facts.sample.length) bits.push(` Menu entries visible: ${facts.sample.join(' | ')}.`);
    return bits.join('');
  } catch {
    return '';
  }
}

/**
 * Open the portal's left-hand menu if it is collapsed to its icon rail (the
 * theme's "page-sidebar-closed" body class makes the search field 0x0). The
 * toggle must be a native DOM .click(); a coordinate-based mouse click does nothing.
 */
async function ensureSidebarOpen(page) {
  const isClosed = () => page.mainFrame().evaluate(
    () => document.body.classList.contains('page-sidebar-closed'),
  );
  if (!(await isClosed().catch(() => false))) return;

  await page.mainFrame().evaluate(() => {
    const toggler = document.querySelector('.sidebar-toggler');
    if (toggler) toggler.click();
  }).catch(() => {});

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (await isClosed().catch(() => false))) {
    await sleep(100);
  }
}

/**
 * Close the report tabs the portal opens and never closes. Each leftover adds a
 * frame (3, then 4) that findFieldByLabel() can match inside, killing the third
 * report with a dead-handle error.
 */
async function closeLeftoverReportTabs(page, log) {
  // Not browser.pages(): that attaches to every tab-like target, including Edge's
  // download panel, which never answers while Edge is behind another window and
  // stalled the run here. Read the tab list over CDP and close report tabs by id.
  let client;
  try {
    const browser = page.browser();
    if (!browser.__tabsClient) browser.__tabsClient = await browser.target().createCDPSession();
    client = browser.__tabsClient;
  } catch { return; }

  const listed = await withTimeout(client.send('Target.getTargets'), 5000, null).catch(() => null);
  for (const info of (listed && listed.targetInfos) || []) {
    if (info.type !== 'page' || !/amritareports/i.test(info.url || '')) continue;
    log.info(`closing the leftover report tab at ${shortUrl(info.url)}`);
    await withTimeout(client.send('Target.closeTarget', { targetId: info.targetId }), 5000, null)
      .catch(() => { /* already gone */ });
  }
}

/** Resolve with fallback (or reject, if fallback is an Error) if promise has not settled within ms. */
function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => (fallback instanceof Error ? reject(fallback) : resolve(fallback)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Keep the driven tab active. A report opens its own tab and the Pharmacy MIS
 * window can cover Edge, so Edge throttles or freezes the page and the run sat
 * for minutes until Edge was clicked. Front + focus emulation + "active"
 * lifecycle undo that.
 */
async function keepPageActive(page) {
  // Every call is capped so this nicety can never stall the run.
  await withTimeout(page.bringToFront(), 3000, null).catch(() => {});
  try {
    if (!page.__keepActiveClient) {
      page.__keepActiveClient = await withTimeout(page.createCDPSession(), 3000, new Error('timed out'));
    }
    const client = page.__keepActiveClient;
    await withTimeout(client.send('Emulation.setFocusEmulationEnabled', { enabled: true }), 3000, null).catch(() => {});
    await withTimeout(client.send('Page.setWebLifecycleState', { state: 'active' }), 3000, null).catch(() => {});
  } catch { /* best effort — the flags at launch cover most of this anyway */ }
}

/**
 * Back to the portal home before the next report opens. A report run lands on
 * /amritareports/SQRServlet (no menu) and leaves stale handles behind (the next
 * report died with "Argument should belong to the same JavaScript world").
 */
async function returnToPortalHome(page, log) {
  await closeLeftoverReportTabs(page, log);
  await keepPageActive(page);

  // Home URL is not a clean home: the portal leaves the last report's frame inside index.jsp, so only a reload clears it.
  const carryingReportFrames = page.frames()
    .some((f) => !f.detached && /amritareports/i.test(f.url()));
  if (/Core_Common\/index\.jsp/i.test(page.url()) && !carryingReportFrames) return;

  log.info(carryingReportFrames
    ? 'the last report\'s frame is still attached — reloading the portal home'
    : `leaving ${page.url()} — back to the portal home first`);
  await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });

  // Wait for the menu rather than a fixed delay.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const ready = await someFrame(page, () => !!document.querySelector('.sidebar-toggler, .page-sidebar, input[placeholder*="search" i]'));
    if (ready) break;
    await sleep(100);
  }
}

/**
 * Open a report via the portal's menu search: open the sidebar, type the label,
 * click the matching result; fall back to a direct menu-item click if there is no search field.
 */
async function navigateToReport(page, reportLabel, log) {
  const close = log.step(`Opening ${reportLabel}`);
  try {
    await returnToPortalHome(page, log);
    await assertSessionAlive(page);
    await ensureSidebarOpen(page);

    // findFieldByLabel()'s step 3 matches on placeholder text, which covers
    // this field's "Ctrl + i to search..." hint directly once it is actually
    // on screen (ensureSidebarOpen() above is what makes that true). Polled
    // rather than looked up once: the sidebar lives inside its own frame
    // (HisHome.jsp) that can still be mid-render immediately after sign-in.
    let searchBox = null;
    const searchBoxDeadline = Date.now() + 5000;
    while (!searchBox && Date.now() < searchBoxDeadline) {
      searchBox = await findFieldByLabel(page, 'search');
      if (!searchBox) await sleep(100);
    }

    let opened = false;
    if (searchBox) {
      log.debug('typing the report name into the menu search');
      // Re-looked-up inside the retry: the sidebar frame can be replaced before typing.
      await withFreshHandle(async () => {
        const box = (await findFieldByLabel(page, 'search')) || searchBox;
        await focusAndType(page, box, reportLabel);
      }, { label: 'the menu search box' });
      // Wait for the EXACT leaf to appear, not a substring match: the unfiltered
      // "Report" submenu container contains every report name, so a substring check
      // passed before the live filter had narrowed anything. Speculative; the real
      // check is reportPageLooksOpen() below.
      await page.waitForFunction(
        (label) => {
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const want = norm(label);
          return [...document.querySelectorAll('li, a, div[role="option"], td')]
            .some((el) => el.offsetParent !== null && norm(el.textContent) === want);
        },
        // Timer polling, not rAF: a page in a hidden window never paints.
        { timeout: 8000, polling: 100 },
        reportLabel,
      ).catch(() => {});
      opened = await clickMenuItemByText(page, reportLabel)
        || await clickButtonByText(page, reportLabel);

      // Enter is a last resort, and only counts once reportPageLooksOpen() confirms the report is showing.
      if (!opened) {
        log.debug('no result was clickable — trying Enter');
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForNetworkIdle({ idleTime: 800, timeout: TIMEOUTS.reportLoad }).catch(() => null);
        opened = await reportPageLooksOpen(page, reportLabel);
      }
    } else {
      log.debug('no menu search box found — looking for the entry directly');
      opened = await clickMenuItemByText(page, reportLabel)
        || await clickButtonByText(page, reportLabel);
    }

    if (!opened) throw new Error(`${reportLabel} page could not be located.${await describePage(page)}`);

    // Poll for the report itself rather than network idle: the portal runs a
    // background widget (Instabug) that polls continuously, so idle may never
    // happen. Failing here beats failing later on a missing date field.
    const reportOpenDeadline = Date.now() + TIMEOUTS.reportLoad;
    let looksOpen = false;
    while (!looksOpen && Date.now() < reportOpenDeadline) {
      await assertSessionAlive(page);
      looksOpen = await reportPageLooksOpen(page, reportLabel);
      if (!looksOpen) await sleep(100);
    }
    if (!looksOpen) {
      throw new Error(`${reportLabel} page could not be located: the entry was clicked but the report form has not appeared yet.${await describePage(page)}`);
    }
  } catch (err) {
    if (/page could not be located/i.test(err.message) || /session expired/i.test(err.message)) throw err;
    throw new Error(`${reportLabel} page could not be located: ${err.message}`);
  } finally {
    close();
  }
}

/* ------------------------------------------------------------------ *
 * Field setters shared by all three reports
 * ------------------------------------------------------------------ */

/**
 * findFieldByLabel(), retried for a few seconds: the report's title can appear
 * before its form (in a separately-loading inner iframe) has rendered any field.
 */
async function waitForFieldByLabel(page, labelText, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let field = await findFieldByLabel(page, labelText);
  while (!field && Date.now() < deadline) {
    await sleep(100);
    field = await findFieldByLabel(page, labelText);
  }
  return field;
}

async function setDateRange(page, fromIso, toIso, log) {
  const fromText = formatPortalDate(fromIso);
  const toText = formatPortalDate(toIso);

  const fromField = await waitForFieldByLabel(page, 'from date');
  if (!fromField) throw new Error('Could not set From Date.');
  await setDateFieldValue(page, fromField, fromText, 'From Date');
  log.ok(`From Date = ${fromText}`);

  const toField = await waitForFieldByLabel(page, 'to date');
  if (!toField) throw new Error('Could not set To Date.');
  await setDateFieldValue(page, toField, toText, 'To Date');
  log.ok(`To Date = ${toText}`);
}

async function setDateFieldValue(page, handle, portalDateText, fieldName = 'the date field') {
  const readValue = () => handle.evaluate((el) => String(el.value || '').trim());

  // Typed, not assigned: date pickers sync state off keystrokes. Select-all +
  // Backspace first so a pre-filled default or mask cannot stick to the input.
  await focusAndType(page, handle, '', { delay: 0 });
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(portalDateText, { delay: 30 });
  // Escape closes any calendar popup; Tab commits the value.
  await page.keyboard.press('Escape').catch(() => {});
  await page.keyboard.press('Tab').catch(() => {});

  // A wrong day is a wrong report that looks right, so demand the exact date.
  let got = await readValue();
  if (got !== portalDateText) {
    await setInputValue(handle, portalDateText);
    got = await readValue();
  }
  if (got !== portalDateText) {
    throw new Error(`${fieldName} shows "${got}", expected "${portalDateText}"`);
  }
}

async function selectReportFormat(page, format, log) {
  const field = (await findFieldByLabel(page, 'format')) || (await findFieldByLabel(page, 'export'));
  try {
    if (field) {
      await selectDropdownValue(page, field, format);
    } else {
      const clicked = await clickButtonByText(page, format);
      if (!clicked) throw new Error('no matching control found');
    }
  } catch (err) {
    throw new Error(`Could not select ${format}: ${err.message}`);
  }
  log.ok(`${format} selected`);
}

/* ------------------------------------------------------------------ *
 * The three reports
 * ------------------------------------------------------------------ */

/** Navigate to a report, set the date, run `fillForm` for its filters, choose CSV, download. */
async function runReport(page, { label, reportDate, downloadDir, fillForm }, log) {
  const close = log.step(label);
  try {
    await navigateToReport(page, label, log);
    await setDateRange(page, reportDate, reportDate, log);
    await fillForm();
    await selectReportFormat(page, 'CSV', log);
    return await runReportAndWaitForDownload(page, { downloadDir, label }, log);
  } finally {
    close();
  }
}

/** selectAllOptions() with the failure reworded for the person reading the error. */
async function selectAllOrThrow(page, label, log) {
  try { await selectAllOptions(page, label, log); }
  catch (err) { throw new Error(`Could not select all ${label} options: ${err.message}`); }
}

/** Set a single-select combo (found by its label) to `value`, or throw. */
async function setCombo(page, label, value, log) {
  const field = await findFieldByLabel(page, label.toLowerCase());
  if (!field) throw new Error(`Could not set ${label} to ${value}.`);
  try { await selectDropdownValue(page, field, value); }
  catch (err) { throw new Error(`Could not set ${label} to ${value}: ${err.message}`); }
  log.ok(`${label} = ${value}`);
}

// Report label -> output file stem, in run order, with each report's filter setup.
const REPORT_RUNS = [
  {
    label: 'Pharmacy PRQ Details',
    name: 'Pharmacy-PRQ-Details',
    fill: (page, log) => selectAllVisibleMultiSelects(page, log),
  },
  {
    label: 'Purchase Order Detail Report - Pharmacy',
    name: 'Purchase-Order-Detail-Report-Pharmacy',
    fill: async (page, log) => {
      await selectAllOrThrow(page, 'Creation Status', log);
      await selectAllOrThrow(page, 'Processing Status', log);
      await selectAllVisibleMultiSelects(page, log, { exclude: ['Creation Status', 'Processing Status'] });
    },
  },
  {
    label: 'Purchase Report Pharmacy Detail',
    name: 'Purchase-Report-Pharmacy-Detail',
    fill: async (page, log) => {
      // The tax schemes go FIRST, before either combo is touched. An open combo
      // list stays over the form and swallows the first click of the scheme
      // selection, so the DOM looks right but the submitted range is wrong
      // (confirmed live: 227 rows one way, "report is empty" the other).
      await selectAllOrThrow(page, 'Purchase Tax Scheme', log);
      await setCombo(page, 'GRN Type', 'All', log);
      await setCombo(page, 'GRN Status', 'ALL', log);
      await selectAllVisibleMultiSelects(page, log, { exclude: ['Purchase Tax Scheme'] });
    },
  },
];

/* ------------------------------------------------------------------ *
 * Edge location
 * ------------------------------------------------------------------ */

/**
 * Microsoft Edge, which the operator watches the run in (Chromium, driven over
 * the same CDP). Deliberately no fallback to another browser: if Edge is
 * missing, startSession() says so.
 */
function resolveEdgeExecutablePath() {
  const candidates = [
    process.env.PHARMACY_MIS_EDGE_PATH,
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files',
      'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '',
      'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);

  for (const exe of candidates) {
    try { if (fs.existsSync(exe)) return exe; } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * Turn Puppeteer's raw multi-line "Failed to launch the browser process" error
 * into a one-line diagnosis plus a doc link, keeping the original as
 * `technicalDetail` for the log. `Code: 0` means Edge started and exited cleanly
 * before DevTools opened (antivirus/EDR, group policy, or no interactive desktop).
 */
function describeBrowserLaunchFailure(err) {
  const original = err && err.message ? err.message : String(err);
  if (!/Failed to launch the browser process/i.test(original)) return err;

  const codeMatch = original.match(/Code:\s*(-?\d+)/);
  const code = codeMatch ? Number(codeMatch[1]) : null;

  let diagnosis;
  let docLink;
  let docLinkLabel;

  if (code === 0) {
    diagnosis = 'Microsoft Edge started and closed again immediately, before it could be '
      + 'driven. That usually means antivirus/EDR software closed it, an Edge group policy '
      + 'is blocking the automation flags, or the app is running in a session with no '
      + 'interactive desktop (for example a scheduled task not set to "run only when user '
      + 'is logged on"). Try opening Microsoft Edge by hand on this machine first — if that '
      + 'also fails or is blocked, that points at the real cause.';
    docLink = 'https://pptr.dev/troubleshooting';
    docLinkLabel = 'Puppeteer troubleshooting guide';
  } else if (code !== null) {
    diagnosis = `Microsoft Edge exited with Windows process status code ${code} while starting up.`;
    docLink = 'https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55';
    docLinkLabel = 'Windows process status codes (Microsoft docs)';
  } else {
    diagnosis = 'Microsoft Edge could not be started.';
    docLink = 'https://pptr.dev/troubleshooting';
    docLinkLabel = 'Puppeteer troubleshooting guide';
  }

  return Object.assign(new Error(`${diagnosis} (${original.split('\n')[0]})`), {
    docLink,
    docLinkLabel,
    technicalDetail: original,
  });
}

/**
 * A picture of the page the run died on, which is the one thing a text log
 * cannot give the operator. Never throws: a failed screenshot must not
 * replace the real error with a worse one.
 */
async function captureFailure(page, label, log) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = String(label).replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
    const file = path.join(screenshotDir(), `failure_${safe}_${stamp}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log.error(`page at the moment of failure: ${page.url()}`);
    log.error(`screenshot saved: ${file}`);
    return file;
  } catch {
    log.warn('could not capture a screenshot of the failing page');
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Orchestrator
 * ------------------------------------------------------------------ */

/**
 * Launch Edge and authenticate; runs no report. The caller holds the session
 * (src/core/portalSession.js), passes it to runReports(), and closes it with closeSession().
 */
async function startSession(credentials, log) {
  const puppeteer = await loadPuppeteer();

  const executablePath = resolveEdgeExecutablePath();
  if (!executablePath) {
    throw new Error(
      'Microsoft Edge was not found on this machine, and the portal automation runs in Edge '
      + 'so the run can be watched. Install Microsoft Edge, or set PHARMACY_MIS_EDGE_PATH to '
      + 'the full path of msedge.exe.',
    );
  }
  log.info('opening Microsoft Edge — the portal will appear in its own window');

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-mis-edge-'));

  let browser;
  try {
    browser = await puppeteer.launch({
      // Headful on purpose: the operator watches the run.
      headless: false,
      executablePath,
      // Throwaway profile: never touches the operator's own Edge, and no stale portal cookie can authenticate the run.
      userDataDir,
      // null viewport + --start-maximized, else a fixed viewport letterboxes the maximized window.
      defaultViewport: null,
      args: [
        '--start-maximized',
        '--no-first-run',
        '--no-default-browser-check',
        // Else Edge self-relaunches and the spawned process exits with code 0, so Puppeteer never sees DevTools (pptr.dev/troubleshooting).
        '--edge-skip-compat-layer-relaunch',
        // Stop Windows occlusion/throttling when Edge is behind the Pharmacy MIS window (run stalled at "back to the portal home").
        '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
      ],
    });
  } catch (rawErr) {
    const err = describeBrowserLaunchFailure(rawErr);
    if (err.technicalDetail) log.error(err.technicalDetail);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }

  let page;
  try {
    page = (await browser.pages())[0] || await browser.newPage();
    await keepPageActive(page);
    page.setDefaultTimeout(TIMEOUTS.navigation);
    attachDialogCapture(page, log);
    // Awaited: this has to be in place before anything can open a report tab,
    // and it is a few CDP round-trips, not a listener registration.
    await captureDialogsEverywhere(browser, log);
    await login(page, credentials, log);
    return { browser, page, userDataDir, startedAt: Date.now() };
  } catch (err) {
    if (page) err.screenshot = await captureFailure(page, 'login', log);
    await browser.close().catch(() => {});
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/** Close a session started with startSession(). Safe to call more than once, or with null. */
async function closeSession(session) {
  if (!session || !session.browser) return;
  await session.browser.close().catch(() => {});
  // browser.close() can hang up on a wedged Edge; don't leave it running after the app is gone.
  try {
    const proc = typeof session.browser.process === 'function' ? session.browser.process() : null;
    if (proc && proc.exitCode === null) proc.kill();
  } catch { /* already gone */ }
  if (session.userDataDir) try { fs.rmSync(session.userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Sign out of Amrita HIS on the portal's side, best effort, then close the
 * session. Looks for a visible "Logout" / "Sign out" link or button on the
 * current page and clicks it, giving up after a few seconds — the signed-in
 * state lives in a throwaway Edge profile that closeSession() deletes, so the
 * login is dropped locally either way, even if the portal's own control is
 * not found. Never throws.
 */
async function logoutSession(session, log) {
  if (!session || !session.browser) return { portalLoggedOut: false };
  let portalLoggedOut = false;
  try {
    const attempt = (async () => {
      const page = session.page && !session.page.isClosed() ? session.page : null;
      if (!page) return false;
      return page.evaluate(() => {
        const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const match = /^\s*(log\s?out|sign\s?out)\s*$/i;
        const el = [...document.querySelectorAll('a, button, [role="menuitem"]')]
          .find((e) => visible(e) && (match.test(e.textContent || '') || match.test(e.getAttribute('title') || '')));
        if (!el) return false;
        el.click();
        return true;
      });
    })();
    portalLoggedOut = await Promise.race([attempt, new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
    if (portalLoggedOut) await new Promise((resolve) => setTimeout(resolve, 1000)); // let the sign-out request leave
  } catch { /* closing the session below is what matters */ }
  if (log) {
    if (portalLoggedOut) log.info('signed out of the Amrita HIS portal');
    else log.info('no portal logout control found on this page — closing the browser session instead');
  }
  await closeSession(session);
  return { portalLoggedOut };
}

/**
 * Step 2: run the three reports against an already-authenticated session and
 * hand back a summary of the pulled files. Does NOT close the
 * session — the caller does that once it is done with it.
 */
async function runReports(session, { layout }, log) {
  // The session now outlives a run, so the operator may have closed the
  // portal's tab (but not the Edge window) since the last one. The sign-in
  // lives in the browser's cookies, not the tab, so a fresh tab carries on.
  if (session.page.isClosed()) {
    log.info('the portal tab was closed — opening a new one in the same signed-in Edge window');
    const fresh = await session.browser.newPage();
    fresh.setDefaultTimeout(TIMEOUTS.navigation);
    attachDialogCapture(fresh, log);
    session.page = fresh;
  }
  const { page } = session;
  await keepPageActive(page);

  // A fresh copy of the portal home before anything else: the tab may have
  // been sitting since the last run, and if the portal has signed the session
  // out on its side in the meantime, this is where that shows — as one clear
  // "sign in again" rather than a report that could not be found.
  try {
    await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  } catch (err) {
    throw new Error(describeUnreachable(err));
  }
  await assertSessionAlive(page);
  ensureFolder(layout.dayInputsDir, `the folder for ${layout.date.dmy}`);
  const stagingDir = path.join(layout.dayInputsDir, `.portal-download-${Date.now()}`);
  ensureFolder(stagingDir, 'the temporary download folder');

  try {
    // A report the portal said was empty has no file to move, and is recorded
    // by name instead: "no data for this date" differs from "a download went missing".
    const downloaded = [];
    for (const { label, fill } of REPORT_RUNS) { // fail fast; nothing is moved unless all three ran
      downloaded.push(await runReport(page, {
        label, reportDate: layout.date.iso, downloadDir: stagingDir, fillForm: () => fill(page, log),
      }, log));
    }
    const empty = [];
    const files = [];
    REPORT_RUNS.forEach(({ name }, i) => {
      if (downloaded[i]) files.push(movePortalFile(downloaded[i], layout.dayInputsDir, name, layout.date.dmy));
      else empty.push(name);
    });

    // movePortalFile() already throws if a source file is missing, but that
    // failure would arrive as a generic ENOENT — check explicitly so a
    // download that silently never landed on disk gets an error that says so,
    // instead of the run falling through to classify whatever is already in
    // the folder.
    const missing = files.filter((f) => !fs.existsSync(f));
    if (missing.length) {
      throw new Error(
        `${missing.length} expected download(s) did not appear on disk: `
        + `${missing.map((f) => path.basename(f)).join(', ')}. `
        + 'The run was stopped rather than classifying whatever was already in the folder.',
      );
    }

    return { reportDate: layout.date.iso, files, empty };
  } catch (err) {
    err.screenshot = err.screenshot || await captureFailure(page, err.step || 'portal-run', log);
    throw err; // fail fast: nothing past the failing report runs
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  }
}

/**
 * Pull the day's reports into layout.dayInputsDir and hand back a summary the
 * rest of the app can use. `credentials` ({ username, password }) is used
 * only for the duration of this call — nothing here writes it anywhere, and
 * the caller is responsible for not holding onto it longer than needed (see
 * src/ui/server.js).
 */
async function fetchDailyInputs({ layout, credentials = {}, log }) {
  const close = log.step('Portal pull (Puppeteer)');
  try {
    if (!isAvailable()) {
      log.warn('Puppeteer is not installed in this build - the portal pull is unavailable here.');
      log.info('Use "Pick inputs folder" or the file pickers to map files that were pulled or exported by hand.');
      throw new Error(
        'Portal pull unavailable: Puppeteer is not part of this build. '
        + 'Install it (npm install puppeteer) to enable the Amrita HIS automation.',
      );
    }
    if (!credentials.username || !credentials.password) {
      throw new Error('Amrita HIS username and password are required to run the portal pull.');
    }

    ensureFolder(layout.dayInputsDir, `the folder for ${layout.date.dmy}`);
    log.info(`downloads will land in ${layout.dayInputsDir}`);

    const session = await startSession(credentials, log);
    let result;
    try {
      result = await runReports(session, { layout }, log);
    } finally {
      await closeSession(session);
    }

    log.ok(`pulled ${result.files.length} file(s)`);

    return { files: result.files, date: result.reportDate };
  } finally {
    close();
  }
}

module.exports = {
  fetchDailyInputs,
  startSession,
  closeSession,
  logoutSession,
  runReports,
  isAvailable,
  REPORTS,
  // Used by tools/check-alert-capture.js.
  selectAllOptions,
  selectAllVisibleMultiSelects,
  auditFormFields,
  attachDialogCapture,
  captureDialogsEverywhere,
  takeDialog,
};
