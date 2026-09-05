'use strict';

const http = require('http');
const crypto = require('crypto');
const { runDailyReport } = require('../pipeline');
const { pickFolder, pickFile, revealInExplorer, openWithDefaultApp } = require('./dialogs');
const { resolveLayout, dateFromName } = require('../core/paths');
const { page } = require('./page');
const { log } = require('../core/appdata');

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

/**
 * The application version. Taken from Electron, which reads it out of the
 * package.json inside the packaged asar, so there is no file to find on disk
 * next to the exe. Outside Electron (the test harness) it degrades to the
 * source package.json, and to 'unknown' if even that is not there.
 */
function appVersion() {
  try {
    // eslint-disable-next-line global-require
    return require('electron').app.getVersion();
  } catch { /* not running under Electron */ }
  try {
    // eslint-disable-next-line global-require
    return require('../../package.json').version;
  } catch {
    return 'unknown';
  }
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

const routes = {
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
          reportDate: body.reportDate || null,
          dryRun: !!body.dryRun,
        },
        (entry) => broadcast('log', entry),
      );
      broadcast('run-end', result);
      if (result.ok) {
        log.info('run ok — ' + result.date + ' ' + result.write.mode + ' row ' + result.write.row
          + ' in ' + result.layout.masterFile);
      } else {
        // A failed run is the likeliest way this application "does not work"
        // from the customer's point of view, so it is recorded the same way a
        // startup failure is: technical log, and a readable copy in Documents.
        log.error(
          [
            'The daily report could not be generated.',
            '',
            'What went wrong:  ' + result.error,
            'Archive folder:   ' + (body.archiveRoot || '(not set)'),
            'Report date:      ' + (body.reportDate || '(not set)'),
            'Inputs folder:    ' + (body.inputFolder || '(not set)'),
          ].join('\n'),
          (result.log || [])
            .map((e) => e.level.toUpperCase().padEnd(5) + ' ' + '  '.repeat(e.indent || 0) + e.message)
            .join('\n'),
        );
      }
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
    if (!body.archiveRoot || !body.reportDate) return { ok: false };
    try {
      const l = resolveLayout(body.archiveRoot, body.reportDate);
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
      version: appVersion(),
      node: process.versions.node,
      electron: process.versions.electron || null,
      scraper: scraperInfo(),
    };
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
      const id = nextStreamId++;
      const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* dropped */ } }, 15000);
      streams.set(id, { res, keepAlive });
      req.on('close', () => { clearInterval(keepAlive); streams.delete(id); });
      return;
    }

    const handler = routes[key];
    if (!handler) { json(res, 404, { error: `No route for ${key}` }); return; }

    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
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

module.exports = { createServer, TOKEN };
