'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Where the app is allowed to write.
 *
 * Everything the app owns lives under the user's own profile:
 *
 *   %LOCALAPPDATA%\PharmacyMIS\
 *     logs\pharmacy-mis-YYYY-MM-DD.log
 *     screenshots\failure_<step>_<timestamp>.png
 *
 * Archive *data* (the archive tree) is not here — that goes wherever the
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
  const candidates = [
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    os.homedir() ? path.join(os.homedir(), 'AppData', 'Local') : null,
    os.tmpdir(),
  ].filter(Boolean);

  for (const root of candidates) {
    const dir = path.join(root, APP_DIR_NAME);
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      // try the next candidate
    }
  }
  // os.tmpdir() failing too means the machine has no writable location at all.
  return path.join(os.tmpdir(), APP_DIR_NAME);
}

let cachedBase = null;
function appDir() {
  if (!cachedBase) cachedBase = baseDir();
  return cachedBase;
}

function logDir() {
  const dir = path.join(appDir(), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported by the writer */ }
  return dir;
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function logFile() {
  return path.join(logDir(), `pharmacy-mis-${todayStamp()}.log`);
}

/** Drop logs older than the retention window, so the folder cannot grow without bound. */
function pruneOldLogs() {
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(logDir())) {
      if (!/^pharmacy-mis-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const full = path.join(logDir(), name);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch { /* housekeeping only — never fatal */ }
}

function screenshotDir() {
  const dir = path.join(appDir(), 'screenshots');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported by the writer */ }
  return dir;
}

/** Drop failure screenshots older than the retention window, same as pruneOldLogs(). */
function pruneOldScreenshots() {
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(screenshotDir())) {
      if (!/^failure_.+\.png$/.test(name)) continue;
      const full = path.join(screenshotDir(), name);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch { /* housekeeping only — never fatal */ }
}

/**
 * Append one line to today's log. Deliberately synchronous and deliberately
 * swallowing its own errors: a failure to log must never take the app down,
 * and a crash handler needs the line on disk before the process goes away.
 */
function writeLog(level, message) {
  const line = `${new Date().toISOString()}  ${String(level).toUpperCase().padEnd(5)}  ${message}\n`;
  try {
    fs.appendFileSync(logFile(), line, 'utf8');
  } catch { /* nothing sensible to do */ }
  return line;
}

const log = {
  info: (m) => writeLog('info', m),
  warn: (m) => writeLog('warn', m),
  /** Record a failure; `detail` (stack or extra context) is appended to the same log entry. */
  error: (m, detail) => writeLog('error', detail ? m + '\n' + detail : m),
  file: logFile,
  dir: logDir,
};

module.exports = {
  appDir,
  logDir,
  logFile,
  log,
  pruneOldLogs,
  screenshotDir,
  pruneOldScreenshots,
  APP_DIR_NAME,
};
