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
 * when the operator clicks Logout (logout()), closes the Edge window (the
 * browser's 'disconnected' event), the portal itself signs it out, or the app
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

/**
 * Store a newly-authenticated session, closing whatever was there before.
 * `isBusy()` true = a run owns the page; a sign-in page seen then is the run's failure to report, not ours.
 */
async function set(session, username, isBusy = () => false) {
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
  session.browser.once('disconnected', entry.onDisconnect);
  // Signed out by hand in the Edge window: the tab lands back on the Keycloak sign-in page.
  entry.onNavigated = (frame) => {
    if (frame !== session.page.mainFrame() || isBusy()) return;
    // eslint-disable-next-line global-require
    if (require('../scraper').SIGN_IN_URL.test(frame.url())) entry.onDisconnect();
  };
  session.page.on('framenavigated', entry.onNavigated);
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

/** Close the open session, if any (sign out, a fresh sign-in replacing it, the portal signing it out, or app shutdown). */
async function clear() {
  if (!current) return;
  const { session } = current;
  detach(current);
  current = null;
  await closeQuietly(session);
}

/**
 * The Logout button: sign out of the portal (best effort) and drop the session.
 * Detached first so the browser closing is not reported as "Edge was closed".
 * Resolves true if a session was open.
 */
async function logout(log) {
  if (!current) return false;
  const { session } = current;
  detach(current);
  current = null;
  try {
    // eslint-disable-next-line global-require
    await require('../scraper').logoutSession(session, log);
  } catch {
    await closeQuietly(session);
  }
  return true;
}

function detach(entry) {
  try { entry.session.browser.off('disconnected', entry.onDisconnect); } catch { /* browser already gone */ }
  try { entry.session.page.off('framenavigated', entry.onNavigated); } catch { /* page already gone */ }
}

module.exports = { set, isActive, activeUsername, get, clear, logout, onEnded };
