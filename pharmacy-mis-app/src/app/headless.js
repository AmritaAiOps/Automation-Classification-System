'use strict';

/**
 * The command line: `node src/app/headless.js --root <folder> ...` (or `npm run cli -- ...`).
 *
 * Same pipeline as the web UI, no browser. This is what a scheduled task drives
 * for the daily portal pull; every run is also appended to the application log.
 */

const fs = require('fs');
const path = require('path');
const { runDailyReport } = require('../pipeline');
const { runWithPortalPullRange } = require('../portalRun');
const { log } = require('../core/appdata');
const { getPreviousCalendarDay } = require('../core/paths');

const USAGE = `
Pharmacy MIS — daily report mapping (command line)

  --root <folder>     archive root, the folder that holds Pharmacy-MIS/  (required)
  --date <date>       report date, YYYY-MM-DD or DD-MM-YYYY
  --from <date>       first date of a range (portal pull; same as --date)
  --to <date>         last date of a range (portal pull); every day in
                      --from..--to runs, signing in once
                      (defaults to yesterday — the previous calendar day)
  --inputs <folder>   dated inputs folder to scan
  --prq <file>        PRQ Details file      -> columns C, D
  --po <file>         PO Detail Report file -> columns E, F, G
  --grn <file>        Purchase/GRN file     -> columns H, I, J
  --username <name>   Amrita HIS username — pulls the day's reports from the
                      portal with Puppeteer instead of reading --inputs/--prq/
                      --po/--grn. The password is never a command-line
                      argument: set it in the PHARMACY_MIS_PASSWORD
                      environment variable before running (e.g. for a
                      scheduled task, store it with Task Scheduler's own
                      "run whether user is logged on or not" credential, or
                      an env var set on the task's Actions tab — never in the
                      task's Arguments field).
  --dry-run           compute everything, write nothing
  --quiet             only print warnings and errors
  --json              print the full result as JSON instead of a log
  --out <file>        also write the result as JSON to <file>
  -h, --help          this text

Files are identified by their column layout, so --prq/--po/--grn are a
convenience: a file passed in the wrong slot is still placed correctly.
`;

const FLAGS = new Set(['--dry-run', '--quiet', '--json', '-h', '--help']);

function parseArgs(argv) {
  const out = { files: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-')) continue;

    if (FLAGS.has(arg)) {
      if (arg === '--dry-run') out.dryRun = true;
      else if (arg === '--quiet') out.quiet = true;
      else if (arg === '--json') out.json = true;
      else out.help = true;
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(arg + ' needs a value');
    i += 1;

    switch (arg) {
      case '--root': out.archiveRoot = path.resolve(value); break;
      case '--date': out.reportDate = value; break;
      case '--from': out.fromDate = value; break;
      case '--to': out.toDate = value; break;
      case '--inputs': out.inputFolder = path.resolve(value); break;
      case '--prq': out.files.PRQ = path.resolve(value); break;
      case '--po': out.files.PO = path.resolve(value); break;
      case '--grn': out.files.GRN = path.resolve(value); break;
      case '--username': out.username = value; break;
      case '--out': out.outFile = path.resolve(value); break;
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

  // The portal pull always needs an explicit date (there is no inputs
  // folder/filename to infer one from), so it alone defaults to yesterday —
  // the previous calendar day. Manual/file-based mode keeps its existing
  // behaviour: --date if given, otherwise inferred from the inputs folder or
  // file names (see resolveDate() in src/pipeline.js), unchanged.
  let result;
  if (opts.username) {
    const password = process.env.PHARMACY_MIS_PASSWORD;
    if (!password) {
      throw new Error(
        '--username was given but the PHARMACY_MIS_PASSWORD environment variable is not set. '
        + 'The password is never accepted as a command-line argument.',
      );
    }
    const fromDate = opts.fromDate || opts.reportDate || getPreviousCalendarDay().iso;
    const range = await runWithPortalPullRange(
      { archiveRoot: opts.archiveRoot, fromDate, toDate: opts.toDate, credentials: { username: opts.username, password }, dryRun: !!opts.dryRun },
      sink,
    );
    if (range.results.length === 1 && !range.skipped.length) {
      [result] = range.results; // a single day reports exactly as it always did
    } else {
      const summary = range.results.map((r) => ({ date: r.date, ok: !!r.ok, error: r.ok ? undefined : r.error }));
      const failed = summary.filter((r) => !r.ok);
      result = {
        ok: range.ok,
        error: failed.map((r) => `${r.date}: ${r.error}`).join('\n') + (range.skipped.length ? `\nNot run: ${range.skipped.join(', ')}` : ''),
        dates: summary,
        skipped: range.skipped,
        log: range.results.flatMap((r) => r.log || []),
      };
      if (!opts.json) {
        say('');
        summary.forEach((r) => say((r.ok ? 'OK    ' : 'FAIL  ') + r.date + (r.ok ? '' : ' — ' + r.error)));
        range.skipped.forEach((d) => say('SKIP  ' + d));
      }
    }
  } else {
    result = await runDailyReport(opts, sink);
  }

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
        'Report date:      ' + (result.date || opts.reportDate || '(could not be resolved)'),
        'Inputs folder:    ' + (opts.username ? '(Amrita HIS portal pull)' : (opts.inputFolder || '(not set)')),
      ].join('\n'),
      (result.log || [])
        .map((e) => e.level.toUpperCase().padEnd(5) + ' ' + '  '.repeat(e.indent || 0) + e.message)
        .join('\n'),
    );
    say('details written to ' + log.file());
  }

  writeOut(opts.outFile, { ...result, log: undefined });

  if (opts.json) {
    say(JSON.stringify({ ...result, log: undefined }, null, 2));
  } else if (result.ok && result.fields) {
    say('');
    say(Object.entries(result.fields).map(([k, v]) => k + '=' + (v == null ? '-' : v)).join('  '));
    say((result.write.written ? 'saved: ' : 'preview: ') + result.layout.masterFile);
    say('row ' + result.write.row + ' ' + result.write.mode + ', ' + result.write.totalRows + ' date row(s)');
    if (result.portalFiles) say('Portal reports downloaded: ' + result.portalFiles.length);
  }

  return result.ok ? 0 : 1;
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

async function run(argv) {
  const exit = (code) => process.exit(code);

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

if (require.main === module) run(process.argv.slice(2));
