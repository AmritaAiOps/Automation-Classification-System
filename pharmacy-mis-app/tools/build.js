'use strict';

/**
 * The one production build.
 *
 *   npm run build   ->   dist/Pharmacy-MIS.exe
 *                        dist/Pharmacy-MIS.exe.sha256
 *
 * Those two files are the entire release, and only the first is needed to run
 * the application. Nothing in this file runs on the customer's machine.
 *
 * Steps:
 *   1  bake the Excel reference workbook into the app, so the exe carries the
 *      master report's exact formatting and no reference folder is shipped
 *   2  run the source self-test — shipping wrong figures is worse than not
 *      shipping
 *   3  have electron-builder assemble the Electron application. The portal
 *      automation drives the customer's own Microsoft Edge, so no browser is
 *      shipped
 *   4  trim what the application never loads
 *   5  zip it (Deflate) into one payload
 *   6  compile the launcher and append the payload to it
 *   7  verify the artefact and write its SHA-256
 *
 * The launcher is C# compiled by csc.exe, which ships with Windows — see
 * tools/launcher/Launcher.cs for why it is not the Node single executable it
 * used to be (short version: that spent 91 MB, half the release, on a runtime
 * whose only job was to decompress and spawn).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, 'build');
const LAUNCHER = path.join(__dirname, 'launcher');
const UNPACKED = path.join(BUILD, 'win-unpacked');
const EXE_NAME = 'Pharmacy-MIS.exe';
const EXE = path.join(DIST, EXE_NAME);
const REFERENCE = path.join(ROOT, '..', 'reference', 'Daily Report for coding.xlsx');

/** Written at the end of the exe so the launcher can find its own payload. */
const TRAILER_MAGIC = 'PHMISPZ1';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let stepNo = 0;
const TOTAL = 7;
function step(text) {
  stepNo += 1;
  console.log('\n[' + stepNo + '/' + TOTAL + '] ' + text);
}

const human = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';

function run(cmd, args, opts) {
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function capture(cmd, args, opts) {
  return execFileSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts });
}

/* ------------------------------------------------------------------ *
 * The C# compiler
 * ------------------------------------------------------------------ */

/**
 * csc.exe from the in-box .NET Framework. It is at a fixed path on every
 * Windows install and needs no SDK, no Visual Studio and no download — which
 * is the point: the build tool for the launcher is already on the machine.
 */
function findCsc() {
  const csc = path.join(process.env.SystemRoot || 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (fs.existsSync(csc)) return csc;
  throw new Error(
    'csc.exe (the in-box .NET Framework C# compiler) was not found at ' + csc + '. '
    + 'It ships with Windows; on a machine where .NET Framework 4.x is disabled, enable it and build again.',
  );
}

/* ------------------------------------------------------------------ *
 * PE inspection
 * ------------------------------------------------------------------ */

/**
 * Run a PowerShell snippet and return its stdout. The exit code is deliberately
 * ignored: PowerShell reports non-zero whenever the last command set $? to
 * false (Get-Process does, even under -ErrorAction SilentlyContinue), which made
 * the release checks claim a window was missing while it was plainly there.
 */
function powershell(script) {
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='SilentlyContinue';" + script],
    { encoding: 'utf8', timeout: 120000 },
  );
  return String(res.stdout || '').trim();
}

/** 2 = Windows GUI, 3 = console. */
function readSubsystem(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(0x40);
    fs.readSync(fd, head, 0, head.length, 0);
    if (head.toString('ascii', 0, 2) !== 'MZ') throw new Error('not a PE file (no MZ header)');
    const pe = head.readUInt32LE(0x3c);
    const opt = Buffer.alloc(72);
    fs.readSync(fd, opt, 0, opt.length, pe + 4 + 20);
    return opt.readUInt16LE(68);
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------------------------------------------ *
 * Payload
 * ------------------------------------------------------------------ */

/** Deflate zip of a folder's contents — the .NET Framework the launcher runs on reads it natively. */
function zipFolder(dir, zipFile) {
  fs.rmSync(zipFile, { force: true });
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; '
    + "[IO.Compression.ZipFile]::CreateFromDirectory('" + dir + "', '" + zipFile + "', 'Optimal', $false)"],
  { stdio: 'inherit' });
}

/**
 * The payload goes after the PE image, with a 16-byte trailer (payload length,
 * magic) the launcher reads backwards from the end of its own file.
 */
function appendPayload(exe, payload) {
  const trailer = Buffer.alloc(16);
  trailer.writeBigUInt64LE(BigInt(payload.length), 0);
  trailer.write(TRAILER_MAGIC, 8, 'ascii');
  fs.appendFileSync(exe, payload);
  fs.appendFileSync(exe, trailer);
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

function main() {
  const started = Date.now();
  const csc = findCsc();
  const icon = path.join(ROOT, 'assets', 'icon.ico');
  if (!fs.existsSync(icon)) throw new Error('Missing ' + icon + ' (it is committed; restore it from git).');

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  fs.mkdirSync(BUILD, { recursive: true });

  // ---- 1. embed the reference workbook ----------------------------------
  step('Bake the Excel reference workbook into the app');
  if (fs.existsSync(REFERENCE)) {
    run(process.execPath, [path.join(__dirname, 'gen-template.js'), REFERENCE]);
  } else {
    console.log('  reference workbook not found at ' + REFERENCE);
    console.log('  keeping the template already baked into src/excel/template.js');
  }

  // ---- 2. gate on the source self-test -----------------------------------
  step('Run the source self-test');
  try {
    const out = capture(process.execPath, [path.join(__dirname, 'selftest.js')]);
    console.log('  ' + (out.trim().split('\n').filter((l) => /\d+ passed, \d+ failed/.test(l)).pop() || 'passed').trim());
  } catch (err) {
    console.error(String((err.stdout || '') + (err.stderr || '')).split('\n').filter((l) => /FAIL/.test(l)).join('\n'));
    throw new Error('The source self-test failed — refusing to build.');
  }

  // ---- 3. assemble the Electron application ------------------------------
  step('Assemble the Electron application');
  const builderCli = require.resolve('electron-builder/out/cli/cli.js');
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  delete env.ELECTRON_RUN_AS_NODE;
  run(process.execPath, [builderCli, '--win', '--x64', '--dir', '--publish', 'never'], { env });

  if (!fs.existsSync(UNPACKED)) throw new Error('electron-builder did not produce ' + UNPACKED);
  if (!fs.existsSync(path.join(UNPACKED, 'Pharmacy MIS.exe'))) {
    throw new Error('Missing ' + path.join(UNPACKED, 'Pharmacy MIS.exe'));
  }

  // ---- 4. trim -----------------------------------------------------------
  step('Trim resources the application never loads');
  let trimmed = 0;
  const locales = path.join(UNPACKED, 'locales');
  for (const name of fs.readdirSync(locales)) {
    if (name === 'en-US.pak') continue;
    trimmed += fs.statSync(path.join(locales, name)).size;
    fs.rmSync(path.join(locales, name));
  }
  // elevate.exe is only used by an installer asking for administrator rights.
  // This application never elevates, and shipping an unused helper exe only
  // gives antivirus something extra to be unhappy about.
  const elevate = path.join(UNPACKED, 'resources', 'elevate.exe');
  if (fs.existsSync(elevate)) { trimmed += fs.statSync(elevate).size; fs.rmSync(elevate); }
  console.log('  removed ' + human(trimmed) + ' of unused locales and helpers');

  // ---- 5. payload --------------------------------------------------------
  step('Zip the application');
  const payloadFile = path.join(BUILD, 'app.zip');
  zipFolder(UNPACKED, payloadFile);
  const payload = fs.readFileSync(payloadFile);
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
  console.log('  ' + human(payload.length) + ' zipped');

  // ---- 7. the launcher ---------------------------------------------------
  step('Compile the launcher and append the payload');

  // Version and identity come from package.json. The C# compiler turns these
  // assembly attributes into the Windows version resource, which is what
  // Explorer, Task Manager and the SmartScreen prompt read — so no separate
  // resource-editing step is needed.
  const quad = (pkg.version + '.0.0.0').split('.').slice(0, 4).join('.');
  const buildInfo = [
    '// GENERATED BY tools/build.js — do not edit.',
    'using System.Reflection;',
    '',
    '[assembly: AssemblyProduct(' + JSON.stringify(pkg.productName) + ')]',
    '[assembly: AssemblyTitle(' + JSON.stringify(pkg.description) + ')]',
    '[assembly: AssemblyCompany(' + JSON.stringify(pkg.author) + ')]',
    '[assembly: AssemblyCopyright(' + JSON.stringify('Copyright \u00a9 ' + pkg.author) + ')]',
    '[assembly: AssemblyVersion(' + JSON.stringify(quad) + ')]',
    '[assembly: AssemblyFileVersion(' + JSON.stringify(quad) + ')]',
    '[assembly: AssemblyInformationalVersion(' + JSON.stringify(pkg.version) + ')]',
    '',
    'internal static class BuildInfo',
    '{',
    '    public const string Version = ' + JSON.stringify(pkg.version) + ';',
    '    public const string PayloadHash = ' + JSON.stringify(payloadHash) + ';',
    '}',
    '',
  ].join('\n');
  const buildInfoFile = path.join(BUILD, 'BuildInfo.cs');
  fs.writeFileSync(buildInfoFile, buildInfo, 'utf8');

  // /target:winexe is what makes this a GUI-subsystem binary, so Windows never
  // gives it a console window on a double-click.
  run(csc, [
    '-nologo',
    '-optimize+',
    '-platform:x64',
    '-target:winexe',
    '-r:System.IO.Compression.dll',
    '-r:System.IO.Compression.FileSystem.dll',
    '-win32icon:' + icon,
    '-out:' + EXE,
    path.join(LAUNCHER, 'Launcher.cs'),
    buildInfoFile,
  ]);

  const launcherSize = fs.statSync(EXE).size;
  console.log('  launcher: ' + (launcherSize / 1024).toFixed(0) + ' KB');

  appendPayload(EXE, payload);

  // ---- 8. verify ---------------------------------------------------------
  step('Verify the built exe');

  const subsystem = readSubsystem(EXE);
  if (subsystem !== 2) throw new Error('The exe is subsystem ' + subsystem + ', not 2 (Windows GUI).');
  console.log('  PE subsystem 2 (Windows GUI) — no console window on launch');

  const tail = Buffer.alloc(16);
  const fd = fs.openSync(EXE, 'r');
  try { fs.readSync(fd, tail, 0, 16, fs.statSync(EXE).size - 16); } finally { fs.closeSync(fd); }
  if (tail.toString('ascii', 8, 16) !== TRAILER_MAGIC) throw new Error('The payload trailer is not at the end of the exe.');
  console.log('  payload trailer present, ' + human(Number(tail.readBigUInt64LE(0))) + ' zipped');

  // Run it from somewhere that is not the project, so a build can never pass
  // on a path that only resolves here.
  const smoke = capture(EXE, ['--cli', '--help'], { cwd: os.tmpdir(), stdio: 'pipe' });
  if (!/Pharmacy MIS/.test(smoke)) throw new Error('The built exe did not answer --cli --help');
  console.log('  exe answers --cli --help, run from ' + os.tmpdir());

  const hash = crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex');
  fs.writeFileSync(EXE + '.sha256', hash + ' *' + EXE_NAME + '\n', 'utf8');

  const size = fs.statSync(EXE).size;
  const line = '='.repeat(66);
  console.log('\n' + line);
  console.log('  ' + EXE_NAME + '   ' + human(size));
  console.log('  ' + EXE);
  console.log('  version ' + pkg.version + ', built in ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
  console.log('  sha256  ' + hash);
  console.log(line);
  console.log('\nThe customer receives this one file. Nothing else is needed to run it.');
  console.log('Verify the release against the real reference data with:  npm run release-test\n');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('\nBuild failed: ' + (err && err.message ? err.message : err));
    process.exit(1);
  }
}

// Shared with tools/check-unpack-recovery.js, which builds a small stand-in
// launcher exactly the way this build makes the real one.
module.exports = { main, findCsc, zipFolder, appendPayload, readSubsystem, powershell };
