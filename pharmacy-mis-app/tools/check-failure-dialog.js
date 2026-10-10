'use strict';

/**
 * Proves the launcher's failure dialog actually appears.
 *
 *   node tools/check-failure-dialog.js
 *
 * The whole point of the launcher's error handling is that a customer never
 * gets a double-click that does nothing. That path is, by its nature, the one
 * that never runs during a normal build — so it is provoked deliberately here:
 * every environment variable the launcher could use to find a writable folder
 * is pointed at a file rather than a directory, so there is nowhere to unpack
 * to and the failure path is the only one left.
 *
 * The check passes when a message box with the application's title appears.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EXE = path.join(__dirname, '..', 'dist', 'Pharmacy-MIS.exe');

function powershell(script) {
  const res = require('child_process').spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='SilentlyContinue';" + script],
    { encoding: 'utf8', timeout: 60000 },
  );
  return String(res.stdout || '').trim();
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error('dist/Pharmacy-MIS.exe not found — run npm run build first.');
    process.exit(1);
  }

  // A plain file where a folder is expected: every mkdir against it fails.
  const blocker = path.join(os.tmpdir(), 'pharmis-not-a-folder-' + process.pid);
  fs.writeFileSync(blocker, 'not a directory', 'utf8');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOME', 'HOMEPATH', 'TEMP', 'TMP']) {
    env[key] = blocker;
  }

  console.log('Starting the exe with every writable location blocked…');
  const child = spawn(EXE, [], { env, stdio: 'ignore', detached: false });

  let title = '';
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    // Any process, not just the launcher's own: the dialog is a MessageBox
    // owned by whichever process put it up, and that has changed once already
    // when the launcher was rewritten from Node to C#.
    title = powershell(
      "(Get-Process -ErrorAction SilentlyContinue "
      + "| Where-Object { $_.MainWindowTitle -like '*Pharmacy MIS*' } "
      + '| Select-Object -First 1 -ExpandProperty MainWindowTitle)',
    );
    if (title) break;
    await sleep(1000);
  }

  const ok = /Pharmacy MIS/.test(title) && /could not start/i.test(title);
  console.log(ok
    ? 'PASS  a failure dialog appeared: "' + title + '"'
    : 'FAIL  no failure dialog appeared within 60s (saw "' + title + '")');

  // Dismiss it and clean up.
  try {
    powershell(
      "Get-Process -ErrorAction SilentlyContinue "
      + "| Where-Object { $_.MainWindowTitle -like '*Pharmacy MIS*' } | Stop-Process -Force",
    );
  } catch { /* nothing to close */ }
  try { child.kill(); } catch { /* already gone */ }
  try { fs.unlinkSync(blocker); } catch { /* leave it */ }

  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });

