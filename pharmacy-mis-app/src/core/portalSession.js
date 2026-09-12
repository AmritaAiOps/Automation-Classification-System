'use strict';

/**
 * Holds the one Amrita HIS Puppeteer session that can be "signed in but not
 * yet run" between the GUI's two steps:
 *
 *   POST /api/login        -> startSession() lands here on success
 *   POST /api/run-portal   -> take()s it, runs the reports, closes it
 *
 * A session sits here only for as long as the user is looking at the
 * "✓ Logged in — Run" screen. If they never click Run, an idle timer closes
 * the browser on its own so a forgotten tab cannot leave Chromium running
 * forever. Only one session is ever held at a time — signing in again closes
 * whatever was there first.
 *
 * Deliberately holds no archive root or report date — those are Dashboard
 * settings the user picks after signing in, and /api/run-portal reads them
 * fresh off the request body at Run time rather than whatever they might
 * have been (or defaulted to) back when /api/login ran.
 */

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — long enough to read the log, short enough not to leak a browser

let current = null; // { session, username, timer }

function closeQuietly(session) {
  // eslint-disable-next-line global-require
  const scraper = require('../scraper');
  return scraper.closeSession(session).catch(() => {});
}

/** Store a newly-authenticated session, closing whatever was there before. */
async function set(session, username) {
  await clear();
  current = { session, username, timer: null };
  current.timer = setTimeout(() => { closeQuietly(session); if (current && current.session === session) current = null; }, IDLE_TIMEOUT_MS);
  current.timer.unref();
}

/** Whether a signed-in session is currently waiting to be run. */
function isActive() {
  return !!current;
}

/** The waiting session's username, if any — never its password (never stored). */
function activeUsername() {
  return current ? current.username : null;
}

/** Take ownership of the waiting session (for /api/run-portal) — the caller is now responsible for closing it. */
function take() {
  if (!current) return null;
  clearTimeout(current.timer);
  const taken = current;
  current = null;
  return { session: taken.session, username: taken.username };
}

/** Close the waiting session, if any (idle timeout, explicit cancel, or a fresh sign-in replacing it). */
async function clear() {
  if (!current) return;
  clearTimeout(current.timer);
  const { session } = current;
  current = null;
  await closeQuietly(session);
}

module.exports = { set, isActive, activeUsername, take, clear };
