'use strict';

/**
 * Builds the single-file Windows exe.
 *
 *   1  esbuild bundles src/main.js and everything it requires into one CommonJS
 *      file — the app plus exceljs, with the embedded report template inlined.
 *   2  node --experimental-sea-config turns that bundle into a SEA blob.
 *   3  the blob is injected into a copy of node.exe with postject.
 *
 * The result is one file with no installer, no unpack step and no runtime to
 * install. Nothing about a browser engine is bundled — the window is the
 * machine's own Edge/WebView2 in app mode — so this stays around 90 MB and
 * starts in roughly 0.2 s.
 *
 * Run with:  npm run build
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, 'build');
const pkg = require(path.join(ROOT, 'package.json'));

const EXE_NAME = 'Pharmacy-MIS.exe';
const BUNDLE = path.join(BUILD, 'bundle.js');
const BLOB = path.join(BUILD, 'sea.blob');
const SEA_CONFIG = path.join(BUILD, 'sea-config.json');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function step(n, total, text) {
  console.log(`\n[${n}/${total}] ${text}`);
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

async function main() {
  const started = Date.now();
  const TOTAL = 5;

  fs.mkdirSync(DIST, { recursive: true });
  fs.mkdirSync(BUILD, { recursive: true });

  // ---- 1. regenerate the embedded template if the reference is present -----
  step(1, TOTAL, 'Refresh the embedded report template');
  const reference = path.join(ROOT, '..', 'reference', 'Daily Report for coding.xlsx');
  if (fs.existsSync(reference)) {
    run(process.execPath, [path.join(__dirname, 'gen-template.js'), reference]);
  } else {
    console.log(`  reference workbook not found at ${reference}`);
    console.log('  keeping the template already baked into src/excel/template.js');
  }

  // ---- 2. bundle ----------------------------------------------------------
  step(2, TOTAL, 'Bundle the app with esbuild');
  const esbuild = require('esbuild');
  const result = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main.js')],
    bundle: true,
    platform: 'node',
    target: `node${process.versions.node.split('.')[0]}`,
    format: 'cjs',
    outfile: BUNDLE,
    minify: true,
    // The scraper is required lazily and is absent on non-admin machines;
    // leaving it external keeps the bundle from failing on a missing puppeteer.
    external: ['puppeteer', 'puppeteer-core'],
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const bundleSize = fs.statSync(BUNDLE).size;
  console.log(`  bundle: ${human(bundleSize)}`);
  fs.writeFileSync(path.join(BUILD, 'meta.json'), JSON.stringify(result.metafile), 'utf8');

  // ---- 3. SEA blob --------------------------------------------------------
  step(3, TOTAL, 'Build the single-executable blob');
  fs.writeFileSync(
    SEA_CONFIG,
    JSON.stringify(
      {
        main: BUNDLE,
        output: BLOB,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: true,
      },
      null,
      2,
    ),
    'utf8',
  );
  run(process.execPath, ['--experimental-sea-config', SEA_CONFIG]);
  console.log(`  blob: ${human(fs.statSync(BLOB).size)}`);

  // ---- 4. rebrand a fresh copy of node.exe, then inject ---------------------
  // Without this the shipped exe is, as far as Windows is concerned, just
  // node.exe: Explorer, Task Manager and the SmartScreen prompt all show
  // "Node.js JavaScript Runtime" / publisher "Node.js" — confusing to hand to
  // someone else. rcedit rewrites that version resource.
  //
  // Order matters: rcedit must run BEFORE postject injects the SEA blob.
  // Doing it after leaves the two tools fighting over the same PE section and
  // the injection call hangs. Rebranding a plain node.exe copy first, then
  // injecting into *that*, avoids it entirely.
  step(4, TOTAL, 'Brand the runtime and inject the blob');
  const exe = path.join(DIST, EXE_NAME);
  if (fs.existsSync(exe)) fs.rmSync(exe);
  fs.copyFileSync(process.execPath, exe);

  const rcedit = require('rcedit');
  const versionQuad = `${pkg.version}.0`.split('.').slice(0, 4).join('.').padEnd(7, '.0');
  await rcedit(exe, {
    'file-version': versionQuad,
    'product-version': versionQuad,
    'version-string': {
      ProductName: pkg.productName || pkg.name,
      FileDescription: pkg.description || pkg.productName,
      CompanyName: pkg.author || '',
      LegalCopyright: pkg.author || '',
      OriginalFilename: EXE_NAME,
      InternalName: path.basename(EXE_NAME, '.exe'),
    },
  });
  console.log(`  branded as "${pkg.productName || pkg.name}" ${pkg.version}`);

  const postject = require.resolve('postject/dist/cli.js');
  run(process.execPath, [postject, exe, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', FUSE]);

  // ---- 5. verify ----------------------------------------------------------
  step(5, TOTAL, 'Verify the exe');
  const out = execFileSync(exe, ['--cli', '--help'], { encoding: 'utf8', cwd: os.tmpdir() });
  if (!/Pharmacy MIS/.test(out)) throw new Error('The built exe did not respond to --cli --help as expected');
  console.log('  exe responds to --cli --help');

  const versionInfoOk = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item '${exe}').VersionInfo.ProductName`],
    { encoding: 'utf8' },
  ).trim();
  if (versionInfoOk !== (pkg.productName || pkg.name)) {
    throw new Error(`Version resource did not stick — Windows reports ProductName "${versionInfoOk}"`);
  }
  console.log(`  Windows reports it as "${versionInfoOk}"`);

  // A SHA256 alongside the exe lets the recipient (or you, after the copy)
  // confirm the file that arrived is byte-for-byte what was built — an 88 MB
  // exe silently truncated by email/USB/cloud-drive transfer is a real and
  // common cause of "it doesn't open on the other machine".
  const hash = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  const hashFile = `${exe}.sha256`;
  fs.writeFileSync(hashFile, `${hash} *${EXE_NAME}\n`, 'utf8');

  const size = fs.statSync(exe).size;
  console.log(`\n${'='.repeat(58)}`);
  console.log(`  ${EXE_NAME}  ${human(size)}`);
  console.log(`  ${exe}`);
  console.log(`  version ${pkg.version}, built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  sha256   ${hash}`);
  console.log('='.repeat(58));
  console.log('\nDouble-click the exe to open the app window.');
  console.log(`Or run headless:  ${EXE_NAME} --cli --root <archive> --inputs <folder>\n`);
  console.log('Sharing this exe with someone else:');
  console.log('  - it is unsigned, so Windows SmartScreen will warn on first run —');
  console.log('    they click "More info" then "Run anyway" once.');
  console.log('  - after they copy it (email/USB/cloud drive), have them run this in');
  console.log('    PowerShell before double-clicking, to lift that warning and confirm');
  console.log('    the copy is not corrupted:');
  console.log(`      Unblock-File .\\${EXE_NAME}`);
  console.log(`      Get-FileHash .\\${EXE_NAME}  # should read ${hash.slice(0, 16)}…\n`);
}

main().catch((err) => {
  console.error(`\nBuild failed: ${err.message}`);
  process.exit(1);
});
