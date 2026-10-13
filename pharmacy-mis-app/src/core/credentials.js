'use strict';

const fs = require('fs');
const path = require('path');
const { appDir } = require('./appdata');

/**
 * The saved Amrita HIS login — only when the operator ticks "Remember password".
 *
 * The password is encrypted with Electron's safeStorage, which on Windows is
 * DPAPI: the key belongs to this Windows user on this PC, so the file is
 * useless if copied elsewhere or opened by another account. It is never written
 * in plain text, never hardcoded, never sent to the window (the page only
 * learns that a saved login exists, and for which username), and never logged.
 *
 * Outside the Electron app (the self-test, a bare node run) there is no
 * safeStorage, so nothing can be saved or read and available() is false.
 *
 *   %LOCALAPPDATA%\PharmacyMIS\credentials.json   { username, password: <base64 ciphertext> }
 */

function safeStorage() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('electron');
    return mod && mod.app && mod.safeStorage ? mod.safeStorage : null;
  } catch {
    return null;
  }
}

function credentialsFile() {
  return path.join(appDir(), 'credentials.json');
}

/** Whether this machine/session can encrypt at all (Windows user profile available). */
function available() {
  const s = safeStorage();
  try { return !!s && s.isEncryptionAvailable(); } catch { return false; }
}

/** Encrypt and store. Returns false (and stores nothing) when encryption is unavailable. */
function save(username, password) {
  if (!username || !password || !available()) return false;
  const encrypted = safeStorage().encryptString(password).toString('base64');
  try {
    fs.writeFileSync(credentialsFile(), JSON.stringify({ username, password: encrypted }, null, 2), 'utf8');
    return true;
  } catch (err) {
    throw new Error(`Could not save the login (${err.message}).`);
  }
}

/** { username, password } as saved, or null when there is none or it cannot be decrypted. */
function load() {
  if (!available()) return null;
  try {
    const data = JSON.parse(fs.readFileSync(credentialsFile(), 'utf8'));
    if (!data || !data.username || !data.password) return null;
    return { username: data.username, password: safeStorage().decryptString(Buffer.from(data.password, 'base64')) };
  } catch {
    return null; // missing, corrupt, or encrypted for another Windows user
  }
}

/** What the window is allowed to know: that a login is saved, and whose — never the password. */
function status() {
  const saved = load();
  return { available: available(), hasPassword: !!saved, username: saved ? saved.username : '' };
}

function forget() {
  try { fs.unlinkSync(credentialsFile()); } catch { /* nothing saved */ }
}

module.exports = { save, load, status, forget, available };
