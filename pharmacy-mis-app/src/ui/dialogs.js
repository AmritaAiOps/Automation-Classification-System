'use strict';

const path = require('path');
const { execFile } = require('child_process');

/**
 * File and folder pickers, and the two "show me the result" actions.
 *
 * Inside the app window these are Electron's own native dialogs: they are part
 * of the binary, they are modal to the app window, and they need no external
 * process. The previous build shelled out to powershell.exe hosting WinForms,
 * which meant a spawn per click, a visible flicker, and a dependency on
 * PowerShell's execution environment being sane on the customer's machine.
 *
 * The PowerShell path is kept only as a fallback for the headless binary,
 * where there is no Electron app object to parent a dialog to. Nothing in the
 * customer's GUI flow reaches it.
 */

/** Electron, or null when this module is loaded outside the app process. */
function electron() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('electron');
    return mod && mod.dialog && mod.app ? mod : null;
  } catch {
    return null;
  }
}

function focusedWindow(mod) {
  try {
    return mod.BrowserWindow.getFocusedWindow() || mod.BrowserWindow.getAllWindows()[0] || null;
  } catch {
    return null;
  }
}

const FILE_FILTERS = [
  { name: 'Report files', extensions: ['csv', 'xlsx', 'xlsm', 'txt'] },
  { name: 'CSV files', extensions: ['csv'] },
  { name: 'Excel files', extensions: ['xlsx', 'xlsm'] },
  { name: 'All files', extensions: ['*'] },
];

/* ------------------------------------------------------------------ *
 * Pickers
 * ------------------------------------------------------------------ */

async function pickFolder({ title = 'Select a folder', initial = '' } = {}) {
  const mod = electron();
  if (mod) {
    const win = focusedWindow(mod);
    const options = {
      title,
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: initial || undefined,
    };
    const res = win
      ? await mod.dialog.showOpenDialog(win, options)
      : await mod.dialog.showOpenDialog(options);
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  }
  return powershellFolder(title, initial);
}

async function pickFile({ title = 'Select a file', initial = '' } = {}) {
  const mod = electron();
  if (mod) {
    const win = focusedWindow(mod);
    const options = {
      title,
      properties: ['openFile'],
      filters: FILE_FILTERS,
      defaultPath: initial || undefined,
    };
    const res = win
      ? await mod.dialog.showOpenDialog(win, options)
      : await mod.dialog.showOpenDialog(options);
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  }
  return powershellFile(title, initial);
}

/* ------------------------------------------------------------------ *
 * Reveal / open
 * ------------------------------------------------------------------ */

/** Reveal a file in Explorer with it selected, or open a folder. */
async function revealInExplorer(target) {
  const mod = electron();
  if (mod) {
    if (path.extname(target)) mod.shell.showItemInFolder(target);
    else await mod.shell.openPath(target);
    return;
  }
  await new Promise((resolve) => {
    const args = path.extname(target) ? ['/select,', target] : [target];
    execFile('explorer.exe', args, () => resolve());
  });
}

/** Open a file with whatever Windows has associated with it (Excel, usually). */
async function openWithDefaultApp(target) {
  const mod = electron();
  if (mod) {
    // openPath resolves to '' on success and to a message on failure, rather
    // than rejecting — so the failure has to be turned into one by hand.
    const problem = await mod.shell.openPath(target);
    if (problem) throw new Error('Could not open ' + path.basename(target) + ': ' + problem);
    return;
  }
  await new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "Start-Process -FilePath '" + psQuote(target) + "'"],
      { windowsHide: true },
      (err) => (err ? reject(new Error('Could not open ' + path.basename(target) + ': ' + err.message)) : resolve()),
    );
  });
}

/* ------------------------------------------------------------------ *
 * PowerShell fallback (headless only)
 * ------------------------------------------------------------------ */

const PS_TIMEOUT_MS = 5 * 60 * 1000;

function psQuote(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.killed) return reject(new Error('The file dialog timed out.'));
        if (err) return reject(new Error('Could not open the dialog: ' + (stderr || err.message)));
        return resolve(String(stdout).trim());
      },
    );
  });
}

async function powershellFolder(title, initial) {
  const out = await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '${psQuote(title)}'
$d.ShowNewFolderButton = $true
$d.UseDescriptionForTitle = $true
$seed = '${psQuote(initial)}'
if ($seed -and (Test-Path -LiteralPath $seed)) { $d.SelectedPath = $seed }
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
`);
  return out || null;
}

async function powershellFile(title, initial) {
  const out = await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = '${psQuote(title)}'
$d.Filter = 'Report files (*.csv;*.xlsx)|*.csv;*.xlsx|All files (*.*)|*.*'
$d.Multiselect = $false
$seed = '${psQuote(initial)}'
if ($seed -and (Test-Path -LiteralPath $seed)) { $d.InitialDirectory = $seed }
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }
`);
  return out || null;
}

module.exports = { pickFolder, pickFile, revealInExplorer, openWithDefaultApp };
