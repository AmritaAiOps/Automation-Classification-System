'use strict';

const path = require('path');

/**
 * File and folder pickers, and the two "show me the result" actions.
 *
 * These are Electron's own native dialogs: part of the binary, modal to the app
 * window, no external process. The only caller is the app's in-process server
 * (src/app/main.js); the headless --self-test/--cli paths never reach them, so
 * outside Electron they simply refuse.
 */

/** Electron; throws when this module is used outside the app process. */
function electron() {
  // eslint-disable-next-line global-require
  const mod = require('electron');
  if (mod && mod.dialog && mod.app) return mod;
  throw new Error('This action is only available inside the app window.');
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

async function pick(properties, filters, title, initial) {
  const mod = electron();
  const win = focusedWindow(mod);
  const options = { title, properties, filters, defaultPath: initial || undefined };
  const res = win
    ? await mod.dialog.showOpenDialog(win, options)
    : await mod.dialog.showOpenDialog(options);
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
}

const pickFolder = ({ title = 'Select a folder', initial = '' } = {}) =>
  pick(['openDirectory', 'createDirectory'], undefined, title, initial);

const pickFile = ({ title = 'Select a file', initial = '' } = {}) =>
  pick(['openFile'], FILE_FILTERS, title, initial);

/** Reveal a file in Explorer with it selected, or open a folder. */
async function revealInExplorer(target) {
  const mod = electron();
  if (path.extname(target)) mod.shell.showItemInFolder(target);
  else await mod.shell.openPath(target);
}

/** Open a file with whatever Windows has associated with it (Excel, usually). */
async function openWithDefaultApp(target) {
  // openPath resolves to '' on success and to a message on failure, rather
  // than rejecting — so the failure has to be turned into one by hand.
  const problem = await electron().shell.openPath(target);
  if (problem) throw new Error('Could not open ' + path.basename(target) + ': ' + problem);
}

/** Open a web page in the operator's normal browser (the "Open HIS" button). Only http(s). */
async function openUrl(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { throw new Error('The HIS URL in Settings is not a valid address.'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('The HIS URL in Settings must start with http:// or https://');
  await electron().shell.openExternal(parsed.href);
}

module.exports = { pickFolder, pickFile, revealInExplorer, openWithDefaultApp, openUrl };
