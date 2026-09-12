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
      log: { step: (m) => logStep(trackedSink, m), ...loggerFns(trackedSink) },
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, error: message, stage: LOGIN_FAILURE.test(message) ? 'login' : 'automation', log: entries };
  }

  const result = await runDailyReport({ archiveRoot, reportDate, dryRun: !!dryRun }, sink || (() => {}));
  if (result.ok) result.poBrowser = pull.poBrowser;
  else result.stage = 'automation';
  return result;
}

const LOGIN_FAILURE = /^(Login failed|Incorrect username or password|Amrita HIS login page could not be loaded|Amrita HIS username and password are required)/i;

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

module.exports = { runWithPortalPull, makeLogger, LOGIN_FAILURE };
