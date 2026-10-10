'use strict';

const { resolveLayout, enumerateDates } = require('./core/paths');
const { runDailyReport } = require('./pipeline');

/**
 * Pull one date's three reports through an already-signed-in session, then map
 * them into the master. Always resolves with a result object; a failure is
 * { ok: false, error, stage: 'login' | 'portal' | 'automation', screenshot, docLink }.
 * A pull that stopped partway never reaches classification — it must not run
 * against whatever was already sitting in the folder from a previous day.
 */
async function runOneDate(session, archiveRoot, date, sink, { dryRun = false } = {}) {
  // eslint-disable-next-line global-require
  const scraper = require('./scraper');
  const layout = resolveLayout(archiveRoot, date);
  let result;
  try {
    let pull;
    try {
      pull = await scraper.runReports(session, { layout }, makeLogger(sink));
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      throw Object.assign(new Error(message), {
        stage: LOGIN_FAILURE.test(message) ? 'login' : 'portal',
        screenshot: err.screenshot || null,
        docLink: err.docLink || null,
        docLinkLabel: err.docLinkLabel || null,
      });
    }
    result = await runDailyReport({ archiveRoot, reportDate: layout.date.iso, dryRun: !!dryRun }, sink);
    if (result.ok) result.portalFiles = pull.files;
    else result.stage = 'automation';
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    result = {
      ok: false,
      error: message,
      stage: err.stage || (LOGIN_FAILURE.test(message) ? 'login' : 'automation'),
      screenshot: err.screenshot || null,
      docLink: err.docLink || null,
      docLinkLabel: err.docLinkLabel || null,
      log: [],
    };
  }
  result.date = layout.date.iso;
  return result;
}

/**
 * The same pull-then-map flow for every date in [fromDate, toDate], signing in
 * ONCE and reusing the session. Dates run one after another (they all write
 * the same monthly master). A failed date is recorded and the loop carries on,
 * except for a sign-in failure or a dead browser, which ends it.
 *
 * Returns { ok, results: [one runDailyReport-shaped result per attempted date],
 * skipped: [dates never attempted] }.
 */
async function runWithPortalPullRange({ archiveRoot, fromDate, toDate, credentials, dryRun }, sink) {
  // eslint-disable-next-line global-require
  const scraper = require('./scraper');
  const dates = enumerateDates(fromDate, toDate || null);
  const out = sink || (() => {});
  const results = [];

  let session;
  try {
    session = await scraper.startSession(credentials, makeLogger(out));
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, results: [{ ok: false, date: dates[0], error: message, stage: 'login', log: [] }], skipped: dates.slice(1) };
  }

  try {
    for (const date of dates) {
      out({ ts: new Date().toISOString(), level: 'step', indent: 0, message: `Date ${results.length + 1} of ${dates.length}: ${date}`, detail: null });
      const result = await runOneDate(session, archiveRoot, date, out, { dryRun });
      results.push(result);
      if (result.stage === 'login' || !session.browser.connected) break;
    }
  } finally {
    await scraper.closeSession(session);
  }

  return { ok: results.every((r) => r.ok) && results.length === dates.length, results, skipped: dates.slice(results.length) };
}

/**
 * Everything that means "the run never got past sign-in", so the UI can put the
 * user back at the credentials form instead of blaming the report automation.
 * These are the exact openings thrown by src/scraper/index.js's login() and
 * describeUnreachable() — the two must be changed together.
 */
const LOGIN_FAILURE = new RegExp('^(' + [
  'Login failed',
  'Incorrect username or password',
  'Could not reach Amrita HIS', // never connected: DNS, refused, timeout, certificate
  'Connected to Amrita HIS, but its sign-in form was not found',
  'Amrita HIS login page could not be loaded', // wording used before the messages above
  'Amrita HIS username and password are required',
  'Amrita HIS session expired', // signed out on the portal's side between runs
  'Portal pull unavailable',
].join('|') + ')', 'i');

/** A minimal object matching core/logger.js's Logger surface, streaming straight to a plain sink function. */
function loggerFns(sink) {
  const emit = (level) => (message, detail) => sink({
    ts: new Date().toISOString(), level, indent: 1, message: String(message), detail: detail === undefined ? null : detail,
  });
  return { debug: emit('debug'), info: emit('info'), ok: emit('ok'), warn: emit('warn'), error: emit('error') };
}
function logStep(sink, message) {
  sink({ ts: new Date().toISOString(), level: 'step', indent: 0, message: String(message), detail: null });
  return () => {};
}

/** Exported so the GUI's split /api/login + /api/run-portal routes (src/ui/server.js) can log through the same shape as the single-shot CLI path above. */
function makeLogger(sink) {
  return { step: (m) => logStep(sink, m), ...loggerFns(sink) };
}

module.exports = { runWithPortalPullRange, runOneDate, makeLogger, LOGIN_FAILURE };
