'use strict';

const path = require('path');

/**
 * Keeps the Chromium that `npm install` downloads inside the project, for the
 * developer-only tools/check-alert-capture.js. It is not shipped: the portal
 * run drives Microsoft Edge (see resolveEdgeExecutablePath() in
 * src/scraper/index.js).
 */
module.exports = {
  cacheDirectory: path.join(__dirname, '.chromium-cache'),
};
