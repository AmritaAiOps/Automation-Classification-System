'use strict';

const { resolveLayout } = require('./core/paths');
const { runDailyReport } = require('./pipeline');

/**
 * "Sign In & Run": pull the day's reports from Amrita HIS with Puppeteer
 * (src/scraper/index.js), then hand off to the existing mapping pipeline
 * exactly as a manually-picked inputs folder would — the scraper leaves the
 * CSVs in layout.dayInputsDir, which is the same folder the pipeline scans by
 * default when no inputFolder is given.
 *
 * Shared by the GUI (src/ui/server.js) and the headless/CLI runner
 * (src/app/headless.js) so there is exactly one place that wires the portal
 * pull to the pipeline.
 *
 * `credentials.password` lives only in this call's stack frame: it is passed
 * straight through to the scraper and never assigned anywhere that would
 * outlive this function, never logged, and never part of the returned
 * result.
 */
async function runWithPortalPull({ archiveRoot, reportDate, credentials, dryRun }, sink) {
  // eslint-disable-next-line global-require
  const scraper = require('./scraper');
  const entries = [];
  const trackedSink = (entry) => { entries.push(entry); if (sink) sink(entry); };

  let pull;
  try {
    const layout = resolveLayout(archiveRoot, reportDate);
    pull = await scraper.fetchDailyInputs({
      layout,
      credentials,
      log: makeLogger(trackedSink),
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, error: message, stage: LOGIN_FAILURE.test(message) ? 'login' : 'automation', log: entries };
  }

  const result = await runDailyReport({ archiveRoot, reportDate, dryRun: !!dryRun }, sink || (() => {}));
  if (result.ok) result.portalFiles = pull.files;
  else result.stage = 'automation';
  return result;
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
  'Amrita HIS login page could not be loaded', // sign-in button missing
  'Amrita HIS username and password are required',
  'Amrita HIS session expired', // signed out on the portal's side between runs
  'Portal pull unavailable',
].join('|') + ')', 'i');

/** A minimal object matching core/logger.js's Logger surface, streaming straight to a plain sink function. */
function makeLogger(sink) {
  const emit = (level, indent) => (message, detail) => sink({
    ts: new Date().toISOString(), level, indent, message: String(message), detail: detail === undefined ? null : detail,
  });
  const log = { step: (m) => { emit('step', 0)(m); return () => {}; } };
  for (const level of ['debug', 'info', 'ok', 'warn', 'error']) log[level] = emit(level, 1);
  return log;
}

module.exports = { runWithPortalPull, makeLogger, LOGIN_FAILURE };
