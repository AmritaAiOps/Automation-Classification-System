'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Where the app is allowed to write.
 *
 * Nothing is ever written beside the exe: the customer may keep it in
 * Program Files, on a read-only share, or on a USB stick, and any of those
 * would fail. Everything the app owns lives under the user's own profile:
 *
 *   %LOCALAPPDATA%\PharmacyMIS\
 *     logs\pharmacy-mis-YYYY-MM-DD.log
 *     screenshots\failure_<step>_<timestamp>.png
 *
 * Customer *data* (the archive tree) is not here — that goes wherever the
 * customer points the app, see core/paths.js.
 *
 * LOCALAPPDATA is present on every Windows install, but it is read from the
 * environment, which a stripped service account can lack; os.homedir() and
 * finally os.tmpdir() cover that so logging can never be the thing that stops
 * the app from starting.
 */

const APP_DIR_NAME = 'PharmacyMIS';
const LOG_RETENTION_DAYS = 30;

function baseDir() {
  const roots = [process.env.LOCALAPPDATA, path.join(os.homedir(), 'AppData', 'Local'), os.tmpdir()];
  for (const root of roots.filter(Boolean)) {
    const dir = path.join(root, APP_DIR_NAME);
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch { /* try the next candidate */ }
  }
  // Nothing writable at all: hand back the last resort and let the writers report it.
  return path.join(os.tmpdir(), APP_DIR_NAME);
}

let cachedBase = null;
function appDir() {
  if (!cachedBase) cachedBase = baseDir();
  return cachedBase;
}

function subDir(name) {
  const dir = path.join(appDir(), name);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported by the writer */ }
  return dir;
}

function logFile() {
  return path.join(subDir('logs'), `pharmacy-mis-${new Date().toLocaleDateString('en-CA')}.log`);
}

function screenshotDir() {
  return subDir('screenshots');
}

/** Drop files in `dir` matching `pattern` older than the retention window. */
function pruneDir(dir, pattern) {
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!pattern.test(name)) continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch { /* housekeeping only - never fatal */ }
}

/** Keep the log folder from growing without bound. */
function pruneOldLogs() {
  pruneDir(subDir('logs'), /^pharmacy-mis-\d{4}-\d{2}-\d{2}\.log$/);
}

function pruneOldScreenshots() {
  pruneDir(screenshotDir(), /^failure_.+\.png$/);
}

/* ------------------------------------------------------------------ *
 * The error log the customer can actually find
 * ------------------------------------------------------------------ */

/**
 * %LOCALAPPDATA% is the right place for an application's own logs, and the
 * wrong place to ask a pharmacy user to look: the folder is hidden, the path
 * is long, and "AppData" means nothing to them. So anything that goes wrong is
 * written a second time into Documents, where they can find it, read it and
 * attach it to an email without being talked through Explorer.
 *
 * The folder is created on the first error and never before — a customer who
 * never has a problem never gets a folder in their Documents.
 *
 * Documents is asked for by API rather than assumed to be %USERPROFILE%\
 * Documents: it is commonly redirected to OneDrive or a network share, and
 * writing to the wrong one would put the file somewhere they will not look.
 */
const DOCS_FOLDER_NAME = 'Pharmacy MIS';
const ERROR_LOG_NAME = 'Pharmacy MIS - Error Log.txt';
const ERROR_LOG_MAX_BYTES = 1024 * 1024;

function documentsDir() {
  const candidates = [];
  try {
    // Electron knows the real, possibly redirected, Documents folder.
    candidates.push(require('electron').app.getPath('documents'));
  } catch { /* not running under Electron, or too early to ask */ }
  candidates.push(path.join(os.homedir(), 'Documents'));
  return candidates.find((dir) => dir && fs.existsSync(dir)) || candidates.find(Boolean) || null;
}

/** The customer-facing error log. Null when there is nowhere to put it. */
function errorLogFile() {
  const docs = documentsDir();
  return docs ? path.join(docs, DOCS_FOLDER_NAME, ERROR_LOG_NAME) : null;
}

/**
 * Mirror one failure into Documents.
 *
 * Everything here is best-effort and silent on failure. This runs while the
 * application is already going wrong; it must not add a second problem on top
 * of the first.
 */
function writeErrorLog(message, detail) {
  const file = errorLogFile();
  if (!file) return null;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // Keep one generation, so a repeatedly failing run cannot fill the disk
    // and the file stays small enough to read and to email.
    try {
      if (fs.statSync(file).size > ERROR_LOG_MAX_BYTES) {
        fs.renameSync(file, `${file}.previous.txt`);
      }
    } catch { /* no file yet, or it is in use — either is fine */ }

    const stamp = new Date().toLocaleString();
    const block = [
      '='.repeat(72),
      `${stamp}   Pharmacy MIS`,
      '='.repeat(72),
      message,
      detail ? `\n${detail}` : '',
      '',
      `Full technical log: ${logFile()}`,
      '',
      'What to do: send this file to your IT contact. It has everything they',
      'need. Nothing here is confidential beyond the file paths you chose.',
      '',
      '',
    ].join('\n');

    fs.appendFileSync(file, block, 'utf8');
    return file;
  } catch {
    return null;
  }
}

/**
 * Append one line to today's log. Deliberately synchronous and deliberately
 * swallowing its own errors: a failure to log must never take the app down,
 * and a crash handler needs the line on disk before the process goes away.
 *
 * Errors are additionally mirrored into Documents — see writeErrorLog.
 */
function writeLog(level, message, detail) {
  const line = `${new Date().toISOString()}  ${String(level).toUpperCase().padEnd(5)}  ${message}\n`;
  try {
    fs.appendFileSync(logFile(), line, 'utf8');
  } catch { /* nothing sensible to do */ }
  if (level === 'error') writeErrorLog(message, detail);
  return line;
}

const log = {
  info: (m) => writeLog('info', m),
  warn: (m) => writeLog('warn', m),
  /**
   * Record a failure. Goes to the technical log and, because it is an error,
   * to the customer-facing copy in Documents as well. `detail` is the stack or
   * extra context, included in the Documents copy only.
   */
  error: (m, detail) => writeLog('error', m, detail),
};

module.exports = {
  appDir,
  logFile,
  log,
  pruneOldLogs,
  screenshotDir,
  pruneOldScreenshots,
  errorLogFile,
};
