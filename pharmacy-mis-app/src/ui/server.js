'use strict';

const http = require('http');
const crypto = require('crypto');
const { runDailyReport } = require('../pipeline');
const { pickFolder, pickFile, revealInExplorer, openWithDefaultApp } = require('./dialogs');
const { resolveLayout, dateFromName } = require('../core/paths');
const { isAvailable: scraperAvailable, REPORTS } = require('../scraper');
const { page } = require('./page');

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
  for (const [id, res] of streams) {
    try {
      res.write(frame);
    } catch {
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
      version: require('../../package.json').version,
      node: process.versions.node,
      scraper: {
        available: scraperAvailable(),
        reports: REPORTS.map((r) => ({ key: r.key, label: r.label })),
      },
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
      streams.set(id, res);
      const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* dropped */ } }, 15000);
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

  return { server, token: TOKEN, broadcast };
}

module.exports = { createServer, TOKEN };
