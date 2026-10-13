'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { version } = require('../../package.json');
const { runDailyReport } = require('../pipeline');
const { pickFolder, pickFile, revealInExplorer, openWithDefaultApp, openUrl } = require('./dialogs');
const { resolveLayout, dateFromName, dateRange, getPreviousCalendarDay, getToday, formatPortalDate } = require('../core/paths');
const credentials = require('../core/credentials');
const { loadConfig, saveConfig, ensureConfigFile } = require('../core/config');
const reportFiles = require('../core/reportFiles');
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
    return {
      available: scraper.isAvailable(),
      reports: scraper.REPORTS.map((r) => ({ key: r.key, label: r.label })),
    };
  } catch (err) {
    log.warn('optional portal scraper unavailable: ' + err.message);
    return { available: false, reports: [], error: err.message };
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

/** One plain sentence for the window: first line only, no stack trace, capped in length. */
function plainError(err) {
  const text = errMessage(err).split('\n')[0].trim();
  return text.length > 300 ? text.slice(0, 297) + '…' : text;
}

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * Tab 2 drag-and-drop. The page cannot read a dropped file's path, so the file's
 * bytes arrive as the request body, are written to a temp file, and go through
 * exactly the same check-and-store as the "Select file…" button.
 */
async function receiveDroppedFile(req, url) {
  const q = url.searchParams;
  const [archiveRoot, date, key] = [q.get('archiveRoot'), q.get('date'), q.get('key')];
  if (!archiveRoot) throw new Error('Choose the Input Output Files folder first.');
  if (!date || !key) throw new Error('Nothing to save the file as — pick a date and a report.');
  const layout = resolveLayout(archiveRoot, date);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-mis-drop-'));
  const tmp = path.join(dir, path.basename(q.get('name') || 'upload'));
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) { reject(new Error('That file is too large to be one of these reports.')); out.destroy(); }
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
    return await reportFiles.acceptFile(tmp, layout, key);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder, cleaned by the OS eventually */ }
  }
}

const routes = {
  /** Manual / preview run — files already pulled or exported by hand. Unchanged from before the Amrita HIS integration. */
  async 'POST /api/run'(body) {
    if (runInFlight) throw new Error('A run is already in progress.');
    runInFlight = true;
    broadcast('run-start', { at: new Date().toISOString(), dryRun: !!body.dryRun, usingPortal: false });
    try {
      const result = await runDailyReport(
        {
          archiveRoot: body.archiveRoot,
          inputFolder: body.inputFolder || null,
          files: body.files || {},
          reportDate: body.reportDate || null,
          dryRun: !!body.dryRun,
        },
        (entry) => broadcast('log', entry),
      );
      broadcast('run-end', result);
      logRunOutcome(result, body.archiveRoot, body.reportDate, body.inputFolder);
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
    if (!body.username) throw new Error('Amrita HIS username and password are required.');

    // An empty password field means "use the saved login", but only for the
    // username it was saved for. The saved password is decrypted here, in this
    // process, and never leaves it.
    let password = body.password;
    if (!password) {
      const saved = credentials.load();
      if (saved && saved.username === body.username) password = saved.password;
    }
    if (!password) throw new Error('Amrita HIS username and password are required.');

    const login = { username: body.username, password };

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
      const session = await scraper.startSession(login, makeLogger((entry) => broadcast('log', entry)), { headless: !!body.headless });
      await portalSession.set(session, body.username);

      if (body.rememberUsername) rememberUsername(body.username);
      else if (body.rememberUsername === false) rememberUsername('');
      saveSettings({ headless: body.headless ? '1' : '0' });

      // Only after a successful sign-in, so a wrong password is never saved.
      try {
        if (body.rememberPassword) {
          if (credentials.save(body.username, password)) rememberUsername(body.username);
          else log.warn('"Remember password" was ticked but this PC cannot encrypt it, so nothing was saved');
        } else if (body.rememberPassword === false) {
          credentials.forget();
        }
      } catch (err) {
        log.warn('could not update the saved login: ' + errMessage(err));
      }

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
   * Where each of the three files stands for every day in the range: missing,
   * valid, or present-but-invalid. Both tabs fill the same folders, so this one
   * answer drives the status bar, the per-file ticks, and "Proceed to Report".
   */
  async 'POST /api/files/status'(body) {
    if (!body.archiveRoot) return { ok: true, dates: [], allReady: false };
    const days = dateRange(body.from, body.to);
    const dates = [];
    for (const d of days) {
      const layout = resolveLayout(body.archiveRoot, d.iso);
      const files = await reportFiles.dayStatus(layout);
      dates.push({ iso: d.iso, dmy: d.dmy, folder: layout.dayInputsDir, files, ready: files.every((f) => f.state === 'valid') });
    }
    return { ok: true, dates, allReady: dates.length > 0 && dates.every((d) => d.ready) };
  },

  /** Tab 2, "Select file…": check the file at this path and, only if it passes, move it into the day's folder. */
  async 'POST /api/files/accept'(body) {
    if (!body.archiveRoot) throw new Error('Choose the Input Output Files folder first.');
    if (!body.path) throw new Error('No file was chosen.');
    return reportFiles.acceptFile(body.path, resolveLayout(body.archiveRoot, body.date), body.key);
  },

  /** Tab 2, "Open HIS": the HIS address from the settings file, in the operator's own browser. */
  async 'POST /api/his/open'() {
    await openUrl(loadConfig().hisUrl);
    return { ok: true };
  },

  /**
   * Tab 1, "Run Extraction": every report for every day in the range, one at a
   * time through the signed-in session. A failed report is retried (settings:
   * `retries`, default 2), then flagged — and the rest still run. Progress goes
   * out as 'file-progress' events. A signed-out session stops the whole thing,
   * because nothing after it could work.
   */
  async 'POST /api/extract'(body) {
    if (runInFlight) throw new Error('A run is already in progress.');
    if (!portalSession.isActive()) throw new Error('Not signed in to Amrita HIS. Sign in to use automatic extraction.');
    if (!body.archiveRoot) throw new Error('Choose the Input Output Files folder first.');
    const days = dateRange(body.from, body.to);
    const wanted = Array.isArray(body.keys) && body.keys.length ? body.keys : null;
    const defs = reportFiles.FILES.filter((f) => !wanted || wanted.includes(f.key));

    runInFlight = true;
    const session = portalSession.get();
    const attempts = 1 + loadConfig().retries;
    const sink = (entry) => broadcast('log', entry);
    const logger = makeLogger(sink);
    const summary = [];
    let sessionLost = false;

    broadcast('extract-start', { at: new Date().toISOString(), dates: days.map((d) => d.iso), keys: defs.map((f) => f.key) });
    try {
      // eslint-disable-next-line global-require
      const scraper = require('../scraper');
      outer:
      for (const day of days) {
        const layout = resolveLayout(body.archiveRoot, day.iso);
        for (const def of defs) {
          let outcome = null;
          for (let attempt = 1; attempt <= attempts && !outcome; attempt += 1) {
            broadcast('file-progress', { date: day.iso, key: def.key, state: 'running', attempt, of: attempts });
            try {
              const got = await scraper.runOneReport(session, { layout, key: def.key }, logger);
              if (got.empty) {
                outcome = { state: 'failed', error: 'The portal has no data for this date, so there is no file to save.' };
                break;
              }
              const check = await reportFiles.validateFile(got.path, def.key);
              if (!check.ok) throw new Error('The downloaded file did not pass the check: ' + check.error);
              outcome = { state: 'done', rows: check.rows };
            } catch (err) {
              const message = plainError(err);
              if (LOGIN_FAILURE.test(message) || !session.browser.connected) {
                sessionLost = true;
                outcome = { state: 'failed', error: message, screenshot: err.screenshot || null };
              } else if (attempt < attempts) {
                logger.warn(`${def.label} (${day.dmy}) failed: ${message} — trying again (${attempt + 1} of ${attempts})`);
                broadcast('file-progress', { date: day.iso, key: def.key, state: 'retrying', attempt, of: attempts, error: message });
              } else {
                outcome = { state: 'failed', error: message, screenshot: err.screenshot || null };
              }
            }
          }
          broadcast('file-progress', { date: day.iso, key: def.key, ...outcome });
          summary.push({ date: day.iso, key: def.key, ...outcome });
          if (outcome.state === 'failed') log.warn(`extraction: ${def.label} for ${day.iso} failed: ${outcome.error}`);
          if (sessionLost) break outer;
        }
      }
      if ((sessionLost || !session.browser.connected) && portalSession.get() === session) await portalSession.clear();
      const result = {
        ok: !sessionLost && summary.length > 0 && summary.every((r) => r.state === 'done'),
        sessionLost,
        done: summary.filter((r) => r.state === 'done').length,
        failed: summary.filter((r) => r.state === 'failed').length,
        signedIn: portalSession.isActive(),
      };
      broadcast('extract-end', result);
      return result;
    } finally {
      runInFlight = false;
    }
  },

  /**
   * "Proceed to Report": run the existing mapping pipeline on every day in the
   * range, from the files the two tabs left in each day's folder. Refused unless
   * every file for every day is present and valid — re-checked here rather than
   * trusting the window.
   */
  async 'POST /api/proceed'(body) {
    if (runInFlight) throw new Error('A run is already in progress.');
    if (!body.archiveRoot) throw new Error('Choose the Input Output Files folder first.');
    const days = dateRange(body.from, body.to);
    for (const day of days) {
      const files = await reportFiles.dayStatus(resolveLayout(body.archiveRoot, day.iso));
      const notReady = files.filter((f) => f.state !== 'valid').map((f) => reportFiles.byKey(f.key).label);
      if (notReady.length) throw new Error(`${day.dmy}: not ready yet — ${notReady.join(', ')}.`);
    }

    runInFlight = true;
    broadcast('run-start', { at: new Date().toISOString(), dryRun: !!body.dryRun, usingPortal: false });
    try {
      const results = [];
      for (const day of days) {
        const result = await runDailyReport(
          { archiveRoot: body.archiveRoot, reportDate: day.iso, dryRun: !!body.dryRun },
          (entry) => broadcast('log', entry),
        );
        logRunOutcome(result, body.archiveRoot, day.iso, null);
        results.push({ day, result });
      }
      const failed = results.filter((r) => !r.result.ok);
      const final = failed.length
        ? { ok: false, error: failed.map((r) => `${r.day.dmy}: ${r.result.error}`).join(' | '), log: [] }
        : { ...results[results.length - 1].result, daysProcessed: results.length };
      broadcast('run-end', final);
      return final;
    } finally {
      runInFlight = false;
    }
  },

  /** The Settings screen: the HIS address and the retry count (selectors stay in the file). */
  async 'POST /api/config'(body) {
    const saved = saveConfig({ hisUrl: body.hisUrl, retries: body.retries });
    return { ok: true, config: { hisUrl: saved.hisUrl, retries: saved.retries } };
  },

  async 'POST /api/config/reveal'() {
    await revealInExplorer(ensureConfigFile());
    return { ok: true };
  },

  /** "Forget saved login": delete the encrypted password. */
  async 'POST /api/credentials/forget'() {
    credentials.forget();
    return { ok: true };
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
    if (!body.archiveRoot) throw new Error('Choose the archive root folder first.');
    runInFlight = true;

    const session = portalSession.get();
    const reportDate = body.reportDate || getPreviousCalendarDay().iso;
    const layout = resolveLayout(body.archiveRoot, reportDate);

    broadcast('run-start', { at: new Date().toISOString(), dryRun: false, usingPortal: true });
    try {
      const sink = (entry) => broadcast('log', entry);
      let result;
      try {
        // eslint-disable-next-line global-require
        const scraper = require('../scraper');
        let pull;
        try {
          pull = await scraper.runReports(session, { layout }, makeLogger(sink));
        } catch (err) {
          const message = errMessage(err);
          // A pull that stopped partway through never has files worth
          // classifying — the classification stage below must not run against
          // whatever was already sitting in the folder from a previous day.
          throw Object.assign(new Error(message), {
            stage: LOGIN_FAILURE.test(message) ? 'login' : 'portal',
            screenshot: err.screenshot || null,
            docLink: err.docLink || null,
            docLinkLabel: err.docLinkLabel || null,
          });
        }
        result = await runDailyReport({ archiveRoot: layout.root, reportDate: layout.date.iso, dryRun: false }, sink);
        if (result.ok) result.portalFiles = pull.files;
        else result.stage = 'automation';
      } catch (err) {
        const message = errMessage(err);
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
      // Signed out on the portal's side (or the browser went away mid-run):
      // nothing left worth keeping open, and the window has to ask for a fresh
      // sign-in. Anything else keeps the session for the next Run.
      if (result.stage === 'login' || !session.browser.connected) {
        if (portalSession.get() === session) await portalSession.clear();
      }
      result.signedIn = portalSession.isActive();
      broadcast('run-end', result);
      logRunOutcome(result, layout.root, layout.date.iso, null);
      return result;
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
      // No date field any more: the day is yesterday unless a caller says otherwise.
      const l = resolveLayout(body.archiveRoot, body.reportDate || getPreviousCalendarDay().iso);
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

  async 'POST /api/pick-folder'(body) {
    const folder = await pickFolder({ title: body.title, initial: body.initial });
    return { path: folder, dateFromName: folder ? dateFromName(folder) : null };
  },

  async 'POST /api/pick-file'(body) {
    const file = await pickFile({ title: body.title, initial: body.initial });
    return { path: file, dateFromName: file ? dateFromName(file) : null };
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
      electron: process.versions.electron || null,
      scraper: scraperInfo(),
      today: getToday().iso,
      reportDate: getPreviousCalendarDay().iso,
      todayDisplay: formatPortalDate(getToday().iso),
      reportDateDisplay: formatPortalDate(getPreviousCalendarDay().iso),
      // Whether a Sign In has already succeeded and is waiting for Run — lets
      // the window restore that state if it reconnects mid-flow.
      signedIn: portalSession.isActive(),
      signedInUsername: portalSession.activeUsername(),
      // The Dashboard's own choices, which used to live in the page's
      // localStorage and so were lost every launch — the server picks a new
      // port each time, and that made a new empty store each time.
      settings: loadSettings(),
      // Never the password — only that one is saved, and for whom.
      savedLogin: credentials.status(),
      config: { hisUrl: loadConfig().hisUrl, retries: loadConfig().retries, file: ensureConfigFile() },
      defaults: { from: getPreviousCalendarDay().iso, to: getPreviousCalendarDay().iso },
      files: reportFiles.FILES.map((f) => ({
        key: f.key, label: f.label, feeds: f.feeds, steps: reportFiles.instructionsFor(f),
      })),
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

    if (key === 'POST /api/files/drop') {
      try { json(res, 200, await receiveDroppedFile(req, url)); }
      catch (err) { json(res, 400, { error: errMessage(err) }); }
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
    // Node 18.2+. Anything still holding a socket open is not worth waiting for.
    if (typeof server.closeAllConnections === 'function') {
      try { server.closeAllConnections(); } catch { /* nothing to close */ }
    }
    return sessionClosed;
  }

  return { server, shutdown };
}

module.exports = { createServer, TOKEN };
