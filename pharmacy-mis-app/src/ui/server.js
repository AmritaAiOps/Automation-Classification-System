'use strict';

const http = require('http');
const crypto = require('crypto');
const { runDailyReport } = require('../pipeline');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveLayout, enumerateDates, dateFromName, getPreviousCalendarDay, getToday, formatPortalDate } = require('../core/paths');
const { page } = require('./page');
const { log } = require('../core/appdata');
const { loadSavedUsername, saveUsername, clearSavedUsername } = require('../core/credentials');
const portalSession = require('../core/portalSession');
const { makeLogger, runOneDate } = require('../portalRun');

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
    return {
      available: scraper.isAvailable(),
      reports: scraper.REPORTS.map((r) => ({ key: r.key, label: r.label })),
    };
  } catch (err) {
    log.warn('optional portal scraper unavailable: ' + err.message);
    return { available: false, reports: [], error: err.message };
  }
}

/** The application version, read from package.json. */
function appVersion() {
  return require('../../package.json').version;
}

/**
 * The app's local server. Zero dependencies beyond node:http on purpose - it
 * binds to 127.0.0.1 on an OS-assigned port, and every request must carry a
 * token minted at startup, so nothing else on the machine can drive it.
 *
 * Log lines reach the window over Server-Sent Events as the run happens, which
 * is what makes the app show its working live rather than after the fact.
 */

const TOKEN = crypto.randomBytes(24).toString('hex');

/** The archive lives on the server; browsers never choose a server path. */
function archiveRoot() {
  if (!process.env.ARCHIVE_ROOT) throw new Error('ARCHIVE_ROOT is not set on the server.');
  return path.resolve(process.env.ARCHIVE_ROOT);
}

/** True when `file` is inside the archive root (blocks ../ and absolute escapes). */
function insideArchive(file) {
  const rel = path.relative(archiveRoot(), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sameString(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/** HTTP Basic Auth against APP_USER / APP_PASSWORD. Only safe over HTTPS off the LAN. */
function authorized(req) {
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  return sameString(user, process.env.APP_USER || 'admin') & sameString(rest.join(':'), process.env.APP_PASSWORD || '');
}

/** Open SSE connections, keyed by an id so a stale one can be dropped. */
const streams = new Map();
let nextStreamId = 1;

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, stream] of streams) {
    try {
      stream.res.write(frame);
    } catch {
      clearInterval(stream.keepAlive);
      streams.delete(id);
    }
  }
}

// The operator closing the Edge window is how a sign-in ends now, so the
// window has to hear about it and go back to the sign-in fields.
portalSession.onEnded(() => {
  log.info('the Amrita HIS Edge window was closed — signed out');
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

/** One date inside the signed-in session, plus the GUI's session upkeep and events. */
async function runPortalForDate(session, archiveRoot, reportDate) {
  const result = await runOneDate(session, archiveRoot, reportDate, (entry) => broadcast('log', entry));
  // Signed out on the portal's side (or the browser went away mid-run):
  // nothing left worth keeping open, and the window has to ask for a fresh
  // sign-in. Anything else keeps the session for the next date / Run.
  if (result.stage === 'login' || !session.browser.connected) {
    if (portalSession.get() === session) await portalSession.clear();
  }
  result.signedIn = portalSession.isActive();
  broadcast('run-end', result);
  logRunOutcome(result, archiveRoot, result.date, null);
  return result;
}

const routes = {
  /** Manual / preview run — files already pulled or exported by hand. Unchanged from before the Amrita HIS integration. */
  async 'POST /api/run'(body) {
    if (runInFlight) throw new Error('A run is already in progress.');
    runInFlight = true;
    broadcast('run-start', { at: new Date().toISOString(), dryRun: !!body.dryRun, usingPortal: false });
    // Uploaded files ({PRQ:{name,data(base64)}, ...}) are staged in a temp dir for this run only.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-mis-upload-'));
    try {
      const files = {};
      for (const [slot, f] of Object.entries(body.files || {})) {
        if (!f || !f.data) continue;
        const dest = path.join(tmp, slot + '_' + path.basename(String(f.name || slot)));
        fs.writeFileSync(dest, Buffer.from(f.data, 'base64'));
        files[slot] = dest;
      }
      const root = archiveRoot();
      const result = await runDailyReport(
        { archiveRoot: root, inputFolder: null, files, reportDate: body.reportDate || null, dryRun: !!body.dryRun },
        (entry) => broadcast('log', entry),
      );
      broadcast('run-end', result);
      logRunOutcome(result, root, body.reportDate, null);
      return result;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
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
      const session = await scraper.startSession(credentials, makeLogger((entry) => broadcast('log', entry)));
      await portalSession.set(session, body.username);

      if (body.rememberUsername) saveUsername(body.username);
      else if (body.rememberUsername === false) clearSavedUsername();

      broadcast('login-end', { ok: true });
      return { ok: true };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
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

  /** Cancel a signed-in-but-not-yet-run session — "Try Again" before Run was clicked, or switching accounts. */
  async 'POST /api/cancel-login'() {
    await portalSession.clear();
    return { ok: true };
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
    const root = archiveRoot();

    const fromDate = body.fromDate || body.reportDate || getPreviousCalendarDay().iso;
    const dates = enumerateDates(fromDate, body.toDate || null); // throws on a bad/reversed range
    runInFlight = true;

    const session = portalSession.get();
    broadcast('run-start', { at: new Date().toISOString(), dryRun: false, usingPortal: true, dates });
    try {
      const results = [];
      let last = null;
      for (let i = 0; i < dates.length; i += 1) {
        broadcast('date-start', { date: dates[i], index: i + 1, total: dates.length });
        last = await runPortalForDate(session, root, dates[i]);
        results.push({ date: dates[i], ok: !!last.ok, error: last.ok ? null : last.error });
        // Nothing more can work once the portal has signed us out or the browser has gone.
        if (last.stage === 'login' || !session.browser.connected) break;
      }
      const skipped = dates.slice(results.length);
      const summary = {
        ok: results.every((r) => r.ok) && !skipped.length,
        results,
        skipped,
        signedIn: portalSession.isActive(),
        // Not named "error": the page's api() treats that field as a failed request.
        failures: results.filter((r) => !r.ok).map((r) => `${r.date}: ${r.error}`).join('\n') || null,
        stage: last && last.stage,
        screenshot: (last && last.screenshot) || null,
        docLink: (last && last.docLink) || null,
        docLinkLabel: (last && last.docLinkLabel) || null,
      };
      broadcast('batch-end', summary);
      return summary;
    } finally {
      runInFlight = false;
    }
  },

  /**
   * Where a given root + date would read from and write to. Lets the window
   * show the resolved paths before anything is run.
   */
  async 'POST /api/resolve'(body) {
    if (!body.reportDate) return { ok: false };
    try {
      const l = resolveLayout(archiveRoot(), body.reportDate);
      return {
        ok: true,
        monthDir: l.monthDir,
        dayInputsDir: l.dayInputsDir,
        outputsDir: l.outputsDir,
        masterFile: l.masterFile,
        monthFolder: l.date.monthFolder,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  /** The remembered username, if "Remember username" was checked on a previous run — never the password. */
  async 'GET /api/saved-username'() {
    return { username: loadSavedUsername() };
  },

  async 'POST /api/forget-username'() {
    clearSavedUsername();
    return { ok: true };
  },

  async 'GET /api/status'() {
    return {
      ok: true,
      version: appVersion(),
      node: process.versions.node,
      scraper: scraperInfo(),
      today: getToday().iso,
      reportDate: getPreviousCalendarDay().iso,
      todayDisplay: formatPortalDate(getToday().iso),
      reportDateDisplay: formatPortalDate(getPreviousCalendarDay().iso),
      // Whether a Sign In has already succeeded and is waiting for Run — lets
      // the window restore that state if it reconnects mid-flow.
      signedIn: portalSession.isActive(),
      signedInUsername: portalSession.activeUsername(),
    };
  },
};

function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const key = `${req.method} ${url.pathname}`;

    if (!authorized(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Pharmacy MIS"', 'content-type': 'text/plain' });
      res.end('Sign in required');
      return;
    }

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
      const id = nextStreamId++;
      const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* dropped */ } }, 15000);
      streams.set(id, { res, keepAlive });
      req.on('close', () => { clearInterval(keepAlive); streams.delete(id); });
      return;
    }

    if (key === 'GET /api/download') {
      try {
        const file = path.resolve(url.searchParams.get('path') || '');
        if (!insideArchive(file) || !fs.statSync(file).isFile()) throw new Error('not found');
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': fs.statSync(file).size,
          'content-disposition': `attachment; filename="${path.basename(file).replace(/"/g, '')}"`,
        });
        fs.createReadStream(file).pipe(res);
      } catch { json(res, 404, { error: 'File not found' }); }
      return;
    }

    const handler = routes[key];
    if (!handler) { json(res, 404, { error: `No route for ${key}` }); return; }

    try {
      const body = req.method === 'POST' ? await readBody(req, key === 'POST /api/run' ? 64 * 1024 * 1024 : undefined) : {};
      json(res, 200, await handler(body));
    } catch (err) {
      json(res, 400, { error: err && err.message ? err.message : String(err) });
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
    // Best-effort: don't leave a signed-in Chromium running after the window
    // closes. Not awaited — shutdown() itself is synchronous, and app.exit()
    // is about to tear the process down regardless.
    portalSession.clear().catch(() => {});
    for (const [id, stream] of streams) {
      clearInterval(stream.keepAlive);
      try { stream.res.end(); } catch { /* already gone */ }
      try { stream.res.destroy(); } catch { /* already gone */ }
      streams.delete(id);
    }
    try { server.close(); } catch { /* already closing */ }
    // Node 18.2+. Anything still holding a socket open is not worth waiting for.
    if (typeof server.closeAllConnections === 'function') {
      try { server.closeAllConnections(); } catch { /* nothing to close */ }
    }
  }

  return { server, token: TOKEN, broadcast, shutdown };
}

module.exports = { createServer, TOKEN, insideArchive };
