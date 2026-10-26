'use strict';

const http = require('http');
const crypto = require('crypto');
const { version } = require('../../package.json');
const { runDailyReport } = require('../pipeline');
const { pickFolder, pickFile, revealInExplorer, openWithDefaultApp } = require('./dialogs');
const { resolveLayout, getPreviousCalendarDay, getToday, formatPortalDate } = require('../core/paths');
const { page } = require('./page');
const { log } = require('../core/appdata');
const { loadSettings, saveSettings, rememberUsername } = require('../core/settings');
const portalSession = require('../core/portalSession');
const { makeLogger, LOGIN_FAILURE } = require('../portalRun');

/**
 * The portal scraper is the admin-only half of the project and is not part of
 * the customer build. It is loaded defensively and behind a lazy call so that
 * a missing or broken optional module can never be the reason the customer's
 * app fails to start — the mapping half stays fully usable either way.
 */
function scraperInfo() {
  try {
    // eslint-disable-next-line global-require
    const scraper = require('../scraper');
    return { available: scraper.isAvailable() };
  } catch (err) {
    log.warn('optional portal scraper unavailable: ' + err.message);
    return { available: false };
  }
}

const errMessage = (err) => (err && err.message ? err.message : String(err));

/**
 * The app's local server. Zero dependencies beyond node:http on purpose - it
 * binds to 127.0.0.1 on an OS-assigned port, and every request must carry a
 * token minted at startup, so nothing else on the machine can drive it.
 *
 * Log lines reach the window over Server-Sent Events as the run happens, which
 * is what makes the app show its working live rather than after the fact.
 */

const TOKEN = crypto.randomBytes(24).toString('hex');

/** Open SSE connections. One shared timer keeps them all alive. */
const streams = new Set();
let keepAlive = null;

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) {
    try {
      res.write(frame);
    } catch {
      streams.delete(res);
    }
  }
}

function ping() {
  for (const res of streams) { try { res.write(': ping\n\n'); } catch { /* dropped */ } }
}

function dropStream(res) {
  streams.delete(res);
  if (!streams.size) { clearInterval(keepAlive); keepAlive = null; }
}

// Edge closed or signed out by hand: the window has to hear about it
// and go back to the sign-in fields.
portalSession.onEnded(() => {
  log.info('Amrita HIS session ended (signed out in Edge, or Edge closed)');
  broadcast('session-ended', { at: new Date().toISOString() });
});

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 1024 * 256) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (err) { reject(new Error(`Malformed request body: ${err.message}`)); }
    });
    req.on('error', reject);
  });
}

/** One run at a time - two concurrent writes to the same master would race. */
let runInFlight = false;

/**
 * A failed run is the likeliest way this application "does not work" from
 * the customer's point of view, so it is recorded the same way a startup
 * failure is: technical log, and a readable copy in Documents. Shared by the
 * manual and Amrita HIS run paths so both get the same treatment.
 */
function logRunOutcome(result, archiveRoot, reportDate, inputFolder) {
  if (result.ok) {
    log.info('run ok — ' + result.date + ' ' + result.write.mode + ' row ' + result.write.row
      + ' in ' + result.layout.masterFile);
    return;
  }
  log.error(
    [
      'The daily report could not be generated.',
      '',
      'What went wrong:  ' + result.error,
      'Archive folder:   ' + (archiveRoot || '(not set)'),
      'Report date:      ' + (reportDate || '(not set)'),
      'Inputs folder:    ' + (inputFolder === null ? '(Amrita HIS portal pull)' : (inputFolder || '(not set)')),
      ...(result.screenshot ? ['Screenshot:       ' + result.screenshot] : []),
      ...(result.docLink ? [`More info:        ${result.docLinkLabel || result.docLink} — ${result.docLink}`] : []),
    ].join('\n'),
    (result.log || [])
      .map((e) => e.level.toUpperCase().padEnd(5) + ' ' + '  '.repeat(e.indent || 0) + e.message)
      .join('\n'),
  );
}

/**
 * One date of /api/run-portal, after the portal pull: `outcome` is that date's
 * entry from scraper.runReportsMulti() ({ files, error }). Classifies and writes
 * the master row, then reports the result. `more` = further dates follow.
 */
async function finishPortalDate(session, outcome, more) {
  const { layout } = outcome;
  const sink = (entry) => broadcast('log', entry);
  let result;
  try {
    // A pull that stopped partway through never has files worth classifying —
    // don't classify whatever was already sitting in the folder from a previous day.
    if (outcome.error) throw outcome.error;
    result = await runDailyReport({ archiveRoot: layout.root, reportDate: layout.date.iso, dryRun: false }, sink);
    if (result.ok) result.portalFiles = outcome.files;
    else result.stage = 'automation';
  } catch (err) {
    const message = errMessage(err);
    result = {
      ok: false,
      error: message,
      date: layout.date.iso,
      stage: LOGIN_FAILURE.test(message) ? 'login' : (err === outcome.error ? 'portal' : 'automation'),
      screenshot: err.screenshot || null,
      docLink: err.docLink || null,
      docLinkLabel: err.docLinkLabel || null,
      log: [],
    };
  }
  // Signed out on the portal's side (or the browser went away mid-run):
  // nothing left worth keeping open, and the window has to ask for a fresh
  // sign-in. Anything else keeps the session for the next Run.
  if (result.stage === 'login' || !session.browser.connected) {
    if (portalSession.get() === session) await portalSession.clear();
  }
  result.signedIn = portalSession.isActive();
  result.more = !!more && result.signedIn; // the window waits for the last date before wrapping up
  broadcast('run-end', result);
  logRunOutcome(result, layout.root, layout.date.iso, null);
  return result;
}

const routes = {
  /** Manual / preview run — files already pulled or exported by hand. */
  async 'POST /api/run'(body) {
    if (runInFlight) throw new Error('A run is already in progress.');
    runInFlight = true;
    broadcast('run-start', { at: new Date().toISOString(), dryRun: !!body.dryRun });
    try {
      const result = await runDailyReport(
        {
          archiveRoot: body.archiveRoot,
          inputFolder: body.inputFolder || null,
          files: body.files || {},
          dryRun: !!body.dryRun,
        },
        (entry) => broadcast('log', entry),
      );
      broadcast('run-end', result);
      logRunOutcome(result, body.archiveRoot, result.date, body.inputFolder);
      return result;
    } finally {
      runInFlight = false;
    }
  },

  /**
   * Step 1 of "Sign In, then Run": authenticate with Amrita HIS and stop
   * there — no report is pulled yet. On success the browser stays open
   * (held in src/core/portalSession.js) so /api/run-portal can reuse the
   * same authenticated session rather than logging in twice.
   *
   * Deliberately asks for nothing but credentials — archive root and report
   * date are Dashboard settings, chosen AFTER sign-in (see /api/run-portal),
   * not locked in before the user has even seen those fields.
   *
   * `body.password` is read here and handed straight to the scraper; it is
   * never assigned anywhere else, never logged, and not part of the
   * response.
   */
  async 'POST /api/login'(body) {
    if (runInFlight) throw new Error('A run is already in progress.');
    if (!body.username || !body.password) throw new Error('Amrita HIS username and password are required.');

    const credentials = { username: body.username, password: body.password };

    broadcast('login-start', { at: new Date().toISOString() });
    // eslint-disable-next-line global-require
    const scraper = require('../scraper');
    try {
      if (!scraper.isAvailable()) {
        throw new Error(
          'Portal pull unavailable: Puppeteer is not part of this build. '
          + 'Install it (npm install puppeteer) to enable the Amrita HIS automation.',
        );
      }
      const session = await scraper.startSession(
        credentials,
        makeLogger((entry) => broadcast('log', entry)),
        (error) => broadcast('login-wait', { error }),
      );
      await portalSession.set(session, body.username, () => runInFlight);

      if (body.rememberUsername) rememberUsername(body.username);
      else if (body.rememberUsername === false) rememberUsername('');

      broadcast('login-end', { ok: true });
      return { ok: true };
    } catch (err) {
      const message = errMessage(err);
      log.warn('Amrita HIS sign-in failed: ' + message);
      const payload = {
        ok: false,
        error: message,
        screenshot: err.screenshot || null,
        docLink: err.docLink || null,
        docLinkLabel: err.docLinkLabel || null,
      };
      broadcast('login-end', payload);
      return payload;
    }
  },

  /**
   * The Logout button: sign the current Amrita HIS account out, close its
   * browser, and forget the session so a different account can sign in.
   * Refused mid-run — closing the browser under a running pull would only
   * produce a confusing failure.
   */
  async 'POST /api/logout'() {
    if (runInFlight) throw new Error('A run is in progress — wait for it to finish before logging out.');
    if (!portalSession.isActive()) return { ok: true, wasSignedIn: false };
    const username = portalSession.activeUsername();
    try {
      await portalSession.logout(makeLogger((entry) => broadcast('log', entry)));
    } catch (err) {
      // The session is already detached; the worst case is a browser that
      // would not close, which closing the app cleans up.
      log.warn('Amrita HIS logout did not complete cleanly: ' + errMessage(err));
    }
    log.info('logged out of Amrita HIS' + (username ? ` (${username})` : ''));
    return { ok: true, wasSignedIn: true };
  },

  /**
   * Step 2: run the three Amrita HIS reports against the session /api/login
   * opened, for whichever archive root and report date the user has chosen on
   * the Dashboard by the time they click Run — not whatever was (or wasn't) in
   * those fields back when they signed in.
   *
   * The session is left open afterwards, win or lose, so Run can be clicked
   * again without signing in. It is closed here only when the portal itself
   * has signed it out; otherwise it lasts until the Edge window is closed.
   */
  async 'POST /api/run-portal'(body) {
    if (runInFlight) throw new Error('A run is already in progress.');
    if (!portalSession.isActive()) throw new Error('No active Amrita HIS sign-in. Sign in first.');
    if (!body.archiveRoot) throw new Error('Choose the archive root folder first.');
    runInFlight = true;

    const session = portalSession.get();
    // From/To range (inclusive, ISO yyyy-mm-dd), one run per day; default is yesterday only.
    const yesterday = getPreviousCalendarDay().iso;
    const from = body.fromDate || yesterday;
    const to = body.toDate || from;
    const dates = [];
    for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z') && dates.length < 31; t += 864e5) {
      dates.push(new Date(t).toISOString().slice(0, 10));
    }
    if (!dates.length) { runInFlight = false; throw new Error('"To" date must not be before "From" date.'); }

    try {
      const layouts = dates.map((d) => resolveLayout(body.archiveRoot, d));
      broadcast('run-start', { at: new Date().toISOString(), dryRun: false });
      // One pull for every date (each report is opened once and run for all
      // dates), then classify and write date by date.
      let outcomes;
      try {
        // eslint-disable-next-line global-require
        outcomes = await require('../scraper').runReportsMulti(session, { layouts }, makeLogger((entry) => broadcast('log', entry)));
      } catch (err) {
        outcomes = layouts.map((layout) => ({ layout, error: err })); // session-level failure: every date shares it
      }
      let last;
      for (let i = 0; i < outcomes.length; i++) {
        last = await finishPortalDate(session, outcomes[i], i < outcomes.length - 1);
        if (!portalSession.isActive()) break; // signed out — the remaining days cannot run
      }
      return last;
    } finally {
      runInFlight = false;
    }
  },

  /**
   * Where a given root + date would read from and write to. Lets the window
   * show the resolved paths before anything is run.
   */
  async 'POST /api/resolve'(body) {
    if (!body.archiveRoot) return { ok: false };
    try {
      const l = resolveLayout(body.archiveRoot, getPreviousCalendarDay().iso);
      return {
        ok: true,
        dayInputsDir: l.dayInputsDir,
        masterFile: l.masterFile,
        monthFolder: l.date.monthFolder,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async 'POST /api/pick-folder'(body) {
    const folder = await pickFolder({ title: body.title, initial: body.initial });
    return { path: folder };
  },

  async 'POST /api/pick-file'(body) {
    const file = await pickFile({ title: body.title, initial: body.initial });
    return { path: file };
  },

  async 'POST /api/reveal'(body) {
    if (!body.path) throw new Error('Nothing to show.');
    await revealInExplorer(body.path);
    return { ok: true };
  },

  async 'POST /api/open'(body) {
    if (!body.path) throw new Error('Nothing to open.');
    await openWithDefaultApp(body.path);
    return { ok: true };
  },

  async 'GET /api/status'() {
    return {
      ok: true,
      version,
      node: process.versions.node,
      scraper: scraperInfo(),
      todayDisplay: formatPortalDate(getToday().iso),
      reportDateDisplay: formatPortalDate(getPreviousCalendarDay().iso),
      // Whether a Sign In has already succeeded and is waiting for Run — lets
      // the window restore that state if it reconnects mid-flow.
      signedIn: portalSession.isActive(),
      signedInUsername: portalSession.activeUsername(),
      settings: loadSettings(),
    };
  },

  /** Remember the Dashboard's choices for next launch. Fire-and-forget from the page. */
  async 'POST /api/settings'(body) {
    return { ok: true, settings: saveSettings(body) };
  },
};

function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const key = `${req.method} ${url.pathname}`;

    // The page itself is the only unauthenticated route, and it is what hands
    // the token to the client.
    if (key === 'GET /' || key === 'GET /index.html') {
      const html = page(TOKEN);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store',
      });
      res.end(html);
      return;
    }

    const token = url.searchParams.get('token') || req.headers['x-app-token'];
    if (token !== TOKEN) { json(res, 403, { error: 'Forbidden' }); return; }

    if (key === 'GET /api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 1000\n\n');
      streams.add(res);
      keepAlive = keepAlive || setInterval(ping, 15000);
      req.on('close', () => dropStream(res));
      return;
    }

    const handler = routes[key];
    if (!handler) { json(res, 404, { error: `No route for ${key}` }); return; }

    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      json(res, 200, await handler(body));
    } catch (err) {
      json(res, 400, { error: errMessage(err) });
    }
  });

  /**
   * Shut the server down promptly.
   *
   * An event-stream response never ends by itself, and server.close() waits
   * for open responses — so on its own it left the application running for
   * about 22 seconds after the window was closed, which looks from Task
   * Manager exactly like an app that failed to exit. The open streams are
   * therefore ended explicitly, their keep-alive timers cleared, and any
   * socket still lingering destroyed.
   */
  function shutdown() {
    // Don't leave a signed-in Edge running after the app closes. The caller
    // (app/main.js) waits on the returned promise, briefly, before quitting.
    const sessionClosed = portalSession.clear().catch(() => {});
    for (const res of streams) {
      try { res.end(); } catch { /* already gone */ }
      try { res.destroy(); } catch { /* already gone */ }
      dropStream(res);
    }
    try { server.close(); } catch { /* already closing */ }
    // Anything still holding a socket open is not worth waiting for.
    try { server.closeAllConnections(); } catch { /* nothing to close */ }
    return sessionClosed;
  }

  return { server, shutdown };
}

module.exports = { createServer, TOKEN };
