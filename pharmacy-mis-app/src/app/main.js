'use strict';

/**
 * Electron main process — the application entry point.
 *
 * WHY ELECTRON AND NOT A BROWSER IN --app MODE
 * --------------------------------------------
 * The previous build started a local server and then launched the machine's
 * own Edge with --app=<url>. That is broken in a way that only shows up off
 * the developer's machine: Edge's launcher process hands the command line to
 * the real browser process and exits ~80 ms later. The old main.js watched
 * that launcher for 'exit' and treated it as "the user closed the window", so
 * the app shut its own server down about a second after starting. The window
 * that did appear then showed "This site can't be reached".
 *
 * It also made the GUI depend on a browser the customer might not have.
 *
 * Electron carries its own Chromium, so the window belongs to this process:
 * its lifetime is ours, there is nothing to detect, and nothing to install.
 *
 * The renderer still talks to a loopback HTTP server rather than over IPC.
 * That is deliberate — it is the same server the --cli path and the self-test
 * exercise, it binds to 127.0.0.1 on an OS-assigned port behind a per-launch
 * token, and it keeps one implementation of the API instead of two.
 */

const path = require('path');
const { log, pruneOldLogs, logFile, errorLogFile } = require('../core/appdata');

/**
 * ELECTRON_RUN_AS_NODE GUARD — must come before anything else.
 *
 * If that variable is set in the environment, Electron starts as a bare Node
 * runtime: require('electron') hands back a path string instead of the module,
 * there is no `app`, and every window API is gone. It is set by other Electron
 * tooling and by some corporate shells, and it is inherited by anything they
 * launch — including this exe from a double-click in a session where it is set
 * machine-wide. That is a genuine "works here, dead on their machine" trap.
 *
 * Rather than fail, relaunch ourselves once with the variable stripped. The
 * app root is passed explicitly, which Electron accepts as either a folder
 * (development) or an app.asar path (packaged), so one line covers both.
 */
const RELAUNCH_FLAG = 'PHARMACY_MIS_RELAUNCHED';
const electron = require('electron');

if (typeof electron === 'string' || !electron.app) {
  if (process.env[RELAUNCH_FLAG]) {
    // Relaunching did not help; say so somewhere the user can find it.
    log.error('Electron refused to start as an app even after clearing ELECTRON_RUN_AS_NODE.');
    process.exit(1);
  }
  const env = { ...process.env, [RELAUNCH_FLAG]: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  log.warn('ELECTRON_RUN_AS_NODE was set in the environment — relaunching without it');
  const appRoot = path.join(__dirname, '..', '..');
  const child = require('child_process').spawn(
    process.execPath,
    [appRoot, ...process.argv.slice(2)],
    { env, stdio: 'inherit', windowsHide: false },
  );
  child.on('exit', (code) => process.exit(code == null ? 1 : code));
  return;
}

const { app, BrowserWindow, dialog, clipboard, shell, Menu } = electron;

const APP_NAME = 'Pharmacy MIS';
const WINDOW = { width: 1280, height: 840, minWidth: 940, minHeight: 600 };

/** Set by startup as it advances, so a failure dialog can name the stage. */
let stage = 'starting up';

let mainWindow = null;
let httpServer = null;
let stopServer = null;
/** Set once shutdown starts, so teardown noise is not reported as a failure. */
let quitting = false;

/* ------------------------------------------------------------------ *
 * Failure reporting
 * ------------------------------------------------------------------ */

/**
 * The customer must never be left with a window that silently did not open.
 * Everything that can stop startup funnels through here: it writes the full
 * detail to the log, then shows a dialog naming the stage that failed, what
 * to try, and where the log is — with a button that copies the details so
 * they can be pasted into an email.
 */
function fatal(err, failedStage) {
  const where = failedStage || stage;
  const detail = err && err.stack ? err.stack : String(err);

  const report = [
    APP_NAME + ' — startup failed',
    'Version:  ' + safeVersion(),
    'Stage:    ' + where,
    'Error:    ' + message(err),
    'Log file: ' + logFile(),
    '',
    detail,
  ].join('\n');

  // Written before anything else, and to both places: the technical log under
  // %LOCALAPPDATA%, and a plain-language copy in the customer's Documents,
  // which is the one they can actually find. See core/appdata.js.
  log.error(
    APP_NAME + ' could not start.\n\n'
    + 'Stage that failed:  ' + where + '\n'
    + 'Error:  ' + message(err) + '\n'
    + 'Version:  ' + safeVersion() + '\n\n'
    + suggestionFor(err),
    detail,
  );

  const errorFile = errorLogFile();

  try {
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: APP_NAME + ' — could not start',
      message: APP_NAME + ' could not start.',
      detail:
        'Stage that failed: ' + where + '\n\n'
        + message(err) + '\n\n'
        + suggestionFor(err) + '\n\n'
        + (errorFile
          ? 'The details were saved to your Documents folder:\n' + errorFile
          : 'A full log was written to:\n' + logFile()),
      buttons: ['Copy error details', 'Show me the error file', 'Close'],
      defaultId: 2,
      cancelId: 2,
      noLink: true,
    });
    if (choice === 0) clipboard.writeText(report);
    if (choice === 1) shell.showItemInFolder(errorFile || logFile());
  } catch {
    // Dialogs are unavailable before the app is ready, or on a session-0
    // service account. The two log files above are then the only record,
    // which is exactly why they are written first.
  }

  app.exit(1);
}

function message(err) {
  return err && err.message ? err.message : String(err);
}

function safeVersion() {
  try { return app.getVersion(); } catch { return 'unknown'; }
}

function suggestionFor(err) {
  const msg = message(err);
  if (/EADDRINUSE|listen/i.test(msg)) {
    return 'Something is holding the local port the app needs. Restart the computer and try again.';
  }
  if (/EACCES|EPERM|denied/i.test(msg)) {
    return 'Windows refused an operation. Try running the app from a folder you own, such as your Desktop.';
  }
  if (/ENOENT/i.test(msg)) {
    return 'A file or folder the app expected was not there. Check that the archive folder you selected still exists.';
  }
  return 'Try starting the app again. If it keeps failing, send the log file below to your IT contact.';
}

process.on('uncaughtException', (err) => fatal(err, stage + ' (unhandled error)'));
process.on('unhandledRejection', (err) => fatal(err, stage + ' (unhandled rejection)'));

/* ------------------------------------------------------------------ *
 * Argument handling
 * ------------------------------------------------------------------ */

function wantsCli(argv) {
  return argv.some((a) => a === '--cli' || a === '--help' || a === '-h' || a === '--self-test');
}

/**
 * Arguments belonging to the app, with the exe path and Chromium's own
 * switches stripped. Windows and Chromium both add switches on some launches,
 * so anything that is not ours is dropped rather than handed to the parser.
 */
function appArgs(argv) {
  return argv.slice(1).filter((a) => !/^--(enable|disable|no-sandbox|allow|remote|inspect|trace)/.test(a));
}

/* ------------------------------------------------------------------ *
 * GUI startup
 * ------------------------------------------------------------------ */

async function startGui() {
  stage = 'starting the local server';
  const { createServer } = require('../ui/server');
  const { server, shutdown: closeServer } = createServer();
  httpServer = server;
  stopServer = closeServer;

  const url = await new Promise((resolve, reject) => {
    server.once('error', reject);
    // Port 0 asks Windows for any free port, so two copies of the app, or
    // anything else already listening, cannot collide.
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port + '/'));
  });
  log.info('local server listening on ' + url);

  stage = 'opening the application window';
  mainWindow = new BrowserWindow({
    width: WINDOW.width,
    height: WINDOW.height,
    minWidth: WINDOW.minWidth,
    minHeight: WINDOW.minHeight,
    title: APP_NAME + ' — Daily Report',
    backgroundColor: '#10151c',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // The page is our own, served from loopback, and needs no Node access:
      // it talks to the app over fetch/SSE like any web client would.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);

  // Nothing in this app should navigate away or open a second window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    log.info('window shown');
  });

  // Both of these also fire during an ordinary shutdown — did-fail-load with
  // ERR_ABORTED (-3) as the page is torn down, and render-process-gone with
  // reason 'clean-exit' as the renderer goes away. Reporting either of those
  // would put an alarming error dialog in front of a customer who had just
  // closed the window on purpose, so only genuine failures get through.
  mainWindow.webContents.on('did-fail-load', (_e, code, description) => {
    if (quitting || code === -3) return;
    fatal(
      new Error('The application page failed to load (' + code + ' ' + description + ')'),
      'loading the application page',
    );
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (quitting || details.reason === 'clean-exit') return;
    fatal(
      new Error('The application window stopped responding (' + details.reason + ')'),
      'running the application window',
    );
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  stage = 'loading the application page';
  await mainWindow.loadURL(url);
  stage = 'running';
  log.info('startup complete');
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

function shutdown() {
  if (stopServer) {
    try { stopServer(); } catch { /* already closing */ }
    stopServer = null;
  } else if (httpServer) {
    try { httpServer.close(); } catch { /* already closing */ }
  }
  httpServer = null;
}

app.on('window-all-closed', () => {
  quitting = true;
  log.info('window closed — exiting');
  shutdown();
  app.quit();

  // A backstop. Closing the window must end the application then and there:
  // an app that lingers in Task Manager looks broken, blocks the next launch's
  // single-instance lock, and can hold the master workbook open. If anything
  // is still keeping the process alive a moment after quit, stop waiting for
  // it — there is no unsaved state at this point, the workbook is written
  // atomically during the run.
  setTimeout(() => {
    log.warn('still running shortly after quit — exiting the hard way');
    app.exit(0);
  }, 2500).unref();
});

app.on('before-quit', () => { quitting = true; shutdown(); });

function boot() {
  const argv = appArgs(process.argv);

  if (wantsCli(argv)) {
    // Headless: no window, no GPU, and no single-instance lock — a scheduled
    // task may legitimately run this while the window is open.
    app.disableHardwareAcceleration();
    require('./headless').run(argv, app);
    return;
  }

  // A second double-click focuses the window that is already open rather than
  // starting a second server and racing it for the same master workbook.
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  pruneOldLogs();
  log.info('--- ' + APP_NAME + ' ' + safeVersion() + ' starting (Electron ' + process.versions.electron + ') ---');
  try { log.info('exe: ' + app.getPath('exe')); } catch { /* not fatal */ }

  app.whenReady()
    .then(startGui)
    .catch((err) => fatal(err));
}

boot();
