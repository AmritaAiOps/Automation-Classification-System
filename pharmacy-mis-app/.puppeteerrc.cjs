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
 * NOT YET WIRED INTO tools/build.js — see README.md "Packaging Puppeteer's
 * Chromium" for what is still needed: an electron-builder `extraResources`
 * entry for this folder, and pointing puppeteer.launch()'s `executablePath`
 * at the packaged copy at runtime (src/scraper/index.js). Tracked there
 * rather than silently assumed to work.
 */
module.exports = {
  cacheDirectory: path.join(__dirname, '.chromium-cache'),
};
