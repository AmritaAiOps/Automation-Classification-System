'use strict';

/**
 * The release check. Run it after a build:
 *
 *   npm run release-test
 *
 * It tests dist/Pharmacy-MIS.exe as a customer would, and nothing else. The
 * source tree, node_modules and the reference folder are never visible to the
 * exe under test: the only things placed in the scratch directory are the exe
 * itself and copies of the three raw input files, renamed so that nothing can
 * be recognised by filename.
 *
 * If this passes, the exe on its own is the whole product.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ExcelJS = require('exceljs');
const { readSubsystem, powershell } = require('./build');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'Pharmacy-MIS.exe');
const REFERENCE = path.join(ROOT, '..', 'reference');

/** The figures the reference dataset must produce, from the mapping document. */
const EXPECTED = { C: 21, D: 29, E: 26, F: 31, G: 1674801.30, H: 80, I: 169, J: 2656763.31 };

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, note) {
  if (ok) { pass += 1; console.log('  PASS  ' + name + (note ? '  — ' + note : '')); }
  else { fail += 1; failures.push(name); console.log('  FAIL  ' + name + (note ? '\n          ' + note : '')); }
  return !!ok;
}

function section(title) { console.log('\n' + title); }

/**
 * Run the exe and hand back its output. stdio is piped, which is how a
 * GUI-subsystem binary's output is captured — see tools/launcher/Launcher.cs.
 */
function runExe(exe, args, opts = {}) {
  const res = spawnSync(exe, args, {
    encoding: 'utf8',
    timeout: opts.timeout || 300000,
    cwd: opts.cwd || os.tmpdir(),
    env: opts.env || process.env,
  });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || ''), error: res.error };
}

async function main() {
  console.log('Pharmacy MIS — release check');
  console.log('exe under test: ' + EXE);

  /* ---------------------------------------------------------------- *
   * 1. the artefact
   * ---------------------------------------------------------------- */
  section('1 · The release artefact');

  if (!check('dist/Pharmacy-MIS.exe exists', fs.existsSync(EXE), 'run npm run build first')) {
    return finish();
  }

  const size = fs.statSync(EXE).size;
  check('exe is a plausible size', size > 20 * 1024 * 1024, (size / 1024 / 1024).toFixed(1) + ' MB');

  const hashFile = EXE + '.sha256';
  if (check('SHA-256 sidecar written', fs.existsSync(hashFile))) {
    const recorded = fs.readFileSync(hashFile, 'utf8').split(' ')[0].trim();
    const actual = crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex');
    check('SHA-256 matches the exe', recorded === actual, recorded.slice(0, 16) + '…');
  }

  const dist = fs.readdirSync(path.join(ROOT, 'dist')).sort();
  check('dist/ holds only the deliverable and its checksum',
    JSON.stringify(dist) === JSON.stringify(['Pharmacy-MIS.exe', 'Pharmacy-MIS.exe.sha256']),
    dist.join(', '));

  const info = JSON.parse(powershell(
    "$v = (Get-Item -LiteralPath '" + EXE + "').VersionInfo; [pscustomobject]@{"
    + 'ProductName=$v.ProductName;FileDescription=$v.FileDescription;CompanyName=$v.CompanyName;'
    + 'ProductVersion=$v.ProductVersion} | ConvertTo-Json -Compress',
  ));
  check('Windows shows the product name', info.ProductName === 'Pharmacy MIS', info.ProductName);
  check('Windows shows a real file description', /Daily Purchase/.test(info.FileDescription || ''), info.FileDescription);
  check('Windows shows the company', /Sudhamayi/.test(info.CompanyName || ''), info.CompanyName);
  check('the exe does not identify itself as Node.js',
    !/node/i.test(String(info.ProductName) + info.FileDescription));

  const subsystem = readSubsystem(EXE);
  check('exe is a Windows GUI binary (no console window)', subsystem === 2, 'PE subsystem ' + subsystem);

  check('exe carries an icon resource', /True/i.test(powershell(
    "Add-Type -AssemblyName System.Drawing; "
    + "$i = [System.Drawing.Icon]::ExtractAssociatedIcon('" + EXE + "'); ($i -ne $null)",
  )));

  /* ---------------------------------------------------------------- *
   * 2. a clean customer machine, simulated
   * ---------------------------------------------------------------- */
  section('2 · An isolated customer folder (exe + input files only)');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmis-release-'));
  const customerDir = path.join(scratch, 'PharmacyMIS-Customer-Test');
  const inputsDir = path.join(customerDir, 'day-inputs');
  const archiveDir = path.join(customerDir, 'archive');
  fs.mkdirSync(inputsDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  const customerExe = path.join(customerDir, 'Pharmacy-MIS.exe');
  fs.copyFileSync(EXE, customerExe);

  // Renamed on purpose: identification is by column layout, and the release
  // check should prove that rather than take it on trust.
  const sources = [
    ['Pharmacy PRQ Details(1).CSV', 'export-one.csv'],
    ['Purchase Order Detail Report - Pharmacy.xlsx', 'export-two.xlsx'],
    ['Purchase Report Pharmacy Detail (1).CSV', 'export-three.csv'],
  ];
  for (const [from, to] of sources) {
    const src = path.join(REFERENCE, from);
    if (!fs.existsSync(src)) { check('reference input present: ' + from, false, src); return finish(scratch); }
    fs.copyFileSync(src, path.join(inputsDir, to));
  }
  // Something that is not a report at all, to prove extra files are ignored.
  fs.writeFileSync(path.join(inputsDir, 'notes.csv'), 'a,b,c\n1,2,3\n', 'utf8');

  check('customer folder holds only the exe and the data folders',
    fs.readdirSync(customerDir).sort().join(', ') === 'Pharmacy-MIS.exe, archive, day-inputs');
  check('no source, node_modules or reference folder is reachable from it',
    !fs.existsSync(path.join(customerDir, 'src'))
    && !fs.existsSync(path.join(customerDir, 'node_modules'))
    && !fs.existsSync(path.join(customerDir, 'reference')));

  /* ---------------------------------------------------------------- *
   * 3. the exe's own diagnostic
   * ---------------------------------------------------------------- */
  section('3 · The built-in self test, run from inside the exe');

  const expectArg = Object.entries(EXPECTED).map(([k, v]) => k + '=' + v).join(',');
  const st = runExe(customerExe, ['--cli', '--self-test', '--inputs', inputsDir, '--expect', expectArg], {
    cwd: customerDir,
  });
  const stFailures = st.out.split('\n').filter((l) => l.startsWith('FAIL'));
  check('built-in self test passes', st.code === 0 && stFailures.length === 0,
    stFailures.join('\n          ') || ('exit ' + st.code));
  const summary = (st.out.split('\n').filter((l) => /\d+ passed, \d+ failed/.test(l)).pop() || '').trim();
  if (summary) console.log('        ' + summary);

  /* ---------------------------------------------------------------- *
   * 4. the real thing, against the reference dataset
   * ---------------------------------------------------------------- */
  section('4 · A real run against the reference dataset');

  const jsonOut = path.join(scratch, 'run.json');
  const run = runExe(customerExe, [
    '--cli', '--root', archiveDir, '--inputs', inputsDir, '--date', '2026-08-08', '--out', jsonOut,
  ], { cwd: customerDir });

  if (!check('run completed successfully', run.code === 0, 'exit ' + run.code + '\n' + run.out.slice(-800))) {
    return finish(scratch);
  }

  const result = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
  check('the run reports success', result.ok === true, result.error || '');
  check('all three source files were identified', (result.sources || []).length === 3,
    (result.sources || []).map((s) => s.name + '->' + s.kind).join(', '));
  check('the file that is not a report was skipped',
    (result.unidentified || []).some((u) => /notes\.csv/.test(u.file)));

  /* ---------------------------------------------------------------- *
   * 5. the workbook it produced
   * ---------------------------------------------------------------- */
  section('5 · The generated master workbook');
  // Cell-level figures, formats and update/append/rollover are asserted by
  // tools/selftest.js on the same code; the exe's --self-test (section 3)
  // already checks every figure. Only exe-specific checks stay here.

  const master = result.layout.masterFile;
  check('master workbook written where expected',
    fs.existsSync(master) && master.startsWith(archiveDir), master);
  check('folder convention followed',
    /Pharmacy-MIS[\\/]2026[\\/]08-August[\\/]outputs[\\/]Master_Report_August_2026\.xlsx$/.test(master));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(master);
  const ws = wb.getWorksheet('Daily Report');
  if (check('the "Daily Report" sheet is there', !!ws)) {
    // Compared against the reference workbook rather than assumed to be
    // non-empty: the reference has no merges today, and the check should fail
    // if a future reference gains some and the writer drops them.
    const refWb = new ExcelJS.Workbook();
    await refWb.xlsx.readFile(path.join(REFERENCE, 'Daily Report for coding.xlsx'));
    const refMerges = JSON.stringify((refWb.getWorksheet('Daily Report').model.merges || []).sort());
    const gotMerges = JSON.stringify((ws.model.merges || []).sort());
    check('merged cells match the reference workbook', refMerges === gotMerges,
      'reference ' + refMerges + ', generated ' + gotMerges);
  }
  check('Monthly Summary sheet preserved', !!wb.getWorksheet('Monthly Summary'));

  /* ---------------------------------------------------------------- *
   * 6. error handling
   * ---------------------------------------------------------------- */
  section('6 · Error handling');

  const noRoot = runExe(customerExe, ['--cli', '--inputs', inputsDir], { cwd: customerDir });
  check('a missing --root is refused with an explanation',
    noRoot.code === 2 && /--root is required/.test(noRoot.out));

  const badFolder = runExe(customerExe, ['--cli', '--root', archiveDir, '--inputs',
    path.join(customerDir, 'not-here'), '--date', '2026-08-08'], { cwd: customerDir });
  check('a missing inputs folder is reported clearly',
    badFolder.code === 1 && /does not exist/i.test(badFolder.out));

  const emptyDir = path.join(scratch, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  const noFiles = runExe(customerExe, ['--cli', '--root', archiveDir, '--inputs', emptyDir, '--date', '2026-08-08'],
    { cwd: customerDir });
  check('an empty inputs folder is reported clearly',
    noFiles.code === 1 && /No \.csv or \.xlsx/i.test(noFiles.out));

  const junkDir = path.join(scratch, 'junk');
  fs.mkdirSync(junkDir, { recursive: true });
  fs.writeFileSync(path.join(junkDir, 'broken.csv'), 'not,a,report\n1,2,3\n', 'utf8');
  fs.writeFileSync(path.join(junkDir, 'empty.csv'), '', 'utf8');
  fs.writeFileSync(path.join(junkDir, 'notreally.xlsx'), 'this is not a spreadsheet', 'utf8');
  const junk = runExe(customerExe, ['--cli', '--root', archiveDir, '--inputs', junkDir, '--date', '2026-08-12'],
    { cwd: customerDir });
  check('unreadable and unrecognised files are refused, not crashed',
    junk.code === 1 && /matched a known report layout/i.test(junk.out));

  // A PRQ file on its own: the columns it feeds are filled, the rest untouched.
  const partialDir = path.join(scratch, 'partial');
  fs.mkdirSync(partialDir, { recursive: true });
  fs.copyFileSync(path.join(inputsDir, 'export-one.csv'), path.join(partialDir, 'only-one.csv'));
  const partial = runJson(customerExe, archiveDir, partialDir, '2026-08-13', scratch, 'partial.json');
  check('a run with only the PRQ file still succeeds', partial.ok === true, partial.error || '');
  check('C is still computed from it', partial.fields.C === 21);
  check('the PO and GRN columns are left alone', partial.fields.E === null && partial.fields.H === null);

  /* ---------------------------------------------------------------- *
   * 7. independence from the machine it was built on
   * ---------------------------------------------------------------- */
  section('7 · Independence from the developer machine');

  // Different working directories, including a couple of real user folders.
  const home = os.homedir();
  const cwds = [
    ['the customer folder', customerDir],
    ['Desktop', path.join(home, 'Desktop')],
    ['Downloads', path.join(home, 'Downloads')],
    ['C:\\', 'C:\\'],
    ['the Windows temp folder', os.tmpdir()],
  ].filter(([, dir]) => fs.existsSync(dir));

  for (const [label, cwd] of cwds) {
    const r = runExe(customerExe, ['--cli', '--root', archiveDir, '--inputs', inputsDir,
      '--date', '2026-08-08', '--dry-run', '--json'], { cwd });
    let ok = false;
    try { ok = r.code === 0 && JSON.parse(r.out).fields.C === 21; } catch { ok = false; }
    check('runs correctly with the working directory set to ' + label, ok, cwd);
  }

  // The customer may rename it.
  const renamed = path.join(customerDir, 'Daily Report Tool.exe');
  fs.copyFileSync(customerExe, renamed);
  const afterRename = runExe(renamed, ['--cli', '--root', archiveDir, '--inputs', inputsDir,
    '--date', '2026-08-08', '--dry-run', '--json'], { cwd: 'C:\\' });
  let renameOk = false;
  try { renameOk = afterRename.code === 0 && JSON.parse(afterRename.out).fields.J === 2656763.31; } catch { /* no */ }
  check('still works after the customer renames the exe', renameOk);
  fs.rmSync(renamed, { force: true });

  // Nothing developer-shaped on PATH: no node, no npm, no python, no project.
  const bareEnv = { ...process.env, PATH: 'C:\\Windows\\System32;C:\\Windows' };
  delete bareEnv.NODE_OPTIONS;
  delete bareEnv.ELECTRON_RUN_AS_NODE;
  const bare = runExe(customerExe, ['--cli', '--root', archiveDir, '--inputs', inputsDir,
    '--date', '2026-08-08', '--dry-run', '--json'], { cwd: customerDir, env: bareEnv });
  let bareOk = false;
  try { bareOk = bare.code === 0 && JSON.parse(bare.out).fields.C === 21; } catch { /* no */ }
  check('runs with node, npm and python removed from PATH', bareOk, bare.out.slice(-300));

  // Nothing may be written beside the exe — it could be on read-only media.
  check('nothing new was written beside the exe',
    fs.readdirSync(customerDir).sort().join(', ') === 'Pharmacy-MIS.exe, archive, day-inputs',
    fs.readdirSync(customerDir).join(', '));

  /* ---------------------------------------------------------------- *
   * 8. the window
   * ---------------------------------------------------------------- */
  section('8 · The application window');
  await guiCheck(customerExe);

  /* ---------------------------------------------------------------- *
   * 9. logs
   * ---------------------------------------------------------------- */
  section('9 · Logging');
  const logDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'PharmacyMIS', 'logs');
  check('the application keeps logs in the user profile', fs.existsSync(logDir), logDir);
  if (fs.existsSync(logDir)) {
    const newest = fs.readdirSync(logDir)
      .map((f) => ({ f, m: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    check('a log was written during this check', newest && Date.now() - newest.m < 15 * 60 * 1000,
      newest ? newest.f : 'none');
  }

  /* ---------------------------------------------------------------- *
   * 10. failures reach somewhere the customer can find
   * ---------------------------------------------------------------- */
  section('10 · Failures are written where the customer can find them');

  // %LOCALAPPDATA% is hidden and means nothing to a pharmacy user, so every
  // failure is mirrored into Documents. This proves it happens for a real
  // failed run, not just in theory.
  const errorLog = path.join(documentsFolder(), 'Pharmacy MIS', 'Pharmacy MIS - Error Log.txt');
  const sizeBefore = fs.existsSync(errorLog) ? fs.statSync(errorLog).size : 0;

  runExe(customerExe, ['--cli', '--root', archiveDir, '--inputs',
    path.join(customerDir, 'definitely-not-here'), '--date', '2026-08-08'], { cwd: customerDir });

  const appeared = fs.existsSync(errorLog);
  check('a failed run writes an error log into Documents', appeared, errorLog);
  if (appeared) {
    const grew = fs.statSync(errorLog).size > sizeBefore;
    check('the failure was appended to it', grew);
    const text = fs.readFileSync(errorLog, 'utf8').slice(-4000);
    check('it names the application', /Pharmacy MIS/.test(text));
    check('it says what went wrong in plain words',
      /could not be generated/i.test(text) && /does not exist/i.test(text));
    check('it points at the full technical log', /Full technical log:/.test(text));
    check('it tells the customer what to do', /send this file to your IT contact/i.test(text));
  }

  return finish(scratch);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * The customer's Documents folder, resolved the same way the application does
 * — it is commonly redirected to OneDrive, and checking the wrong one would
 * pass while the customer finds nothing.
 */
function documentsFolder() {
  const viaShell = powershell('[Environment]::GetFolderPath("MyDocuments")');
  if (viaShell && fs.existsSync(viaShell)) return viaShell;
  return path.join(os.homedir(), 'Documents');
}

function runJson(exe, root, inputs, date, scratch, name) {
  const out = path.join(scratch, name);
  runExe(exe, ['--cli', '--root', root, '--inputs', inputs, '--date', date, '--out', out]);
  try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch { return { ok: false, error: 'no result file' }; }
}

/**
 * Start the exe the way a customer does — no arguments — and confirm a real
 * application window appears and stays up, then close it and confirm the
 * processes go away. This is the check the old build would have failed: its
 * window died about a second after opening.
 */
async function guiCheck(exe) {
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(exe, [], { env, stdio: 'ignore', detached: false });

  const findWindow = () => {
    try {
      return powershell(
        "(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*Pharmacy MIS*' } "
        + '| Select-Object -First 1 -ExpandProperty MainWindowTitle)',
      );
    } catch { return ''; }
  };

  let title = '';
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    title = findWindow();
    if (title) break;
    await sleep(1000);
  }
  check('a window opens when the exe is double-clicked', !!title, title || 'no window appeared within 90s');

  if (title) {
    // The old build's window died about a second in. Give it long enough that
    // that failure could not be missed.
    await sleep(15000);
    const stillThere = findWindow();
    check('the window is still open 15 seconds later', !!stillThere, stillThere || 'the window closed on its own');
  }

  try {
    powershell(
      "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*Pharmacy MIS*' } "
      + '| ForEach-Object { $_.CloseMainWindow() | Out-Null }',
    );
  } catch { /* closing is best effort */ }

  // Shutdown is expected to be prompt: main.js ends the event streams rather
  // than waiting on them, and force-exits 2.5 s after quit if anything is
  // still holding the process. Ten seconds is a generous allowance for that.
  await sleep(10000);
  const leftover = (() => {
    try {
      return powershell(
        "(Get-Process -Name 'Pharmacy MIS','Pharmacy-MIS' -ErrorAction SilentlyContinue | Measure-Object).Count",
      );
    } catch { return '?'; }
  })();
  check('closing the window shuts the application down', leftover === '0', leftover + ' process(es) left');

  try { child.kill(); } catch { /* already gone */ }
  try {
    powershell("Get-Process -Name 'Pharmacy MIS','Pharmacy-MIS' -ErrorAction SilentlyContinue | Stop-Process -Force");
  } catch { /* nothing to clean */ }
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function finish(scratch) {
  if (scratch) {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* leave it */ }
  }
  console.log('\n' + '='.repeat(62));
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail) console.log('\nfailed:\n  - ' + failures.join('\n  - '));
  console.log('='.repeat(62));
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\nrelease check crashed:\n', err);
  process.exit(1);
});
