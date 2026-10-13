'use strict';

const fs = require('fs');
const path = require('path');
const { appDir } = require('./appdata');

/**
 * Settings that belong to the HIS and the automation rather than to a run, kept
 * in a plain JSON file the operator (or IT) can open and edit — not in code:
 *
 *   %LOCALAPPDATA%\PharmacyMIS\config.json
 *
 * The file is written with every default the first time it is needed, so it is
 * always there to find. Missing or unreadable keys fall back to the defaults, so
 * a hand-edit that breaks the JSON can never stop the app from starting.
 *
 *   hisUrl     the HIS home page (also what "Open HIS" opens)
 *   retries    how many extra attempts a failed report gets (0-5)
 *   selectors  CSS selectors for the sign-in form, overriding the built-in ones
 *
 * The AMRITA_HIS_URL environment variable, if set, still wins over hisUrl.
 * The output folder and the saved login are not here: see core/settings.js and
 * core/credentials.js.
 */

const DEFAULTS = {
  hisUrl: 'https://aefbd.amritahospitals.org/his/Jsp/Core_Common/index.jsp?task=off',
  retries: 2,
  selectors: {
    login: {
      username: '#username, input[name="username"]',
      password: '#password, input[name="password"]',
      submit: '#kc-login, button[type="submit"], input[type="submit"]',
    },
  },
};

function configFile() {
  return path.join(appDir(), 'config.json');
}

function clampRetries(value) {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(5, Math.max(0, n)) : DEFAULTS.retries;
}

function isHttpUrl(value) {
  try { return /^https?:$/.test(new URL(String(value)).protocol); } catch { return false; }
}

/** The effective config: defaults, overlaid with whatever the file says. Never throws. */
function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {}; } catch { /* defaults */ }

  const loginOverrides = (file.selectors && file.selectors.login) || {};
  const login = { ...DEFAULTS.selectors.login };
  for (const key of Object.keys(login)) {
    if (typeof loginOverrides[key] === 'string' && loginOverrides[key].trim()) login[key] = loginOverrides[key].trim();
  }

  return {
    hisUrl: process.env.AMRITA_HIS_URL || (isHttpUrl(file.hisUrl) ? file.hisUrl : DEFAULTS.hisUrl),
    retries: file.retries === undefined ? DEFAULTS.retries : clampRetries(file.retries),
    selectors: { login },
  };
}

/** Make sure the file exists (with defaults) so there is something to open and edit. */
function ensureConfigFile() {
  const file = configFile();
  if (fs.existsSync(file)) return file;
  try { fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2), 'utf8'); } catch { /* read-only profile: defaults still apply */ }
  return file;
}

/** Save the two values the Settings screen edits; the selectors in the file are left as they are. */
function saveConfig({ hisUrl, retries }) {
  if (hisUrl !== undefined && !isHttpUrl(hisUrl)) throw new Error('The HIS URL must start with http:// or https://');
  let file = {};
  try { file = JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {}; } catch { /* start from the defaults */ }
  const next = { ...DEFAULTS, ...file };
  if (hisUrl !== undefined) next.hisUrl = String(hisUrl).trim();
  if (retries !== undefined) next.retries = clampRetries(retries);
  try {
    fs.writeFileSync(configFile(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    throw new Error(`Could not save the settings file (${configFile()}): ${err.message}`);
  }
  return loadConfig();
}

module.exports = { loadConfig, saveConfig, ensureConfigFile, configFile, DEFAULTS };
