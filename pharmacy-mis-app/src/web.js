'use strict';

/** Web entry point: plain Node. Optional env: ARCHIVE_ROOT, APP_PASSWORD (+ APP_USER), PORT, HOST. */
const { createServer } = require('./ui/server');
const { log, pruneOldLogs, pruneOldScreenshots } = require('./core/appdata');

pruneOldLogs();
pruneOldScreenshots();
const { server, shutdown } = createServer();
const port = Number(process.env.PORT) || 8080;
server.listen(port, process.env.HOST || '0.0.0.0', () => { log.info(`web app listening on port ${port}`); console.log(`Pharmacy MIS running at http://localhost:${port}`); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { shutdown(); process.exit(0); });
