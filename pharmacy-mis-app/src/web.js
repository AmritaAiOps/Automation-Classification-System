'use strict';

/** Web entry point: plain Node, no Electron. Env: APP_PASSWORD, ARCHIVE_ROOT (required); APP_USER, PORT, HOST. */
const { createServer } = require('./ui/server');
const { log, pruneOldLogs, pruneOldScreenshots } = require('./core/appdata');

for (const k of ['APP_PASSWORD', 'ARCHIVE_ROOT']) {
  if (!process.env[k]) { console.error(`${k} must be set.`); process.exit(1); }
}

pruneOldLogs();
pruneOldScreenshots();
const { server, shutdown } = createServer();
const port = Number(process.env.PORT) || 8080;
server.listen(port, process.env.HOST || '0.0.0.0', () => log.info(`web app listening on port ${port}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { shutdown(); process.exit(0); });
