'use strict';

/**
 * Part 1 of the project: the Puppeteer pull from Amrita HIS.
 *
 * WHAT THIS FILE DOES
 * --------------------
 * One authenticated Puppeteer session:
 *   1. logs in to Amrita HIS with the username/password the application UI
 *      collected (the user never types into the browser — see login() below)
 *   2. Pharmacy PRQ Details             -> CSV download
 *   3. Purchase Order Detail Report - Pharmacy -> CSV download
 *   4. Purchase Report Pharmacy Detail  -> CSV download  (GRN Type/Status = All)
 *
 * The three downloaded CSVs land in layout.dayInputsDir, exactly where the
 * existing mapping pipeline (src/pipeline.js) already looks for its inputs.
 * That pipeline identifies files by the COLUMNS they carry, not by filename
 * (see src/core/detect.js), so nothing here needs to know or guess which of
 * the three known report kinds (PRQ / PO / GRN) a download turns out to be —
 * classification, mapping and Excel generation are all untouched.
 *
 * WHAT STILL NEEDS A LIVE RUN TO CONFIRM
 * ---------------------------------------
 * The portal is reachable only from the admin machine, so the selectors below
 * could not be developed against the real DOM. Two areas are on solid ground
 * because they come straight from the reference screenshot / are a well-known
 * system (Amrita HIS's sign-in page is Keycloak, whose form IDs are stable
 * across deployments): SELECTORS.login below.
 *
 * Everything past sign-in (report navigation, the date fields, GRN Type/
 * Status, the CSV format control, the two multi-selects, Limit, Search, and
 * the "Total rows" readout) is implemented against LABEL TEXT rather than any
 * guessed ID/class, which is the most robust strategy without DOM access, but
 * it is exactly the part that needs confirming on the admin machine — see
 * README.md "Live-portal testing" for the checklist. If a label wording is
 * slightly different from what is written here, only the string passed to
 * findFieldByLabel()/clickButtonByText() needs to change; the rest of the
 * flow does not.
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
 * Load Puppeteer.
 *
 * It cannot be require()d: since v23 the package is ESM only ("type":
 * "module"), and its own exports map points the "require" condition at the
 * very same ESM file, so require() fails with ERR_REQUIRE_ESM while
 * require.resolve() still happily returns the path. That asymmetry is worth
 * knowing about — it is why isAvailable() above can answer true for a build
 * that cannot actually load it.
 *
 * Resolved to a path and imported as a file URL rather than by bare specifier,
 * because a Windows path is not a valid URL and import() demands one. Inside
 * the packaged application this path lands within app.asar, which Electron's
 * ESM loader reads correctly.
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
 * The application's own home URL. Amrita HIS redirects an unauthenticated
 * visitor to its Keycloak sign-in page on its own, so this only needs to be
 * somewhere inside the app; it does not have to be the login URL itself.
 * Overridable so the admin machine can point at its real environment without
 * editing source.
 *
 * It has to be the HIS host (aefbd), not the Keycloak one (ahisfbd). Asking
 * HIS for this page is what produces the 302 carrying client_id, redirect_uri
 * and state into Keycloak, and it is that redirect_uri that brings the browser
 * back into HIS once the credentials are accepted. Keycloak's own host answers
 * nothing useful on its own — its root is a 503, and even when it answers,
 * signing in there leaves the session at Keycloak rather than inside HIS.
 */
const PORTAL_URL = process.env.AMRITA_HIS_URL
  || 'https://aefbd.amritahospitals.org/his/Jsp/Core_Common/index.jsp?task=off';

const TIMEOUTS = {
  navigation: 45000,
  login: 30000,
  reportLoad: 30000,
  // Generous on purpose: the report is run with all 52 purchase tax schemes
  // selected rather than the portal's default handful, and the portal opens it
  // in a tab of its own that sits there loading for minutes on a busy day.
  // Overridable for a machine or a date where even this is not enough.
  download: Number(process.env.PHARMACY_MIS_DOWNLOAD_TIMEOUT_MS) || 300000,
  search: 30000,
};

/**
 * Selectors, isolated in one place so a change on the live portal is a
 * one-line fix rather than a hunt through the flow functions (see rule in
 * the project brief: "if selectors need to be updated later, isolate them in
 * a logical area rather than scattering them throughout the code").
 *
 * The login selectors are Keycloak's own default theme IDs, which is what the
 * reference screenshot shows this portal running (the URL bar reads
 * .../auth/realms/.../protocol/openid-connect/auth). Keycloak's login form
 * has used these exact IDs for years across deployments: #username,
 * #password, #kc-login. A name= fallback is included in case the theme has
 * been customised.
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

/** Find the input/select/textarea associated with a visible label's text. */
/**
 * Every frame of the page, the main document first.
 *
 * This portal keeps its URL at index.jsp while swapping reports into the page,
 * which is the shape of an application that puts its real content in a frame.
 * A field search that only ever looked at the top-level document would find the
 * sidebar and nothing else — no date fields, no Run Report button — which is
 * exactly the "Could not set From Date." that follows a report opening fine.
 *
 * Frames are queried in order and the first match wins, so a form in the main
 * document still behaves exactly as it did before.
 */
function allFrames(page) {
  const main = page.mainFrame();
  return [main, ...page.frames().filter((f) => f !== main)];
}

/**
 * Run an in-page finder against every frame, returning the first element found
 * along with the frame holding it. Handles stay bound to their own frame, so
 * anything done with one afterwards has to go through handle.evaluate() rather
 * than page.evaluate() — a handle from a child frame is not something the main
 * frame's realm can accept.
 */
/**
 * Run a predicate in each frame, stopping at the first that returns truthy.
 * What "click the thing that says X" means when the page is a frameset: try
 * every document until one of them has it.
 */
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
 * True for the errors that mean "this handle refers to a document that is no
 * longer there" — as opposed to anything about what the page contains.
 *
 * Worth recognising by name because of how one of them reads. A handle taken
 * from a frame that has since been replaced does not fail with anything about
 * staleness: it fails with "Argument should belong to the same JavaScript world
 * as target object", which sounds like a bug in how the call was made. It is
 * not. It is a dead handle, and the answer is to look the element up again.
 */
function isStaleHandleError(err) {
  return /same JavaScript world|Execution context was destroyed|Cannot find context|detached Frame|Target closed/i
    .test(err && err.message ? err.message : '');
}

async function findInFrames(page, pageFunction, ...args) {
  for (const frame of allFrames(page)) {
    // A frame the portal has already discarded still shows up in page.frames()
    // for a while, and it will still answer a search — with an element nothing
    // can be done with afterwards.
    if (frame.detached) continue;

    let handle;
    try {
      handle = await frame.evaluateHandle(pageFunction, ...args);
    } catch {
      continue; // a frame can navigate or be cross-origin mid-search
    }
    const el = handle.asElement();
    if (el) {
      // Proof the handle is live before it is handed to a caller that will act
      // on it. evaluateHandle() succeeding is not that proof: a frame swapped
      // out between the search and the use returns a handle that only fails
      // later, at the point of use, where it reads as an unrelated bug.
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
 * Run something that looks an element up and then acts on it, retrying from the
 * lookup if the handle dies underneath it.
 *
 * The portal reloads the frame its menu lives in while the search is being
 * typed into it, so the gap between "found the box" and "typed in the box" is a
 * real one that a document swap can land in. Re-finding is the only repair —
 * the old handle cannot be revived — so the lookup has to be inside the retry,
 * not before it.
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

async function findFieldByLabel(page, labelText, { exact = false } = {}) {
  return findInFrames(page, (label, wantExact) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    // Whitespace is stripped entirely for the actual comparison, not just
    // collapsed: confirmed against a live run that this portal's own report
    // forms label fields "FromDate" and "GrnStatus" — no space at all —
    // while the readable label text passed in at each call site ("from
    // date", "grn status") does have one. Squashing both sides down to the
    // same bare-letters form is what makes those the same word rather than
    // two that merely share most of their letters.
    const squash = (s) => norm(s).replace(/\s+/g, '');
    const want = norm(label);
    const wantSquashed = squash(label);
    const matches = (text) => (wantExact
      ? norm(text) === want || squash(text) === wantSquashed
      : norm(text).includes(want) || squash(text).includes(wantSquashed));
    // offsetParent alone is not enough: a field inside a collapsed panel can
    // still report one while occupying no space at all, and a field like that
    // is one Puppeteer refuses to click ("Node is either not clickable or not
    // an Element"). Require an actual box before calling anything visible.
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
 * Put the caret in a field and type into it.
 *
 * Deliberately never uses ElementHandle.click(), which drives a real mouse at
 * the element's coordinates and therefore fails outright on anything it cannot
 * scroll into view or that has no box — the sidebar search sits in a scrolling
 * panel and was doing exactly that. Focusing through the DOM and then typing on
 * the keyboard produces the same keystrokes for the page without depending on
 * where the field happens to be on screen.
 *
 * Typed at 90ms/character, not the 15ms this used to be: this portal wires up
 * a barcode-scanner listener that treats a fast burst of keystrokes as a scan
 * rather than typing, confirmed live by watching it fire "Creating custom
 * barcode event" for chunks of a report name typed at 15ms/character into the
 * menu search. When that happens the field's own live-filter never narrows
 * the list at all, so the wrong (huge, unfiltered) menu entry ends up looking
 * like the only candidate later. 90ms/character is comfortably above typical
 * barcode-scanner detection thresholds (usually tens of ms) while still far
 * faster than hand typing.
 */
async function focusAndType(page, handle, text) {
  await handle.evaluate((el) => {
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.focus();
    if ('value' in el) el.value = '';
  });
  // The keyboard belongs to the page and types wherever the focus is, so this
  // reaches a field inside a frame without any extra ceremony.
  await page.keyboard.type(text, { delay: 90 });
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
 * Click an element the way a person does: move the mouse there, pause, press
 * down, pause, release — rather than a same-tick mousedown+mouseup (what both
 * ElementHandle.click() and a synthetic dispatchEvent sequence produce).
 *
 * Confirmed necessary against a live run of the real portal: its menu-search
 * result entries have a genuine jQuery `click` handler bound (verified via
 * jQuery's own event data), the element is exactly where computed, and yet
 * neither ElementHandle.click() nor a dispatched MouseEvent sequence made the
 * report open — nothing happened and nothing threw, so it read as a silent,
 * unexplained navigation failure. Slowing the click down to two real,
 * separately-timed mouse events is what the site's own script actually
 * responds to. Falls back to the handle's own in-page click when a bounding
 * box cannot be resolved (e.g. the element or an ancestor frame has since
 * scrolled or gone away) — better than doing nothing at all.
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
    await sleep(100);
    await page.mouse.down();
    await sleep(120);
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
 * Click an entry in the navigation menu — a search result or a menu leaf.
 *
 * Separate from clickButtonByText because a menu entry is usually not a button:
 * in this portal's sidebar the search results come back as list items, and
 * clickButtonByText's button/anchor selector would miss them entirely while the
 * wait that precedes it (which does look at list items) reported a match. That
 * mismatch is silent — it reads as "the page could not be located".
 *
 * Picks the deepest element whose text matches, so that a click lands on the
 * entry itself rather than the panel containing it, and prefers an exact match
 * over a partial one: "Purchase Report Pharmacy Detail" must not lose to some
 * container that happens to hold it alongside every other menu item.
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

    // An anchor is the thing actually wired to navigate — confirmed against a
    // live run that this portal's own click handler is bound to the <a>
    // itself, not to the plain-text <label> inside it that "fewest
    // descendants" alone would pick (a leaf label has 0 descendants, its
    // wrapping <a> has 2, so the sort above puts the label first even though
    // it is not the thing this needs to click). closest() checks the element
    // itself before walking up, so this still returns the leaf when it is
    // already the anchor, and only widens outward when it is not.
    return pool[0].closest('a') || pool[0].querySelector('a') || pool[0];
  }, label);
  if (!target) return false;
  await realClick(page, target);
  return true;
}

/** Set a <select>, or a button/radio group, to the option whose text matches valueText. */
async function selectDropdownValue(page, handle, valueText) {
  const tag = await handle.evaluate((el) => el.tagName);
  if (tag === 'SELECT') {
    const ok = await handle.evaluate((el, val) => {
      const norm = (s) => (s || '').trim().toLowerCase();
      const opt = [...el.options].find((o) => norm(o.textContent) === norm(val) || norm(o.value) === norm(val));
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, valueText);
    if (!ok) throw new Error(`option "${valueText}" not found in the dropdown`);
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
    // A native <select> opened by a synthetic click renders its option list as
    // a separate OS popup outside the page's DOM, so nothing above can ever
    // find or click it — this is what leaves the panel visibly open forever.
    // Escape closes that popup either way, and setting .value directly still
    // works even while it is open, so this is tried as a last resort before
    // giving up. If handle itself isn't a real select this quietly does
    // nothing and the throw below still fires with useful detail attached.
    await page.keyboard.press('Escape').catch(() => {});
    const fallback = await handle.evaluate((el, val) => {
      if (el.tagName !== 'SELECT') return false;
      const norm = (s) => (s || '').trim().toLowerCase();
      const opt = [...el.options].find((o) => norm(o.textContent) === norm(val) || norm(o.value) === norm(val));
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, valueText).catch(() => false);
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
 * Every visible checkbox/option inside a multi-select control, or a
 * <select multiple>, ticked ON. Used for "Delivery Status = ALL" and
 * "Creation Status = ALL" — the option list is read from the live DOM rather
 * than a hard-coded list, so it stays correct if the portal adds a status.
 */
/**
 * An option with no label is not a choice a person can make.
 *
 * The Purchase Tax Scheme list opens with one: blank text, and a value that is
 * every other option's id joined by commas. It is the list's own internal
 * "everything" entry, it renders as an empty row nobody clicks. Other HIS
 * multi-selects expose an explicit "ALL" row; that is also an alias rather
 * than an individual value. Real options only, here and in the audit, so both
 * agree on what "all of them" means.
 */
const REAL_OPTIONS = (el) => [...el.options]
  .map((o, i) => ({ i, text: (o.textContent || '').trim(), value: o.value }))
  .filter((o) => o.text !== '' && !/^all$/i.test(o.text));

/**
 * Select every real option in a <select multiple> by clicking the first and
 * shift-clicking the last — the gesture a person makes, and the only one this
 * portal actually registers.
 *
 * Setting option.selected in the DOM does not work here, and fails in the worst
 * possible way. This portal is SpagoBI, whose form is an ExtJS widget layer
 * over the real <select>: it submits from its own record of the selection, not
 * from the element. Assigning .selected updates the element and nothing else,
 * so the DOM reads back a confident "52/52 selected" while the request on the
 * wire carries PurchaseTaxScheme="21" — one scheme. Captured on the wire, both
 * halves, against a date the reference export proves has 198 rows:
 *
 *   programmatic .selected  ->  DOM 52/52  ->  sent "21"              ->  empty
 *   click + shift-click     ->  DOM 51/52  ->  sent "21,36,35,...,39" ->  227 rows
 *
 * That is the whole reason this report came back empty every day, and why the
 * field audit cheerfully certified it as a genuine zero: the audit was reading
 * the same DOM the portal ignores.
 *
 * Falls back to the DOM assignment if the options cannot be clicked (no box —
 * a list scrolled out of view or not rendered). The fallback is known not to
 * register with the widget, so it says so rather than reporting success.
 */
async function selectAllByRealClicks(page, field, labelText, log) {
  const options = await field.evaluate(REAL_OPTIONS);
  if (!options.length) throw new Error('the dropdown has no options to select');

  // Anything a previous field left hanging over the form has to go before the
  // first click, or that click is spent closing it instead of anchoring the
  // range — and the DOM will still look right afterwards, so nothing downstream
  // would notice. Escape closes an open combo list; the ordering in
  // the report runners select fields before execution, so there should be nothing to close, and this is
  // here so that stops being something the caller has to get right.
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(150);

  const handles = await field.$$('option');
  const first = options[0].i;
  const last = options[options.length - 1].i;

  const clickOption = async (index, withShift) => {
    const handle = handles[index];
    if (!handle) throw new Error(`no option at index ${index}`);
    await handle.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
    await sleep(120);
    const box = await handle.boundingBox();
    if (!box) throw new Error(`option ${index} has no clickable box`);
    if (withShift) await page.keyboard.down('Shift');
    // Aimed left of centre: a long option label can run wider than the list,
    // and the middle of the box can land outside the visible list area.
    await page.mouse.click(box.x + Math.min(box.width / 2, 60), box.y + box.height / 2);
    if (withShift) await page.keyboard.up('Shift');
    await sleep(120);
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
 * Every field on the report form as it stands the moment before the report is
 * run: what it is, and for a list how much of it is actually selected.
 *
 * The specific question this exists to answer: a multi-select left on the
 * portal's default selection narrows the report silently, and the empty result
 * that follows looks exactly like a day on which nothing was purchased. One is
 * a bug and the other is a zero, and nothing in the downloaded file
 * distinguishes them. Any list that is not fully selected is called out here by
 * name, so "the report is empty" can be trusted before it is believed.
 *
 * Diagnostic, behind PHARMACY_MIS_AUDIT_FIELDS, so a normal customer run is
 * not buried in it.
 *
 * Know what this cannot see. It reads the DOM, and on this portal the DOM is
 * not what gets submitted — the ExtJS layer over the form keeps its own record
 * and sends that. A selection made by assigning option.selected shows here as
 * fully selected while the request carries one value, and this audit signed off
 * on exactly that for every run until it was caught on the wire. A clean audit
 * therefore means "nothing on the form looks narrow", not "the request is
 * right". What makes the selection trustworthy is that selectAllByRealClicks()
 * makes it the way a person does and fails loudly if it does not take.
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
    // Not fatal on its own — the driven page still has its own handler, and a
    // report that downloads normally never raises an alert. Worth saying out
    // loud, because it turns a clean "the report is empty" into a timeout.
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
          // Whoever gets there first wins; the loser is told no dialog is
          // showing, which is the right outcome and not worth reporting.
          await session.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        });
        await session.send('Page.enable');
      }
    } catch (err) {
      log.debug(`alert capture could not be armed for ${targetInfo.url || 'a new tab'}: ${err.message}`);
    } finally {
      // Always, and even after a failure above: this handler is what holds a
      // paused target, and a target left paused is a tab that never loads.
      // Puppeteer resumes it too, so this is a duplicate on the happy path.
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

function snapshotDir(dir) {
  ensureDir(dir);
  return new Set(fs.readdirSync(dir));
}

/**
 * Point Chromium's download machinery at dir.
 *
 * Set on the browser rather than the page, because the portal can deliver a
 * report through a window it opens rather than the one being driven, and a
 * per-page setting does not follow it there. Falls back to the page-level call
 * on anything that will not accept the browser-wide one.
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

    // A silent two-minute wait is indistinguishable from a hang. Saying where
    // the browser actually is every 15s turns "it timed out" into something
    // that can be read afterwards.
    if (log && Date.now() >= nextHeartbeat) {
      nextHeartbeat = Date.now() + 15000;
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      let where = '';
      try {
        const pages = await page.browser().pages();
        where = pages.map((p) => shortUrl(p.url())).join(' | ');
      } catch { where = '(could not read the open pages)'; }
      log.info(`still waiting after ${seconds}s — open tab(s): ${where}`);
    }

    // The portal saying something is an answer, and waiting out the full
    // download timeout after it has already spoken only buries what it said.
    const dialog = page && takeDialog(page);
    if (dialog) {
      const err = new Error(`${label}: the portal answered "${dialog.message}" instead of producing a file.`);
      err.portalDialog = dialog.message;
      err.emptyReport = EMPTY_REPORT.test(dialog.message);
      throw err;
    }

    await sleep(500);
  }
  if (!candidate) throw new Error(`${label} download timed out.`);

  let lastSize = -1;
  while (Date.now() < deadline) {
    let size;
    try { size = fs.statSync(candidate).size; } catch { size = -1; }
    if (size === lastSize && size > 0) return candidate;
    lastSize = size;
    await sleep(400);
  }
  throw new Error(`${label} download timed out (file never finished writing).`);
}

async function runReportAndWaitForDownload(page, { downloadDir, label }, log) {
  ensureDir(downloadDir);
  const before = snapshotDir(downloadDir);
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
    // "The report is empty" is only worth believing when every list on the form
    // was fully selected. A narrowed filter produces exactly the same message,
    // and the two are indistinguishable from the message alone — so this is
    // trusted as a genuine zero only against an audit that came back clean, and
    // is a hard failure otherwise. Silently passing the second case through as
    // a zero would put a wrong number in the master report that looks exactly
    // like a right one.
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

/** Move a staged download into the day's inputs folder under a stable, human-readable name — never the browser's own (possibly reused) filename. */
function movePortalFile(sourcePath, destDir, label, dateIso) {
  const ext = path.extname(sourcePath) || '.csv';
  const dest = path.join(destDir, `${label}_${dateIso}${ext}`);
  fs.renameSync(sourcePath, dest);
  return dest;
}

/* ------------------------------------------------------------------ *
 * Login
 * ------------------------------------------------------------------ */

/** The host part of a URL, for logs that should not carry query strings around. */
function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

/**
 * host + path, for naming a page in a log line. A tab that has only just been
 * created reports its URL as the empty string, which new URL() throws on — and
 * a throw inside a progress line is how the one observation worth having ("a
 * second tab opened and is still loading") got swallowed on a live run.
 */
function shortUrl(url) {
  if (!url) return '(blank tab)';
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname;
  } catch {
    return String(url).slice(0, 60);
  }
}

/**
 * Turn a failed navigation into something the person at the desk can act on.
 * "Did not connect" and "connected but was refused" need to look different in
 * the log: the first is theirs to fix (network, VPN, portal down), the second
 * is not.
 */
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
    // Landing somewhere else is the expected case, not a problem: HIS answers
    // with a redirect into Keycloak. Saying where it ended up is what separates
    // "the portal is down" from "the portal is up and rejected the password"
    // for whoever is reading the log afterwards.
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

    // Filled via type(), not setInputValue()/evaluate() — Keycloak's own form
    // reads the value straight from the field on submit, and typing (rather
    // than injecting a value) is what keeps this indistinguishable from a
    // person filling the form, which is the safest default against portals
    // that watch for real keystrokes. Nothing here is logged: not the
    // username, not the password, not its length.
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

    // Prefer the portal's own wording when it gave one (it may say something
    // more specific than "wrong credentials" — account locked, disabled,
    // etc.) — otherwise the only honest thing left on the login page still
    // showing itself is that the credentials were rejected.
    if (errorText) throw new Error(`Login failed: ${errorText}`);
    throw new Error('Incorrect username or password. Please check your Amrita HIS credentials and try again.');
  }

  log.debug(`left the sign-in page — now at ${page.url()}`);
}

/** Thrown mid-run if a navigation unexpectedly lands back on the sign-in form. */
async function assertSessionAlive(page) {
  const backAtLogin = /\/protocol\/openid-connect\/auth/i.test(page.url())
    || await page.$(SELECTORS.login.username).then(Boolean).catch(() => false);
  if (backAtLogin) throw new Error('Amrita HIS session expired. Please run the automation again.');
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
 * Open the portal's own left-hand menu, if a fresh session or a previous
 * report navigation left it collapsed to its icon-only rail.
 *
 * Confirmed against a live run of the real portal: right after sign-in the
 * page's <body> already carries the theme's own "page-sidebar-closed" class
 * (this is a stock Metronic-style admin template, identifiable by that exact
 * class name), which is what makes the menu search field 0×0 and genuinely
 * un-typeable rather than merely hard to find. The reference recording
 * (reference/Log in to site-fbd...mp4) shows the sidebar already open —
 * which is why that recording never had to deal with this at all.
 *
 * The toggle itself is a plain `<div class="sidebar-toggler">`, but a real
 * Puppeteer mouse click on it (ElementHandle.click(), which clicks at its
 * on-screen coordinates) was confirmed, live, to do nothing — a native DOM
 * `.click()` call is what the template's own script actually responds to.
 * This mirrors why focusAndType() below avoids coordinate-based clicks too.
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
    await sleep(150);
  }
}

/**
 * Open a report by name via the portal's own menu search — confirmed against
 * a live run: type the report's label into the menu search field (opening the
 * sidebar first, if collapsed — see ensureSidebarOpen()) and click the
 * matching result. Falls back to clicking a matching menu item directly if
 * the search field cannot be found at all.
 */
/**
 * Back to the application's own home page before the next report is opened.
 *
 * Running a report takes the page to the portal's report servlet
 * (/amritareports/SQRServlet), which carries no menu and no sidebar at all —
 * so the next report's menu search has nothing to find, and every handle left
 * over from the previous page belongs to a document that no longer exists.
 * Confirmed live: the run that downloaded the first report died opening the
 * second with "Argument should belong to the same JavaScript world as target
 * object", from exactly that.
 */
/**
 * Close the report tabs the portal opened and never closed.
 *
 * Running a report leaves its own tab (/amritareports/SQRServlet) standing.
 * Left alone these accumulate one per report, and they are not merely untidy:
 * confirmed against a live run that the driven page picks up an extra frame for
 * each one (3 frames, then 4), findFieldByLabel() then matches inside one of
 * those leftovers, and the next report dies on the handle it got back with
 * "Argument should belong to the same JavaScript world as target object". That
 * is the failure that killed the third report of a three-report run.
 */
async function closeLeftoverReportTabs(page, log) {
  let pages;
  try { pages = await page.browser().pages(); } catch { return; }
  for (const other of pages) {
    if (other === page) continue;
    let url = '';
    try { url = other.url(); } catch { continue; }
    if (!/amritareports/i.test(url)) continue;
    log.debug(`closing the leftover report tab at ${shortUrl(url)}`);
    await other.close().catch(() => { /* already gone */ });
  }
}

async function returnToPortalHome(page, log) {
  await closeLeftoverReportTabs(page, log);

  // Being on the home page's URL is not the same as being on a clean copy of
  // it. The portal loads each report into a frame of index.jsp and leaves that
  // frame behind, so after a report has run, the URL still says home while the
  // document underneath is carrying the last report's form. Searching that for
  // the next report's fields is what finds a control in a document on its way
  // out. A reload is the only thing that actually clears them.
  const carryingReportFrames = page.frames()
    .some((f) => !f.detached && /amritareports/i.test(f.url()));
  if (/Core_Common\/index\.jsp/i.test(page.url()) && !carryingReportFrames) return;

  log.debug(carryingReportFrames
    ? 'the last report\'s frame is still attached — reloading the portal home'
    : `leaving ${page.url()} — back to the portal home first`);
  await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.navigation });
  await sleep(500);
}

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
      if (!searchBox) await sleep(200);
    }

    let opened = false;
    if (searchBox) {
      log.debug('typing the report name into the menu search');
      // Looked up again inside the retry rather than reusing searchBox: the
      // sidebar frame can be replaced between finding the box and typing into
      // it, and a handle from the outgoing document cannot be revived.
      await withFreshHandle(async () => {
        const box = (await findFieldByLabel(page, 'search')) || searchBox;
        await focusAndType(page, box, reportLabel);
      }, { label: 'the menu search box' });
      // Speculative, not a hard requirement: this only waits for a suggestion
      // to appear before trying to click one, and a real check follows either
      // way (opened / reportPageLooksOpen below), so a timeout here just means
      // "no suggestion showed up" rather than a failure worth stopping for.
      //
      // Requires an EXACT leaf match, not a substring one: confirmed against a
      // live run that the unfiltered menu category (e.g. the whole "Report"
      // submenu, ~100 entries deep) is itself a substring match for almost any
      // report name, since its own concatenated text contains every entry's
      // name somewhere inside it. A substring check here was satisfied by that
      // huge container the instant typing started — before the site's live
      // filter had actually narrowed anything down — so clickMenuItemByText()
      // ran too early and found no exact match yet, only that same container.
      // Waiting for the real, specific leaf to exist is what actually signals
      // the filter has finished.
      await page.waitForFunction(
        (label) => {
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const want = norm(label);
          return [...document.querySelectorAll('li, a, div[role="option"], td')]
            .some((el) => el.offsetParent !== null && norm(el.textContent) === want);
        },
        { timeout: 8000 },
        reportLabel,
      ).catch(() => {});
      opened = await clickMenuItemByText(page, reportLabel)
        || await clickButtonByText(page, reportLabel);

      // Enter is a last resort, and unlike before it is not taken on trust:
      // the portal has to actually show the report before this counts as open
      // (reportPageLooksOpen just below), so the network-idle wait here is
      // also left speculative — the real gate is that check, not this wait.
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

    // Polled against the real signal rather than gated on network silence:
    // confirmed against a live run that this portal carries a background
    // widget (Instabug's feedback SDK, visible in its own DOM) that polls
    // continuously, so a genuinely successful navigation can still see 800ms
    // of network idle never actually happen. reportPageLooksOpen() below is
    // what a report having opened actually means here, so that is the thing
    // this waits for, not an idle window this portal may never produce.
    // Clicking something is not the same as the report having opened, and
    // failing here — while the menu is still the thing that went wrong —
    // beats failing later on a missing date field with no hint of why it is
    // missing.
    const reportOpenDeadline = Date.now() + TIMEOUTS.reportLoad;
    let looksOpen = false;
    while (!looksOpen && Date.now() < reportOpenDeadline) {
      await assertSessionAlive(page);
      looksOpen = await reportPageLooksOpen(page, reportLabel);
      if (!looksOpen) await sleep(300);
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
 * findFieldByLabel(), retried for a few seconds rather than checked once.
 *
 * Needed specifically right after navigateToReport() returns: confirmed
 * against a live run that reportPageLooksOpen() (the thing navigateToReport()
 * waits on) can see the report's own title before the report's actual form —
 * living inside a further, separately-loading iframe of its own — has
 * rendered a single field. A screenshot taken at exactly that failure showed
 * the report frame still blank white. The title appearing is a real signal
 * that navigation succeeded, just not a promise that the form is there yet.
 */
async function waitForFieldByLabel(page, labelText, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let field = await findFieldByLabel(page, labelText);
  while (!field && Date.now() < deadline) {
    await sleep(200);
    field = await findFieldByLabel(page, labelText);
  }
  return field;
}

async function setDateRange(page, fromIso, toIso, log) {
  const fromText = formatPortalDate(fromIso);
  const toText = formatPortalDate(toIso);

  const fromField = await waitForFieldByLabel(page, 'from date');
  if (!fromField) throw new Error('Could not set From Date.');
  await setDateFieldValue(page, fromField, fromText);
  log.ok(`From Date = ${fromText}`);

  const toField = await waitForFieldByLabel(page, 'to date');
  if (!toField) throw new Error('Could not set To Date.');
  await setDateFieldValue(page, toField, toText);
  log.ok(`To Date = ${toText}`);
}

async function setDateFieldValue(page, handle, portalDateText) {
  // Typed rather than assigned: these are date pickers, and they keep their
  // own state in sync off keystrokes. Tab afterwards commits the value the way
  // leaving the field by hand does.
  await focusAndType(page, handle, portalDateText);
  await page.keyboard.press('Tab').catch(() => {});

  // A picker that reformats or rejects what was typed leaves something else
  // behind, and finding that out here beats a report built on the wrong day.
  const got = await handle.evaluate((el) => el.value);
  if (!String(got || '').trim()) throw new Error('the field would not take the date');
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

async function setLimit(page, value, log) {
  const field = await findFieldByLabel(page, 'limit');
  if (!field) throw new Error(`Could not set Limit to ${value}.`);
  await focusAndType(page, field, String(value));
  await setInputValue(field, String(value));
  const got = await field.evaluate((el) => el.value);
  if (String(got).trim() !== String(value)) {
    throw new Error(`Could not set Limit to ${value} (field now shows "${got}").`);
  }
  log.ok(`Limit = ${value}`);
}

async function readTotalRows(page, log) {
  const readAll = async () => {
    const texts = [];
    for (const frame of allFrames(page)) {
      try { texts.push(await frame.evaluate(() => document.body.innerText)); } catch { /* frame went away */ }
    }
    return texts.join('\n');
  };

  const deadline = Date.now() + TIMEOUTS.search;
  let text = await readAll();
  while (!/total\s*rows/i.test(text) && Date.now() < deadline) {
    await sleep(400);
    text = await readAll();
  }

  const match = /total\s*rows\s*[:\-]?\s*(\d+)/i.exec(text);
  if (!match) throw new Error('Total rows value could not be located.');

  const total = Number(match[1]);
  log.ok(`Total rows = ${total}`);
  return total;
}

/* ------------------------------------------------------------------ *
 * The three reports
 * ------------------------------------------------------------------ */

async function runGrnReport(page, { reportDate, downloadDir }, log) {
  const close = log.step('Purchase Report Pharmacy Detail');
  try {
    await navigateToReport(page, 'Purchase Report Pharmacy Detail', log);
    await setDateRange(page, reportDate, reportDate, log);

    // The tax schemes go FIRST, before either combo is touched, and the order
    // is load-bearing. selectDropdownValue() opens a combo's dropdown list, and
    // that list stays open over the form: the first of the two clicks this
    // selection needs then lands on the overlay and is spent dismissing it
    // rather than anchoring the range. The browser still paints a selection
    // afterwards, so the DOM reads 51/51 and looks fine, while the widget's own
    // record — the thing actually submitted — anchored somewhere else.
    //
    // Confirmed on a live run against 2026-08-08, a date with 198 known rows:
    // schemes chosen before the combos gave 227 lines, the same selection made
    // after them gave "the report is empty", with an identical-looking form and
    // an identical-looking log line in both cases.
    //
    // Leaving the list as found is not an option either — it narrows the report
    // to whichever schemes happened to be highlighted, and the short result
    // that comes back is indistinguishable from a quiet day once it is a number
    // in a spreadsheet.
    try { await selectAllOptions(page, 'Purchase Tax Scheme', log); }
    catch (err) { throw new Error(`Could not select all Purchase Tax Scheme options: ${err.message}`); }

    const grnType = await findFieldByLabel(page, 'grn type');
    if (!grnType) throw new Error('Could not set GRN Type to All.');
    try { await selectDropdownValue(page, grnType, 'All'); }
    catch (err) { throw new Error(`Could not set GRN Type to All: ${err.message}`); }
    log.ok('GRN Type = All');

    const grnStatus = await findFieldByLabel(page, 'grn status');
    if (!grnStatus) throw new Error('Could not set GRN Status to ALL.');
    try { await selectDropdownValue(page, grnStatus, 'ALL'); }
    catch (err) { throw new Error(`Could not set GRN Status to ALL: ${err.message}`); }
    log.ok('GRN Status = ALL');

    await selectAllVisibleMultiSelects(page, log, {
      exclude: ['Purchase Tax Scheme'],
    });

    await selectReportFormat(page, 'CSV', log);
    return await runReportAndWaitForDownload(page, { downloadDir, label: 'Purchase Report Pharmacy Detail' }, log);
  } finally {
    close();
  }
}

async function runPrqReport(page, { reportDate, downloadDir }, log) {
  const close = log.step('Pharmacy PRQ Details');
  try {
    await navigateToReport(page, 'Pharmacy PRQ Details', log);
    await setDateRange(page, reportDate, reportDate, log);
    await selectAllVisibleMultiSelects(page, log);
    await selectReportFormat(page, 'CSV', log);
    return await runReportAndWaitForDownload(page, { downloadDir, label: 'Pharmacy PRQ Details' }, log);
  } finally {
    close();
  }
}

async function runPoReport(page, { reportDate, downloadDir }, log) {
  const close = log.step('Purchase Order Detail Report - Pharmacy');
  try {
    await navigateToReport(page, 'Purchase Order Detail Report - Pharmacy', log);
    await setDateRange(page, reportDate, reportDate, log);

    try { await selectAllOptions(page, 'Creation Status', log); }
    catch (err) { throw new Error(`Could not select all Creation Status options: ${err.message}`); }

    try { await selectAllOptions(page, 'Processing Status', log); }
    catch (err) { throw new Error(`Could not select all Processing Status options: ${err.message}`); }

    await selectAllVisibleMultiSelects(page, log, {
      exclude: ['Creation Status', 'Processing Status'],
    });
    await selectReportFormat(page, 'CSV', log);
    return await runReportAndWaitForDownload(
      page,
      { downloadDir, label: 'Purchase Order Detail Report - Pharmacy' },
      log,
    );
  } finally {
    close();
  }
}

/* ------------------------------------------------------------------ *
 * Chromium location
 * ------------------------------------------------------------------ */

/**
 * Puppeteer needs its own Chromium at runtime — Electron's own Chromium is
 * not something Puppeteer can drive. .puppeteerrc.cjs pins `npm install`'s
 * download to a project-relative .chromium-cache/ folder rather than the OS
 * user-cache directory Puppeteer uses by default, specifically so it can be
 * shipped inside the exe (see tools/build.js's "Package Puppeteer's
 * Chromium" step, which copies that folder to <app>/resources/chromium-cache
 * via electron-builder's extraResources).
 *
 * This resolves the actual chrome executable by scanning rather than by
 * reconstructing Puppeteer's internal cache path format (which has changed
 * across major versions) — robust to exactly one browser being installed,
 * which is what a project pinned to one Puppeteer version always has.
 */
function resolveChromiumExecutablePath() {
  const candidates = [
    path.join(__dirname, '..', '..', '.chromium-cache'), // development / npm start
  ];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'chromium-cache')); // packaged exe

  for (const dir of candidates) {
    const found = findChromeExecutable(dir);
    if (found) return found;
  }
  return null; // let Puppeteer fall back to its own default resolution
}

function findChromeExecutable(dir) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/^chrome\.exe$/i.test(entry.name) || entry.name === 'chrome') return full;
    }
  }
  return null;
}

/**
 * Microsoft Edge, which is what the operator watches the run happen in. Edge
 * is Chromium under the skin, so Puppeteer drives it over the same CDP it
 * uses for its own bundled Chromium — the only difference is the executable.
 *
 * Deliberately not falling back to the bundled Chromium above: seeing the run
 * in the browser the operator recognises is the point, and a silent swap to
 * something that merely looks like Chrome would defeat it. If Edge is
 * missing, startSession() says so rather than substituting something else.
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

/** Best-effort removal of the throwaway Edge profile created for one session. */
function cleanupUserDataDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Puppeteer's own "Failed to launch the browser process" error already ends
 * with a link to https://pptr.dev/troubleshooting, but that generic guide
 * does not explain what the exit code itself means, and the raw multi-line
 * message is not something to put in a one-line status bar. This picks the
 * exit code out of that message and attaches a short, specific diagnosis plus
 * the most relevant documentation link, while keeping the original message
 * (with its own embedded stderr and link) as `technicalDetail` for the log
 * file and the Documents error copy.
 *
 * `Code: 0` is its own case, not a crash: the browser process started and
 * exited cleanly before Puppeteer ever saw its DevTools port open, which is
 * not something Chromium or Puppeteer document a specific meaning for — in
 * practice it means something else closed it (antivirus/EDR), blocked it
 * (an Edge group policy), or it never had anywhere to render (a session with
 * no interactive desktop, e.g. a scheduled task not set to "run only when
 * user is logged on").
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
 * Step 1 of the "Sign In, then Run" flow: launch a browser and authenticate.
 * Does NOT run any report — verifyAuthentication() (inside login()) has
 * already confirmed the sign-in succeeded by the time this returns, so the
 * caller can show "✓ Logged in to Amrita HIS" before anything else happens.
 *
 * Returns a session object the caller holds onto (src/core/portalSession.js
 * on the GUI side) and later passes to runReports(). The caller owns closing
 * it via closeSession() — on success after runReports(), on the user
 * cancelling, or after an idle timeout.
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
      // Headful and in front, on purpose: the operator watches the run happen
      // rather than trusting a text log alone, and can see exactly where it
      // stopped if something goes wrong.
      headless: false,
      executablePath,
      // A throwaway profile: the operator's own Edge windows, tabs, cookies
      // and signed-in identity are never touched, and a stale portal cookie
      // from a previous day cannot silently authenticate this run.
      userDataDir,
      // null viewport + --start-maximized fills the screen with the window
      // and the window with the page — a fixed viewport would leave the
      // maximized frame showing a small, letterboxed page instead.
      defaultViewport: null,
      args: [
        '--start-maximized',
        '--no-first-run',
        '--no-default-browser-check',
        // Without this, Edge on Windows does its own "compatibility layer"
        // self-relaunch on startup: the process Puppeteer just spawned exits
        // immediately (cleanly, code 0, nothing on stderr) once it hands off
        // to the real browser process, but Puppeteer is watching the first
        // process's stderr for the DevTools line and never sees it — surfacing
        // as "Failed to launch the browser process: Code: 0" even though Edge
        // itself is fine. This is Puppeteer's own documented fix for exactly
        // that failure (https://pptr.dev/troubleshooting).
        '--edge-skip-compat-layer-relaunch',
      ],
    });
  } catch (rawErr) {
    const err = describeBrowserLaunchFailure(rawErr);
    if (err.technicalDetail) log.error(err.technicalDetail);
    cleanupUserDataDir(userDataDir);
    throw err;
  }

  let page;
  try {
    page = (await browser.pages())[0] || await browser.newPage();
    await page.bringToFront();
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
    cleanupUserDataDir(userDataDir);
    throw err;
  }
}

/** Close a session started with startSession(). Safe to call more than once, or with null. */
async function closeSession(session) {
  if (!session || !session.browser) return;
  await session.browser.close().catch(() => {});
  cleanupUserDataDir(session.userDataDir);
}

/**
 * Step 2: run the three reports against an already-authenticated session and
 * hand back the same summary pullFromPortal() does. Does NOT close the
 * session — the caller does that once it is done with it.
 */
async function runReports(session, { layout }, log) {
  const { page } = session;
  ensureDir(layout.dayInputsDir);
  const stagingDir = path.join(layout.dayInputsDir, `.portal-download-${Date.now()}`);
  ensureDir(stagingDir);

  try {
    const prqFile = await runPrqReport(
      page,
      { reportDate: layout.date.iso, downloadDir: stagingDir },
      log,
    );
    const poFile = await runPoReport(
      page,
      { reportDate: layout.date.iso, downloadDir: stagingDir },
      log,
    );
    const grnFile = await runGrnReport(
      page,
      { reportDate: layout.date.iso, downloadDir: stagingDir },
      log,
    );

    // A report the portal said was empty has no file to move, and is recorded
    // by name instead — the distinction between "no data for this date" and "a
    // download that went missing" is the whole point of tracking it separately.
    const empty = [];
    const files = [];
    for (const [file, name] of [
      [prqFile, 'Pharmacy-PRQ-Details'],
      [poFile, 'Purchase-Order-Detail-Report-Pharmacy'],
      [grnFile, 'Purchase-Report-Pharmacy-Detail'],
    ]) {
      if (file) files.push(movePortalFile(file, layout.dayInputsDir, name, layout.date.iso));
      else empty.push(name);
    }

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
 * One authenticated session, start to finish: sign in and run all three
 * reports, closing the browser before returning either way. This is what the
 * single-shot CLI path uses (src/portalRun.js) — the GUI instead calls
 * startSession() and runReports() separately so it can show "signed in,
 * verified" before the reports run (see src/ui/server.js's /api/login and
 * /api/run-portal).
 */
async function pullFromPortal({ layout, credentials, log }) {
  const session = await startSession(credentials, log);
  try {
    return await runReports(session, { layout }, log);
  } finally {
    await closeSession(session);
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

    ensureDir(layout.dayInputsDir);
    log.info(`downloads will land in ${layout.dayInputsDir}`);

    const result = await pullFromPortal({ layout, credentials, log });

    // runReports() already stops the run if a download never landed on disk,
    // so this is belt-and-braces — kept as a hard stop rather than a warning
    // so a future change to runReports() cannot quietly reopen this gap.
    const missing = result.files.filter((f) => !fs.existsSync(f));
    if (missing.length) {
      throw new Error(
        `${missing.length} expected download(s) did not appear on disk: `
        + `${missing.map((f) => path.basename(f)).join(', ')}. `
        + 'The run was stopped rather than classifying whatever was already in the folder.',
      );
    }
    log.ok(`pulled ${result.files.length} file(s)`);

    return { files: result.files, date: result.reportDate };
  } finally {
    close();
  }
}

module.exports = {
  reportPageLooksOpen,
  describePage,
  fetchDailyInputs,
  pullFromPortal,
  startSession,
  closeSession,
  runReports,
  login,
  verifyAuthentication,
  isAvailable,
  REPORTS,
  navigateToReport,
  clickMenuItemByText,
  ensureSidebarOpen,
  findFieldByLabel,
  focusAndType,
  realClick,
  selectAllOptions,
  selectAllVisibleMultiSelects,
  auditFormFields,
  // Exported so the alert-capture path can be exercised against a local page
  // that alerts on load, without standing up a whole portal session.
  attachDialogCapture,
  captureDialogsEverywhere,
  takeDialog,
  // Exported for tools/inspect-purchase-form.js, which drives the Purchase
  // Report form one control at a time to see what each one actually does to
  // the result.
  setDateRange,
  selectDropdownValue,
  selectAllOptions,
  selectReportFormat,
  runReportAndWaitForDownload,
  waitForFieldByLabel,
  allFrames,
};
