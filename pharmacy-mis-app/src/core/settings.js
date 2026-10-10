'use strict';

const fs = require('fs');
const path = require('path');
const { appDir } = require('./appdata');

/**
 * Remembers the Dashboard's choices between runs: the archive root, the input
 * folder, the three hand-picked files, and which of the two source modes was
 * last used.
 *
 * WHY NOT localStorage, WHICH THE PAGE USED BEFORE
 * ------------------------------------------------
 * The window is served by the app's own http server, which binds to port 0 —
 * an OS-assigned free port, different on every launch (see app/main.js). The
 * page's origin is therefore http://127.0.0.1:<a new port each time>, and
 * localStorage is scoped per origin. Every launch got a brand-new, empty
 * store, so the archive root was saved perfectly and then thrown away when the
 * app closed. Settings that have to outlive a launch cannot live there.
 *
 * One small JSON file under the app's own writable folder
 * (%LOCALAPPDATA%\PharmacyMIS\, see core/appdata.js), for the same reason
 * core/credentials.js keeps the username there: it survives the port changing,
 * and the CLI and the GUI see the same value.
 *
 * Nothing secret belongs in here — it holds paths, not credentials.
 */

/** The keys worth carrying across launches, and the only ones accepted from the page. */
const KEYS = ['archiveRoot', 'inputFolder', 'filePRQ', 'filePO', 'fileGRN', 'mode'];

function settingsFile() {
  return path.join(appDir(), 'settings.json');
}

/** The saved Dashboard settings, or an empty object when there are none (or the file is unreadable). */
function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return pick(data);
  } catch {
    return {};
  }
}

/**
 * Merge these values into what is already saved.
 *
 * Merged rather than replaced so that a page saving only the field it just
 * changed cannot silently drop the rest, and unknown keys are ignored so the
 * file stays what this module says it is.
 */
function saveSettings(values) {
  const merged = { ...loadSettings(), ...pick(values) };
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(merged, null, 2), 'utf8');
  } catch { /* not remembering the settings is not fatal */ }
  return merged;
}

/** Only the known keys, and only as strings — whatever the caller passed in. */
function pick(source) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out;
}

module.exports = { loadSettings, saveSettings, KEYS };
