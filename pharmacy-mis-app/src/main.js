'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { createServer } = require('./ui/server');

/**
 * Entry point.
 *
 * Starts the local server on an OS-assigned port, then opens the page in a
 * chromeless app window. The window is the machine's own Edge/WebView2 in
 * --app mode, so nothing about a browser engine is bundled: the exe stays one
 * file and starts in about a fifth of a second.
 *
 * The app exits when the window closes. If no Chromium-based browser can be
 * found, the URL is opened in whatever the default browser is and the process
 * stays up until Ctrl+C.
 *
 * WHY THE RESPAWN BELOW: this exe is a console-subsystem binary (it is a
 * patched node.exe, and node.exe on Windows is always console-subsystem —
 * that is what lets --cli mode print output when run from a terminal or a
 * scheduled task). The cost is that Windows allocates a visible console
 * window for it on every launch UNLESS the process is created with
 * CREATE_NO_WINDOW. A double-click from Explorer has no parent console, so
 * without this, a black window pops up next to the app window every time —
 * confusing on an unfamiliar machine, and an easy thing for someone to close
 * by mistake, which tears down the whole app with it (see main() below).
 *
 * The fix is the standard pattern for this on Windows: on a normal (GUI)
 * launch, immediately re-spawn the same exe with windowsHide, which passes
 * CREATE_NO_WINDOW so no console is created at all, then exit the visible
 * one. --cli mode never takes this path, so a terminal or Task Scheduler run
 * keeps its console and its captured output exactly as before.
 */

const APP_NAME = 'Pharmacy MIS';
const WINDOW = { width: 1280, height: 820 };
const RESPAWN_FLAG = 'PHARMACY_MIS_NO_CONSOLE';

/**
 * Candidate app-mode hosts, best first. Edge and WebView2 ship with Windows 11,
 * so the first entry almost always hits.
 */
function findBrowser() {
  const roots = [
    process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
    process.env.PROGRAMFILES || 'C:\\Program Files',
    process.env.LOCALAPPDATA || '',
  ].filter(Boolean);

  const relative = [
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
    ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
  ];

  for (const rel of relative) {
    for (const root of roots) {
      const candidate = path.join(root, ...rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** A per-install profile, so the app window keeps its own size and state. */
function profileDir() {
  const base = process.env.LOCALAPPDATA || os.tmpdir();
  const dir = path.join(base, 'PharmacyMIS', 'window-profile');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function openAppWindow(url) {
  const browser = findBrowser();

  if (!browser) {
    console.log(`Opening ${url} in your default browser (no Edge/Chrome found for app mode).`);
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
    return null;
  }

  const child = spawn(
    browser,
    [
      `--app=${url}`,
      `--window-size=${WINDOW.width},${WINDOW.height}`,
      `--user-data-dir=${profileDir()}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--app-auto-launched',
    ],
    { detached: false, stdio: 'ignore', windowsHide: false },
  );

  child.on('error', (err) => {
    console.error(`Could not open the app window: ${err.message}`);
    console.log(`Open this URL manually: ${url}`);
  });

  return child;
}

/**
 * Re-launch this exe as a windowless child (CREATE_NO_WINDOW, via
 * windowsHide) and let this, the visible-console instance, exit. Guarded by
 * an env var so the respawned child does not do this again.
 */
function respawnWithoutConsole() {
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, [RESPAWN_FLAG]: '1' },
  });
  child.unref();
}

function main() {
  // One binary, two front ends. `--cli` runs the same pipeline headless, which
  // is how a scheduled task will drive it once the portal pull is in place —
  // that path always keeps its console and is never respawned.
  const argv = process.argv.slice(1);
  if (argv.some((a) => a === '--cli' || a === '--help' || a === '-h')) {
    require('./cli');
    return;
  }

  if (process.platform === 'win32' && !process.env[RESPAWN_FLAG]) {
    respawnWithoutConsole();
    return;
  }

  const { server } = createServer();

  server.on('error', (err) => {
    console.error(`Could not start the app: ${err.message}`);
    process.exit(1);
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/`;
    console.log(`${APP_NAME} listening on ${url}`);

    const win = openAppWindow(url);

    if (win) {
      // The window is the app. When the user closes it, close down with it
      // rather than leaving a server running invisibly in the background.
      win.on('exit', () => {
        server.close(() => process.exit(0));
        // Do not let an open SSE connection hold the process up.
        setTimeout(() => process.exit(0), 500).unref();
      });
    } else {
      console.log('Press Ctrl+C to quit.');
    }
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { server.close(() => process.exit(0)); });
  }
}

main();
