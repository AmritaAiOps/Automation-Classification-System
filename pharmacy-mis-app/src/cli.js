'use strict';

const path = require('path');
const { runDailyReport } = require('./pipeline');

/**
 * Headless entry point, for running the same pipeline from Task Scheduler once
 * the Puppeteer half is in place on the admin machine. Prints the identical log
 * the window shows, and exits non-zero on failure so a scheduled task reports
 * the error rather than silently succeeding.
 *
 *   Pharmacy-MIS.exe --cli --root <archive> [--date YYYY-MM-DD]
 *                    [--inputs <folder>] [--prq f] [--po f] [--grn f]
 *                    [--dry-run] [--quiet] [--json]
 */

const USAGE = `
Pharmacy MIS — daily report mapping (command line)

  --root <folder>     archive root, the folder holding Pharmacy-MIS/   (required)
  --date <date>       report date, YYYY-MM-DD or DD-MM-YYYY
                      (defaults to the date in the inputs folder name)
  --inputs <folder>   dated inputs folder to scan
  --prq <file>        PRQ Details file      -> columns C, D
  --po <file>         PO Detail Report file -> columns E, F, G
  --grn <file>        Purchase/GRN file     -> columns H, I, J
  --dry-run           compute everything, write nothing
  --quiet             only print warnings and errors
  --json              print the full result as JSON instead of a log
  -h, --help          this text

Files are identified by their column layout, so --prq/--po/--grn are a
convenience: a file passed in the wrong slot is still placed correctly.
`;

const FLAGS = new Set(['--dry-run', '--quiet', '--json', '-h', '--help']);

function parseArgs(argv) {
  const out = { files: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cli') continue;

    if (FLAGS.has(arg)) {
      if (arg === '--dry-run') out.dryRun = true;
      else if (arg === '--quiet') out.quiet = true;
      else if (arg === '--json') out.json = true;
      else out.help = true;
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} needs a value`);
    }
    i += 1;

    switch (arg) {
      case '--root': out.archiveRoot = path.resolve(value); break;
      case '--date': out.reportDate = value; break;
      case '--inputs': out.inputFolder = path.resolve(value); break;
      case '--prq': out.files.PRQ = path.resolve(value); break;
      case '--po': out.files.PO = path.resolve(value); break;
      case '--grn': out.files.GRN = path.resolve(value); break;
      default: throw new Error(`Unknown option ${arg}`);
    }
  }
  return out;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }

  if (opts.help) { console.log(USAGE); process.exit(0); }

  if (!opts.archiveRoot) {
    console.error(`--root is required.\n${USAGE}`);
    process.exit(2);
  }

  const sink = opts.json
    ? null
    : (entry) => {
      if (opts.quiet && !['warn', 'error', 'ok'].includes(entry.level)) return;
      if (entry.level === 'debug') return;
      const pad = '  '.repeat(entry.indent || 0);
      const line = `${entry.level.toUpperCase().padEnd(5)} ${pad}${entry.message}`;
      if (entry.level === 'error' || entry.level === 'warn') console.error(line);
      else console.log(line);
    };

  const result = await runDailyReport(opts, sink);

  if (opts.json) {
    console.log(JSON.stringify({ ...result, log: undefined }, null, 2));
  } else if (result.ok) {
    const cols = Object.entries(result.fields)
      .map(([k, v]) => `${k}=${v == null ? '-' : v}`)
      .join('  ');
    console.log(`\n${cols}`);
    console.log(`${result.write.written ? 'saved' : 'preview'}: ${result.layout.masterFile}`);
    console.log(`row ${result.write.row} ${result.write.mode}, ${result.write.totalRows} date row(s)`);
  }

  process.exit(result.ok ? 0 : 1);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
