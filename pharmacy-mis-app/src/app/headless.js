'use strict';

/**
 * The exe's headless half: `--cli`, `--help` and `--self-test`.
 *
 * Same binary, same pipeline, no window. This is what a scheduled task will
 * drive once the portal pull is in place, and what the release check runs
 * against the built exe.
 *
 * A NOTE ON OUTPUT. The shipped exe is a Windows GUI-subsystem binary — that
 * is what stops a console flashing up when the customer double-clicks it. The
 * cost is that when it is started from an interactive Command Prompt, Windows
 * gives it no console to write to, so printed output goes nowhere. Writing to
 * a *pipe* works normally, so anything that spawns the exe (the release check,
 * Task Scheduler with output redirected) still captures everything. For a
 * human at a prompt, `--out <file>` writes the same result as JSON to disk,
 * and every run is appended to the application log regardless.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runDailyReport } = require('../pipeline');
const { log, logFile, errorLogFile } = require('../core/appdata');

const USAGE = `
Pharmacy MIS — daily report mapping (command line)

  --root <folder>     archive root, the folder that holds Pharmacy-MIS/  (required)
  --date <date>       report date, YYYY-MM-DD or DD-MM-YYYY
                      (defaults to the date in the inputs folder name)
  --inputs <folder>   dated inputs folder to scan
  --prq <file>        PRQ Details file      -> columns C, D
  --po <file>         PO Detail Report file -> columns E, F, G
  --grn <file>        Purchase/GRN file     -> columns H, I, J
  --dry-run           compute everything, write nothing
  --quiet             only print warnings and errors
  --json              print the full result as JSON instead of a log
  --out <file>        also write the result as JSON to <file>
  --self-test         run the built-in diagnostic and exit
  -h, --help          this text

Files are identified by their column layout, so --prq/--po/--grn are a
convenience: a file passed in the wrong slot is still placed correctly.

This exe has no console when started by double-click or from an interactive
Command Prompt. Use --out <file> to capture the result, or read the log at:
  %LOCALAPPDATA%\\PharmacyMIS\\logs\\
`;

const FLAGS = new Set(['--dry-run', '--quiet', '--json', '-h', '--help', '--self-test', '--cli']);

function parseArgs(argv) {
  const out = { files: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-')) continue;

    if (FLAGS.has(arg)) {
      if (arg === '--dry-run') out.dryRun = true;
      else if (arg === '--quiet') out.quiet = true;
      else if (arg === '--json') out.json = true;
      else if (arg === '--self-test') out.selfTest = true;
      else if (arg === '--cli') { /* mode switch only */ }
      else out.help = true;
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(arg + ' needs a value');
    i += 1;

    switch (arg) {
      case '--root': out.archiveRoot = path.resolve(value); break;
      case '--date': out.reportDate = value; break;
      case '--inputs': out.inputFolder = path.resolve(value); break;
      case '--prq': out.files.PRQ = path.resolve(value); break;
      case '--po': out.files.PO = path.resolve(value); break;
      case '--grn': out.files.GRN = path.resolve(value); break;
      case '--out': out.outFile = path.resolve(value); break;
      case '--expect': out.expect = value; break;
      default: throw new Error('Unknown option ' + arg);
    }
  }
  return out;
}

/** Write to stdout if there is anywhere for it to go, and always to the log. */
function say(line) {
  try { process.stdout.write(line + '\n'); } catch { /* no console attached */ }
}

function writeOut(file, payload) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
}

/* ------------------------------------------------------------------ *
 * --cli
 * ------------------------------------------------------------------ */

async function runCli(opts) {
  // The Logger falls back to console.log when it has no sink, so --json needs
  // a sink that discards rather than none at all — otherwise the log lines are
  // printed ahead of the JSON and anything parsing stdout chokes on them.
  const sink = opts.json
    ? () => {}
    : (entry) => {
      if (opts.quiet && !['warn', 'error', 'ok'].includes(entry.level)) return;
      if (entry.level === 'debug') return;
      say(entry.level.toUpperCase().padEnd(5) + ' ' + '  '.repeat(entry.indent || 0) + entry.message);
    };

  const result = await runDailyReport(opts, sink);
  if (result.ok) {
    log.info('cli run succeeded');
  } else {
    // A scheduled run has nobody watching it, so its failure has to be
    // findable afterwards: the technical log, and the readable copy in the
    // customer's Documents folder.
    log.error(
      [
        'The daily report could not be generated (scheduled or command-line run).',
        '',
        'What went wrong:  ' + result.error,
        'Archive folder:   ' + (opts.archiveRoot || '(not set)'),
        'Report date:      ' + (opts.reportDate || '(taken from the folder name)'),
        'Inputs folder:    ' + (opts.inputFolder || '(not set)'),
      ].join('\n'),
      (result.log || [])
        .map((e) => e.level.toUpperCase().padEnd(5) + ' ' + '  '.repeat(e.indent || 0) + e.message)
        .join('\n'),
    );
    const where = errorLogFile();
    if (where) say('details written to ' + where);
  }

  writeOut(opts.outFile, { ...result, log: undefined });

  if (opts.json) {
    say(JSON.stringify({ ...result, log: undefined }, null, 2));
  } else if (result.ok) {
    say('');
    say(Object.entries(result.fields).map(([k, v]) => k + '=' + (v == null ? '-' : v)).join('  '));
    say((result.write.written ? 'saved: ' : 'preview: ') + result.layout.masterFile);
    say('row ' + result.write.row + ' ' + result.write.mode + ', ' + result.write.totalRows + ' date row(s)');
  }

  return result.ok ? 0 : 1;
}

/* ------------------------------------------------------------------ *
 * --self-test
 * ------------------------------------------------------------------ */

/**
 * The diagnostic that runs INSIDE the shipped binary, so what it proves is
 * true of the exe the customer has rather than of the source tree. It checks
 * the resources that must be embedded, that the app has somewhere to write,
 * that the local server really serves the page, and — when given inputs —
 * the whole mapping pipeline including the update / append / month-rollover
 * paths that the master workbook depends on.
 */
async function runSelfTest(opts) {
  const checks = [];
  // The Logger prints to the console when it has no sink; the self-test wants
  // its own PASS/FAIL lines and nothing else, so give it one that discards.
  const quiet = () => {};
  const record = (name, ok, note) => {
    checks.push({ name, ok: !!ok, note: note || '' });
    say((ok ? 'PASS  ' : 'FAIL  ') + name + (note ? '  — ' + note : ''));
  };

  say('Pharmacy MIS — built-in self test');
  say('exe:  ' + process.execPath);
  say('cwd:  ' + process.cwd());
  say('log:  ' + logFile());
  say('errors: ' + (errorLogFile() || '(no Documents folder found)'));
  say('');

  // --- embedded resources -------------------------------------------------
  try {
    const ExcelJS = require('exceljs');
    const { templateBuffer } = require('../excel/template');
    const buf = templateBuffer();
    record('embedded report template decodes', buf.length > 10000, buf.length + ' bytes');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('Daily Report');
    record('template has the "Daily Report" sheet', !!ws);
    record('template title band intact', ws && ws.getCell('A1').value === 'Daily Purchase & Inventory MIS Report');
    record('template headers intact', ws && ws.getCell('C2').value === 'Total no of PRQ');
    record('template column widths intact', ws && Math.round(ws.getColumn(3).width) === 15);
    record('template keeps the Monthly Summary sheet', !!wb.getWorksheet('Monthly Summary'));
  } catch (err) {
    record('embedded report template usable', false, err.message);
  }

  try {
    const { page } = require('../ui/page');
    const html = page('selftest-token');
    record('embedded UI page present', html.length > 5000 && html.includes('Pharmacy MIS'));
    record('UI page has no external resources', !/https?:\/\//i.test(html));
  } catch (err) {
    record('embedded UI page present', false, err.message);
  }

  // --- optional scraper must never be load-bearing -------------------------
  try {
    const scraper = require('../scraper');
    record('optional portal scraper loads without crashing', typeof scraper.isAvailable === 'function',
      'available: ' + scraper.isAvailable());
  } catch (err) {
    record('optional portal scraper loads without crashing', false, err.message);
  }

  // --- writable locations --------------------------------------------------
  try {
    const probe = logFile();
    log.info('self-test write probe');
    record('application log directory is writable', fs.existsSync(probe), path.dirname(probe));
  } catch (err) {
    record('application log directory is writable', false, err.message);
  }

  // --- the local server ----------------------------------------------------
  await withServer(async (url, token) => {
    const pageRes = await httpGet(url);
    record('local server serves the application page', pageRes.status === 200 && /<!doctype html>/i.test(pageRes.body));
    const status = await httpGet(url + 'api/status?token=' + token);
    record('local server answers /api/status', status.status === 200 && JSON.parse(status.body).ok === true);
    const forbidden = await httpGet(url + 'api/status?token=wrong');
    record('local server rejects a bad token', forbidden.status === 403);
  }, record);

  // --- the full pipeline ---------------------------------------------------
  if (opts.inputFolder) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmis-selftest-'));
    const base = { archiveRoot: root, inputFolder: opts.inputFolder };

    const first = await runDailyReport({ ...base, reportDate: '2026-08-08' }, quiet);
    record('pipeline run against the given inputs succeeds', first.ok, first.error || '');
    record('master workbook created for a new month', first.ok && first.write.created === true);
    record('first date appended at row 3', first.ok && first.write.row === 3 && first.write.mode === 'appended');
    record('master workbook exists on disk', first.ok && fs.existsSync(first.layout.masterFile));

    if (opts.expect) {
      for (const pair of String(opts.expect).split(',')) {
        const [field, want] = pair.split('=').map((s) => s.trim());
        const got = first.ok ? first.fields[field] : undefined;
        record('column ' + field + ' = ' + want, String(got) === String(Number(want)), 'got ' + got);
      }
    }

    const again = await runDailyReport({ ...base, reportDate: '2026-08-08' }, quiet);
    record('re-running the same date updates in place', again.ok && again.write.mode === 'updated' && again.write.totalRows === 1);

    const second = await runDailyReport({ ...base, reportDate: '2026-08-09' }, quiet);
    record('a second date appends', second.ok && second.write.mode === 'appended' && second.write.totalRows === 2);

    const rollover = await runDailyReport({ ...base, reportDate: '2026-09-01' }, quiet);
    record('a new month starts a fresh master at row 3',
      rollover.ok && rollover.write.created === true && rollover.write.row === 3);
    record('new month gets its own file',
      rollover.ok && path.basename(rollover.layout.masterFile) === 'Master_Report_September_2026.xlsx');

    const badFolder = await runDailyReport({ ...base, inputFolder: path.join(root, 'nope'), reportDate: '2026-08-08' }, quiet);
    record('a missing inputs folder is reported, not crashed', badFolder.ok === false && /does not exist/i.test(badFolder.error));

    // A folder whose name carries no date, so nothing can supply one.
    const undated = path.join(root, 'loose-files');
    fs.mkdirSync(undated, { recursive: true });
    for (const f of fs.readdirSync(opts.inputFolder)) {
      fs.copyFileSync(path.join(opts.inputFolder, f), path.join(undated, f));
    }
    const noDate = await runDailyReport({ archiveRoot: root, inputFolder: undated }, quiet);
    record('a run with no resolvable date is refused clearly', noDate.ok === false && /report date/i.test(noDate.error));

    const emptyDir = path.join(root, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const noFiles = await runDailyReport({ archiveRoot: root, inputFolder: emptyDir, reportDate: '2026-08-08' }, quiet);
    record('an empty inputs folder is reported clearly', noFiles.ok === false && /no \.csv or \.xlsx/i.test(noFiles.error));

    fs.rmSync(root, { recursive: true, force: true });
  } else {
    say('');
    say('(no --inputs given: the mapping pipeline checks were skipped)');
  }

  const failed = checks.filter((c) => !c.ok);
  say('');
  say('='.repeat(58));
  say((checks.length - failed.length) + ' passed, ' + failed.length + ' failed');
  say('='.repeat(58));

  writeOut(opts.outFile, { ok: failed.length === 0, checks, exe: process.execPath });
  log.info('self-test: ' + (checks.length - failed.length) + ' passed, ' + failed.length + ' failed');
  return failed.length ? 1 : 0;
}

/** Start the real server on a free port, hand its URL to fn, then close it. */
async function withServer(fn, record) {
  let server = null;
  try {
    const { createServer, TOKEN } = require('../ui/server');
    const created = createServer();
    server = created.server;
    const url = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port + '/'));
    });
    record('local server starts on a free loopback port', true, url);
    await fn(url, TOKEN);
  } catch (err) {
    record('local server starts on a free loopback port', false, err.message);
  } finally {
    if (server) try { server.close(); } catch { /* already closed */ }
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    require('http').get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

async function run(argv, app) {
  const exit = (code) => (app ? app.exit(code) : process.exit(code));

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    say(err.message);
    say(USAGE);
    return exit(2);
  }

  if (opts.help) { say(USAGE); return exit(0); }

  try {
    if (opts.selfTest) return exit(await runSelfTest(opts));

    if (!opts.archiveRoot) {
      say('--root is required.');
      say(USAGE);
      return exit(2);
    }
    return exit(await runCli(opts));
  } catch (err) {
    const detail = err && err.stack ? err.stack : String(err);
    say(detail);
    log.error(
      'Pharmacy MIS stopped unexpectedly during a command-line run.\n\n'
      + (err && err.message ? err.message : String(err)),
      detail,
    );
    writeOut(opts.outFile, { ok: false, error: String(err && err.message ? err.message : err) });
    return exit(1);
  }
}

module.exports = { run, parseArgs, USAGE };
