'use strict';

/**
 * Holds the one signed-in Amrita HIS Puppeteer session the GUI runs reports
 * through:
 *
 *   POST /api/login        -> startSession() lands here on success
 *   POST /api/run-portal   -> get()s it and runs the reports — and leaves it open
 *
 * The session outlives a run on purpose, so the operator signs in once and can
 * Run again (another date, a retry) without signing in every time. It ends
 * when the operator closes the Edge window (the browser's 'disconnected'
 * event), signs out from the app, the portal itself signs it out, or the app
 * is closed. There is no idle timer: closing Edge is the operator's way of
 * signing out. Only one session is ever held at a time — signing in again
 * closes whatever was there first.
 *
 * Deliberately holds no archive root or report date — those are Dashboard
 * settings the user picks after signing in, and /api/run-portal reads them
 * fresh off the request body at Run time rather than whatever they might
 * have been (or defaulted to) back when /api/login ran.
 */

let current = null; // { session, username, onDisconnect }
let endedListener = null;

function closeQuietly(session) {
  // eslint-disable-next-line global-require
  const scraper = require('../scraper');
  return scraper.closeSession(session).catch(() => {});
}

/** Called with no arguments whenever the session ends because Edge went away rather than because the app closed it. */
function onEnded(fn) {
  endedListener = fn;
}

/** Store a newly-authenticated session, closing whatever was there before. */
async function set(session, username) {
  await clear();
  const entry = { session, username, onDisconnect: null };
  entry.onDisconnect = () => {
    if (current !== entry) return; // already replaced or cleared by the app itself
    current = null;
    closeQuietly(session); // removes the throwaway profile; the browser is already gone
    if (endedListener) {
      try { endedListener(); } catch { /* a listener problem must not take the server down */ }
    }
  };
  current = entry;
  if (session.browser && typeof session.browser.once === 'function') {
    session.browser.once('disconnected', entry.onDisconnect);
  }
}

/** Whether a signed-in session is currently open. */
function isActive() {
  return !!current;
}

/** The open session's username, if any — never its password (never stored). */
function activeUsername() {
  return current ? current.username : null;
}

/** The open session, left in place — the caller must not close it. */
function get() {
  return current ? current.session : null;
}

/** Take ownership of the open session — the caller is now responsible for closing it. */
function take() {
  if (!current) return null;
  const taken = current;
  current = null;
  detach(taken);
  return { session: taken.session, username: taken.username };
}

/** Close the open session, if any (sign out, a fresh sign-in replacing it, the portal signing it out, or app shutdown). */
async function clear() {
  if (!current) return;
  const { session } = current;
  detach(current);
  current = null;
  await closeQuietly(session);
}

function detach(entry) {
  try { entry.session.browser.off('disconnected', entry.onDisconnect); } catch { /* browser already gone */ }
}

module.exports = { set, isActive, activeUsername, get, take, clear, onEnded };
