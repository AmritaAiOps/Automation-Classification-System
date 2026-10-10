'use strict';

const path = require('path');

/**
 * Pins Puppeteer's downloaded Chromium to a project-relative folder instead
 * of the OS user-cache directory it uses by default. That default location
 * is exactly right for a developer machine and exactly wrong for a packaged
 * exe: electron-builder only ships what is under this project, so a
 * Chromium sitting in %LOCALAPPDATA%\puppeteer (or similar) at install time
 * would work here and be silently missing on the customer's machine.
 *
 * Not used by the portal run itself any more: src/scraper/index.js now drives
 * Microsoft Edge, headful, so the operator can watch the run happen — see
 * resolveEdgeExecutablePath() there. This bundled Chromium and its resolver
 * (resolveChromiumExecutablePath()) are kept as dormant fallback plumbing,
 * still wired into tools/build.js's packaging step, in case a future need for
 * a headless/no-Edge path comes back.
 */
module.exports = {
  cacheDirectory: path.join(__dirname, '.chromium-cache'),
};
