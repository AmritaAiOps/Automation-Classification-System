'use strict';

/**
 * Part 1 of the project: the Puppeteer pull from Amrita HIS.
 *
 * WHAT THIS FILE DOES
 * --------------------
 * One authenticated Puppeteer session:
 *   1. logs in to Amrita HIS with the username/password the application UI
 *      collected (the user never types into the browser — see login() below)
 *   2. Purchase Report Pharmacy Detail  -> CSV download  (GRN Type/Status = All)
 *   3. Received Items Pharmacy          -> CSV download
 *   4. Pharmacy PO Browser              -> Search, Delivery/Creation Status =
 *      ALL, Limit = 999, and reads back "Total rows"
 *
 * The two downloaded CSVs land in layout.dayInputsDir, exactly where the
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
const path = require('path');
const { pathToFileURL } = require('url');
const { ensureDir, formatPortalDate } = require('../core/paths');

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
  { key: 'PURCHASE', label: 'Purchase Report Pharmacy Detail', exportAs: 'CSV' },
  { key: 'RECEIVED', label: 'Received Items Pharmacy', exportAs: 'CSV' },
  { key: 'POBROWSER', label: 'Pharmacy PO Browser (Total rows)', exportAs: 'Search' },
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
  download: 120000,
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
async function findFieldByLabel(page, labelText, { exact = false } = {}) {
  const handle = await page.evaluateHandle((label, wantExact) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const want = norm(label);
    const matches = (text) => (wantExact ? norm(text) === want : norm(text).includes(want));
    const visible = (el) => !!(el && el.offsetParent !== null && !el.disabled);

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

  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    return null;
  }
  return el;
}

/** Set a form field's value the way a framework-controlled input expects — through the native setter, so React/Angular/Vue see the change. */
async function setInputValue(page, handle, value) {
  await page.evaluate((el, val) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, handle, value);
}

/** Click whatever on the page has visible text matching label (button, link, submit input). */
async function clickButtonByText(page, label) {
  return page.evaluate((text) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const want = norm(text);
    const els = document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]');
    for (const el of els) {
      const t = el.tagName === 'INPUT' ? el.value : el.textContent;
      if ((norm(t) === want || norm(t).includes(want)) && el.offsetParent !== null && !el.disabled) {
        el.click();
        return true;
      }
    }
    return false;
  }, label);
}

/** Set a <select>, or a button/radio group, to the option whose text matches valueText. */
async function selectDropdownValue(page, handle, valueText) {
  const tag = await page.evaluate((el) => el.tagName, handle);
  if (tag === 'SELECT') {
    const ok = await page.evaluate((el, val) => {
      const norm = (s) => (s || '').trim().toLowerCase();
      const opt = [...el.options].find((o) => norm(o.textContent) === norm(val) || norm(o.value) === norm(val));
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, handle, valueText);
    if (!ok) throw new Error(`option "${valueText}" not found in the dropdown`);
    return;
  }
  await handle.click();
  const clicked = await clickButtonByText(page, valueText);
  if (!clicked) throw new Error(`option "${valueText}" not found`);
}

/**
 * Every visible checkbox/option inside a multi-select control, or a
 * <select multiple>, ticked ON. Used for "Delivery Status = ALL" and
 * "Creation Status = ALL" — the option list is read from the live DOM rather
 * than a hard-coded list, so it stays correct if the portal adds a status.
 */
async function selectAllOptions(page, labelText, log) {
  const field = await findFieldByLabel(page, labelText);
  if (!field) throw new Error(`field not found`);

  const tag = await page.evaluate((el) => el.tagName, field);

  if (tag === 'SELECT') {
    const count = await page.evaluate((el) => {
      const opts = [...el.options].filter((o) => o.value !== '');
      opts.forEach((o) => { o.selected = true; });
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return opts.length;
    }, field);
    if (!count) throw new Error('the dropdown has no options to select');
    log.ok(`${labelText} = ALL (${count} option(s))`);
    return;
  }

  // A custom widget: open it, then tick every option it reveals — preferring
  // the widget's own "select all" control if it has one.
  await field.click().catch(() => {});
  await sleep(200);
  const result = await page.evaluate(() => {
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

/* ------------------------------------------------------------------ *
 * Downloads
 * ------------------------------------------------------------------ */

function snapshotDir(dir) {
  ensureDir(dir);
  return new Set(fs.readdirSync(dir));
}

/** Point Chromium's download machinery at dir for the lifetime of this page. */
async function routeDownloadsTo(page, dir) {
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
}

/**
 * Wait for a file that was not present in `before` to appear in dir and stop
 * growing. No fixed sleeps: this polls a real filesystem condition (a new,
 * size-stable file) rather than waiting a guessed number of seconds.
 */
async function waitForNewDownload(dir, before, { timeout = TIMEOUTS.download, label = 'report' } = {}) {
  const deadline = Date.now() + timeout;

  let candidate = null;
  while (Date.now() < deadline) {
    const names = fs.readdirSync(dir).filter((n) => !n.endsWith('.crdownload') && !n.endsWith('.tmp'));
    const fresh = names.find((n) => !before.has(n));
    if (fresh) { candidate = path.join(dir, fresh); break; }
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

  const clicked = await clickButtonByText(page, 'Run Report');
  if (!clicked) throw new Error(`${label} download timed out: the "Run Report" control was not found.`);
  log.info('report executed, waiting for the download…');

  const file = await waitForNewDownload(downloadDir, before, { timeout: TIMEOUTS.download, label });
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
 * Open a report by name. Prefers a navigation search box, if the portal shell
 * has one (the video shows one) — types the report's label and clicks the
 * matching suggestion. Falls back to clicking a matching menu item directly.
 */
async function navigateToReport(page, reportLabel, log) {
  const close = log.step(`Opening ${reportLabel}`);
  try {
    await assertSessionAlive(page);

    const searchBox = await findFieldByLabel(page, 'search')
      || await page.$('input[type="search"], input[placeholder*="search" i]');

    let opened = false;
    if (searchBox) {
      await searchBox.click({ clickCount: 3 });
      await searchBox.type(reportLabel, { delay: 15 });
      await page.waitForFunction(
        (label) => {
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const want = norm(label);
          return [...document.querySelectorAll('li, a, div[role="option"], td')]
            .some((el) => el.offsetParent !== null && norm(el.textContent).includes(want));
        },
        { timeout: 8000 },
        reportLabel,
      ).catch(() => {});
      opened = await clickButtonByText(page, reportLabel);
      if (!opened) { await page.keyboard.press('Enter').catch(() => {}); opened = true; }
    } else {
      opened = await clickButtonByText(page, reportLabel);
    }

    if (!opened) throw new Error(`${reportLabel} page could not be located.`);

    await page.waitForNetworkIdle({ idleTime: 800, timeout: TIMEOUTS.reportLoad }).catch(() => null);
    await assertSessionAlive(page);
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

async function setDateRange(page, fromIso, toIso, log) {
  const fromText = formatPortalDate(fromIso);
  const toText = formatPortalDate(toIso);

  const fromField = await findFieldByLabel(page, 'from date');
  if (!fromField) throw new Error('Could not set From Date.');
  await setDateFieldValue(page, fromField, fromText);
  log.ok(`From Date = ${fromText}`);

  const toField = await findFieldByLabel(page, 'to date');
  if (!toField) throw new Error('Could not set To Date.');
  await setDateFieldValue(page, toField, toText);
  log.ok(`To Date = ${toText}`);
}

async function setDateFieldValue(page, handle, portalDateText) {
  await handle.click({ clickCount: 3 });
  await setInputValue(page, handle, '');
  await handle.type(portalDateText, { delay: 15 });
  await page.keyboard.press('Tab').catch(() => {});
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
  await field.click({ clickCount: 3 });
  await setInputValue(page, field, String(value));
  const got = await page.evaluate((el) => el.value, field);
  if (String(got).trim() !== String(value)) {
    throw new Error(`Could not set Limit to ${value} (field now shows "${got}").`);
  }
  log.ok(`Limit = ${value}`);
}

async function readTotalRows(page, log) {
  await page.waitForFunction(
    () => /total\s*rows/i.test(document.body.innerText),
    { timeout: TIMEOUTS.search },
  ).catch(() => {});

  const text = await page.evaluate(() => document.body.innerText);
  const match = /total\s*rows\s*[:\-]?\s*(\d+)/i.exec(text);
  if (!match) throw new Error('Total rows value could not be located.');

  const total = Number(match[1]);
  log.ok(`Total rows = ${total}`);
  return total;
}

/* ------------------------------------------------------------------ *
 * The three reports
 * ------------------------------------------------------------------ */

async function runPurchaseReport(page, { reportDate, downloadDir }, log) {
  const close = log.step('Purchase Report Pharmacy Detail');
  try {
    await navigateToReport(page, 'Purchase Report Pharmacy Detail', log);
    await setDateRange(page, reportDate, reportDate, log);

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

    await selectReportFormat(page, 'CSV', log);
    return await runReportAndWaitForDownload(page, { downloadDir, label: 'Purchase Report Pharmacy Detail' }, log);
  } finally {
    close();
  }
}

async function runReceivedItemsReport(page, { reportDate, downloadDir }, log) {
  const close = log.step('Received Items Pharmacy');
  try {
    await navigateToReport(page, 'Received Items Pharmacy', log);
    await setDateRange(page, reportDate, reportDate, log);
    await selectReportFormat(page, 'CSV', log);
    return await runReportAndWaitForDownload(page, { downloadDir, label: 'Received Items Pharmacy' }, log);
  } finally {
    close();
  }
}

async function runPOBrowser(page, { reportDate }, log) {
  const close = log.step('Pharmacy PO Browser');
  try {
    await navigateToReport(page, 'Pharmacy PO Browser', log);
    await setDateRange(page, reportDate, reportDate, log);

    try { await selectAllOptions(page, 'Delivery Status', log); }
    catch (err) { throw new Error(`Could not select all Delivery Status options: ${err.message}`); }

    try { await selectAllOptions(page, 'Creation Status', log); }
    catch (err) { throw new Error(`Could not select all Creation Status options: ${err.message}`); }

    await setLimit(page, 999, log);

    const clicked = await clickButtonByText(page, 'Search');
    if (!clicked) throw new Error('Pharmacy PO Browser search did not complete: the Search control was not found.');
    log.info('search submitted, waiting for results…');
    await page.waitForNetworkIdle({ idleTime: 800, timeout: TIMEOUTS.search }).catch(() => null);
    await assertSessionAlive(page);
    log.ok('search complete');

    const totalRows = await readTotalRows(page, log);
    return { totalRows };
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
  const executablePath = resolveChromiumExecutablePath();
  const browser = await puppeteer.launch({
    // PHARMACY_MIS_HEADFUL=1 for a visible browser during selector work on the
    // admin machine; every normal run is headless — nothing for the user to
    // click or type into, per the "no manual browser interaction" rule.
    headless: process.env.PHARMACY_MIS_HEADFUL ? false : 'new',
    defaultViewport: { width: 1440, height: 900 },
    ...(executablePath ? { executablePath } : {}),
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUTS.navigation);
    await login(page, credentials, log);
    return { browser, page, startedAt: Date.now() };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

/** Close a session started with startSession(). Safe to call more than once, or with null. */
async function closeSession(session) {
  if (!session || !session.browser) return;
  await session.browser.close().catch(() => {});
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
    const purchaseReportFile = await runPurchaseReport(
      page,
      { reportDate: layout.date.iso, downloadDir: stagingDir },
      log,
    );
    const receivedItemsFile = await runReceivedItemsReport(
      page,
      { reportDate: layout.date.iso, downloadDir: stagingDir },
      log,
    );
    const poBrowser = await runPOBrowser(page, { reportDate: layout.date.iso }, log);

    const files = [
      movePortalFile(purchaseReportFile, layout.dayInputsDir, 'Purchase-Report-Pharmacy-Detail', layout.date.iso),
      movePortalFile(receivedItemsFile, layout.dayInputsDir, 'Received-Items-Pharmacy', layout.date.iso),
    ];

    return { reportDate: layout.date.iso, files, poBrowser };
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

    const present = result.files.filter((f) => fs.existsSync(f));
    if (present.length !== result.files.length) {
      log.warn(`${result.files.length - present.length} expected download(s) did not appear on disk`);
    }
    log.ok(`pulled ${present.length} file(s)`);

    return { files: present, date: result.reportDate, poBrowser: result.poBrowser };
  } finally {
    close();
  }
}

module.exports = {
  fetchDailyInputs,
  pullFromPortal,
  startSession,
  closeSession,
  runReports,
  login,
  verifyAuthentication,
  isAvailable,
  REPORTS,
};
