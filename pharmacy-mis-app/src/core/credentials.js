'use strict';

const fs = require('fs');
const path = require('path');
const { appDir } = require('./appdata');

/**
 * Remembers the Amrita HIS USERNAME between runs, and only the username.
 *
 * REMEMBER USERNAME = YES, REMEMBER PASSWORD = NO. The password never has a
 * function in this module — it is not a parameter anywhere below — so there
 * is no path through this file that could persist it, plain text or
 * otherwise. The password lives only in memory for the current sign-in and is
 * handed straight to Puppeteer; see src/scraper/index.js.
 *
 * Stored as one small JSON file under the app's own writable folder
 * (%LOCALAPPDATA%\PharmacyMIS\, see core/appdata.js) rather than in
 * localStorage, so the CLI/headless run and the GUI see the same value.
 */

function credentialsFile() {
  return path.join(appDir(), 'credentials.json');
}

/** The previously remembered username, or null if none is stored (or unreadable). */
function loadSavedUsername() {
  try {
    const data = JSON.parse(fs.readFileSync(credentialsFile(), 'utf8'));
    return typeof data.username === 'string' && data.username ? data.username : null;
  } catch {
    return null;
  }
}

/** Remember a username for next time. Best-effort: not being able to save it is not fatal. */
function saveUsername(username) {
  const value = String(username || '').trim();
  if (!value) { clearSavedUsername(); return; }
  try {
    fs.writeFileSync(credentialsFile(), JSON.stringify({ username: value }, null, 2), 'utf8');
  } catch { /* not remembering the username is not fatal */ }
}

/** Forget the remembered username — "Remember username" unchecked, or "Change Username". */
function clearSavedUsername() {
  try { fs.unlinkSync(credentialsFile()); } catch { /* nothing to clear */ }
}

module.exports = { loadSavedUsername, saveUsername, clearSavedUsername };
