'use strict';

const { execFile } = require('child_process');
const path = require('path');

/**
 * Native Windows file and folder pickers.
 *
 * The window is a WebView2 surface, not a browser tab with privileges, and a
 * dropped file never exposes its full path to page script. So picking is done
 * where the real dialogs live: a short-lived PowerShell process hosting the
 * WinForms/Shell common dialogs. It returns the absolute path on stdout, or an
 * empty string when the user cancels.
 *
 * -STA is required: the common dialogs will not open on an MTA thread.
 */

const PS = 'powershell.exe';
const TIMEOUT_MS = 5 * 60 * 1000; // a user may leave the dialog open a while

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      PS,
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.killed) return reject(new Error('The file dialog timed out.'));
        if (err) return reject(new Error(`Could not open the dialog: ${stderr || err.message}`));
        resolve(String(stdout).trim());
      },
    );
  });
}

/** Escape a string for a PowerShell single-quoted literal. */
function psQuote(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

/**
 * Folder picker. Uses the modern Shell "open folder" dialog via a
 * FolderBrowserDialog, seeded at `initial` when one is given.
 */
async function pickFolder({ title = 'Select a folder', initial = '' } = {}) {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '${psQuote(title)}'
$d.ShowNewFolderButton = $true
$d.UseDescriptionForTitle = $true
$seed = '${psQuote(initial)}'
if ($seed -and (Test-Path -LiteralPath $seed)) { $d.SelectedPath = $seed }
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
`;
  const out = await runPowerShell(script);
  return out || null;
}

/** File picker, filtered to the formats the portal exports. */
async function pickFile({ title = 'Select a file', initial = '' } = {}) {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = '${psQuote(title)}'
$d.Filter = 'Report files (*.csv;*.xlsx)|*.csv;*.xlsx|CSV files (*.csv)|*.csv|Excel files (*.xlsx)|*.xlsx|All files (*.*)|*.*'
$d.Multiselect = $false
$seed = '${psQuote(initial)}'
if ($seed -and (Test-Path -LiteralPath $seed)) { $d.InitialDirectory = $seed }
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }
`;
  const out = await runPowerShell(script);
  return out || null;
}

/** Reveal a file in Explorer with it selected, or open a folder. */
function revealInExplorer(target) {
  return new Promise((resolve) => {
    const args = path.extname(target) ? ['/select,', target] : [target];
    execFile('explorer.exe', args, { windowsHide: false }, () => resolve());
  });
}

/** Open a file with whatever Windows has associated with it (Excel, usually). */
function openWithDefaultApp(target) {
  return new Promise((resolve, reject) => {
    execFile(
      PS,
      ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${psQuote(target)}'`],
      { windowsHide: true },
      (err) => (err ? reject(new Error(`Could not open ${path.basename(target)}: ${err.message}`)) : resolve()),
    );
  });
}

module.exports = { pickFolder, pickFile, revealInExplorer, openWithDefaultApp };
