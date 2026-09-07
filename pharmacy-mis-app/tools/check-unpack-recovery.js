'use strict';

/**
 * Proves the launcher still starts when Windows will not let it put the
 * unpacked application into the folder it normally uses.
 *
 *   node tools/check-unpack-recovery.js
 *
 * This is the failure a pharmacy actually hit:
 *
 *   Stage that failed:  unpacking the application
 *   Error:  Access to the path '...\runtime\1.0.0-<hash>.unpacking-31816' is denied.
 *      at System.IO.Directory.InternalMove
 *      at Launcher.EnsureUnpacked
 *
 * The unpack itself had worked. What failed was the last step — renaming the
 * finished tree into place — because the folder it had to replace could not be
 * removed. Nothing about that clears itself, so every later launch failed the
 * same way and the application never started again on that machine.
 *
 * The real exe is 90 MB and takes minutes to build, which is no way to test a
 * path that has to keep working. So this check compiles the same
 * tools/launcher/Launcher.cs against a payload of a few hundred kilobytes,
 * with a test entry point that calls EnsureUnpacked and prints where it landed,
 * and drives it through the situations that broke it:
 *
 *   1  nothing unpacked yet
 *   2  already unpacked — no second unpack
 *   3  an interrupted unpack left behind, nothing holding it
 *   4  a folder that cannot be removed, because a file inside it is held open
 *      (which is what antivirus and a still-running copy both look like)
 *
 * A locked folder must cost a fallback folder, never the launch.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn, spawnSync } = require('child_process');

const { findCsc, packFolder, TRAILER_MAGIC } = require('./build.js');

const LAUNCHER = path.join(__dirname, 'launcher');
const INNER_EXE = 'Pharmacy MIS.exe';
const RUNTIME_NAME_LENGTH = 12; // Launcher.RuntimeName(): version + 12 hash chars

let pass = 0;
let fail = 0;

function check(name, ok, note) {
  if (ok) { pass += 1; console.log('  PASS  ' + name + (note ? '  — ' + note : '')); }
  else { fail += 1; console.log('  FAIL  ' + name + (note ? '\n          ' + note : '')); }
  return !!ok;
}

/* ------------------------------------------------------------------ *
 * A stand-in launcher: the real Launcher.cs, a tiny payload
 * ------------------------------------------------------------------ */

/** The test entry point. EnsureUnpacked is private, so it is reached by reflection. */
const HARNESS_CS = `// Written by tools/check-unpack-recovery.js — not part of the release.
using System;
using System.IO;
using System.Reflection;

internal static class UnpackCheck
{
    private static int Main(string[] args)
    {
        // "hold" keeps one file open with no sharing at all, which is what
        // stops Windows renaming the folder around it.
        if (args.Length == 2 && args[0] == "hold")
        {
            using (new FileStream(args[1], FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
            {
                Console.Out.WriteLine("holding");
                Console.Out.Flush();
                Console.In.ReadLine();
            }
            return 0;
        }

        var method = typeof(Launcher).GetMethod("EnsureUnpacked", BindingFlags.NonPublic | BindingFlags.Static);
        try
        {
            Console.Out.WriteLine("OK " + (string)method.Invoke(null, null));
            return 0;
        }
        catch (TargetInvocationException err)
        {
            var inner = err.InnerException;
            Console.Out.WriteLine("ERR " + inner.GetType().Name + ": " + inner.Message);
            return 1;
        }
    }
}
`;

/**
 * A stand-in for the application: an inner exe and one bulk file.
 *
 * The bulk file is padded to a few hundred kilobytes because LZMS is asked to
 * compress into a buffer the size of its input, and a handful of bytes
 * compresses to more than it started as.
 */
function buildPayloadFolder(dir) {
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, INNER_EXE), 'stand-in for the application\n');
  fs.writeFileSync(path.join(dir, 'resources', 'app.asar'), PAYLOAD_BODY);
}

const PAYLOAD_BODY = 'stand-in payload\n'.repeat(16384);

/**
 * Compile Launcher.cs with the test entry point and append a payload, the same
 * way tools/build.js makes the release: payload first, its hash baked into
 * BuildInfo, then the trailer at the very end.
 */
function buildCheckExe(work, csc) {
  const payloadSource = path.join(work, 'payload');
  buildPayloadFolder(payloadSource);
  const { raw } = packFolder(payloadSource);

  const rawFile = path.join(work, 'app.raw');
  const payloadFile = path.join(work, 'app.lzms');
  fs.writeFileSync(rawFile, raw);

  const packExe = path.join(work, 'Pack.exe');
  execFileSync(csc, ['-nologo', '-optimize+', '-platform:x64', '-out:' + packExe, path.join(LAUNCHER, 'Pack.cs')],
    { stdio: 'pipe' });
  execFileSync(packExe, [rawFile, payloadFile], { stdio: 'pipe' });

  const payload = fs.readFileSync(payloadFile);
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');

  const buildInfo = path.join(work, 'BuildInfo.cs');
  fs.writeFileSync(buildInfo, [
    '// Written by tools/check-unpack-recovery.js — not part of the release.',
    'internal static class BuildInfo',
    '{',
    '    public const string Version = "0.0.0-check";',
    '    public const string PayloadHash = ' + JSON.stringify(payloadHash) + ';',
    '}',
    '',
  ].join('\n'), 'utf8');

  const harness = path.join(work, 'UnpackCheck.cs');
  fs.writeFileSync(harness, HARNESS_CS, 'utf8');

  // A console binary here, unlike the release: this one is read by a script.
  const exe = path.join(work, 'UnpackCheck.exe');
  execFileSync(csc, [
    '-nologo', '-platform:x64', '-target:exe', '-main:UnpackCheck', '-out:' + exe,
    path.join(LAUNCHER, 'Launcher.cs'), buildInfo, harness,
  ], { stdio: 'pipe' });

  const trailer = Buffer.alloc(24);
  trailer.writeBigUInt64LE(BigInt(payload.length), 0);
  trailer.writeBigUInt64LE(BigInt(raw.length), 8);
  trailer.write(TRAILER_MAGIC, 16, 'ascii');
  fs.appendFileSync(exe, payload);
  fs.appendFileSync(exe, trailer);

  return { exe, runtimeName: '0.0.0-check-' + payloadHash.slice(0, RUNTIME_NAME_LENGTH) };
}

/* ------------------------------------------------------------------ *
 * Driving it
 * ------------------------------------------------------------------ */

/**
 * One launch. A refusal is a result to be reported, not a reason to stop: the
 * whole point is to say which situation the launcher no longer survives.
 */
function runCheckExe(exe, local) {
  const env = { ...process.env, LOCALAPPDATA: local };
  const res = spawnSync(exe, [], { encoding: 'utf8', env, cwd: os.tmpdir(), timeout: 120000 });
  const out = ((res.stdout || '') + (res.stderr || '')).trim();
  const line = out ? out.split('\n').pop().trim() : 'the launcher printed nothing (' + res.status + ')';
  return { ok: res.status === 0 && line.startsWith('OK '), text: line, exe: line.slice(3) };
}

/**
 * Hold one file open with no sharing at all, and hand back a way to let go of
 * it. Letting go is waited for: until the holding process has actually exited,
 * the handle is still there and the folder is still locked.
 */
function holdOpen(exe, file) {
  const child = spawn(exe, ['hold', file], { stdio: ['pipe', 'pipe', 'ignore'] });
  const release = () => new Promise((done) => {
    if (child.exitCode !== null) { done(); return; }
    child.once('exit', () => done());
    try { child.stdin.end(); } catch { /* already gone */ }
  });

  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve(release));
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error('the holder exited early (' + code + ')')));
  });
}

const runtimeDirs = (runtimeRoot) => (fs.existsSync(runtimeRoot) ? fs.readdirSync(runtimeRoot).sort() : []);

async function main() {
  const csc = findCsc();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmis-unpack-check-'));
  const local = path.join(work, 'local');
  const runtimeRoot = path.join(local, 'PharmacyMIS', 'runtime');
  let release = null;

  try {
    console.log('Building a stand-in launcher from tools/launcher/Launcher.cs…');
    const { exe, runtimeName } = buildCheckExe(work, csc);
    const home = path.join(runtimeRoot, runtimeName);

    console.log('\n1 · Nothing unpacked yet');
    let run = runCheckExe(exe, local);
    check('the application unpacks and reports its exe', run.ok, run.text);
    check('it unpacks into the folder named for the build',
      run.exe === path.join(home, INNER_EXE), run.exe);
    check('the payload is really there', fs.existsSync(path.join(home, 'resources', 'app.asar')));

    console.log('\n2 · Already unpacked');
    const marker = path.join(home, 'resources', 'app.asar');
    const before = fs.statSync(marker).mtimeMs;
    run = runCheckExe(exe, local);
    check('the second run uses the copy that is already there', run.ok && run.exe === path.join(home, INNER_EXE),
      run.text);
    check('nothing was unpacked a second time', fs.statSync(marker).mtimeMs === before);
    check('no extra folders were left behind', runtimeDirs(runtimeRoot).join(', ') === runtimeName,
      runtimeDirs(runtimeRoot).join(', '));

    console.log('\n3 · An unpack that was interrupted last time');
    // No .ready marker: exactly what a crash, a full disk or an antivirus
    // scan leaves behind, and what the launcher must not use or trust.
    fs.rmSync(path.join(home, '.ready'));
    fs.writeFileSync(path.join(home, 'resources', 'app.asar'), 'half-written rubbish\n');
    run = runCheckExe(exe, local);
    check('the half-finished copy is replaced, not used', run.ok && run.exe === path.join(home, INNER_EXE), run.text);
    check('the good payload is back',
      fs.readFileSync(path.join(home, 'resources', 'app.asar'), 'utf8') === PAYLOAD_BODY);

    console.log('\n4 · A folder Windows will not let go of');
    // The reported failure: the unpack succeeds, and the rename into place is
    // refused because something still holds a file in the target folder.
    fs.rmSync(path.join(home, '.ready'));
    release = await holdOpen(exe, path.join(home, 'resources', 'app.asar'));
    run = runCheckExe(exe, local);
    check('the application still starts, rather than failing the way the pharmacy saw',
      run.ok, run.text);
    const fallback = run.ok ? run.exe : '';
    check('it used a different folder instead of the locked one',
      run.ok && fallback !== path.join(home, INNER_EXE) && fallback.startsWith(runtimeRoot), fallback);

    await release();
    release = null;

    // Readable only now the holder has let go — which is the point of it.
    check('the locked folder was left alone, not half-deleted',
      fs.readFileSync(path.join(home, 'resources', 'app.asar'), 'utf8') === PAYLOAD_BODY);

    console.log('\n5 · And again once the lock is gone');
    if (!fallback) {
      check('the fallback copy is reused rather than unpacked again', false,
        'there is no fallback copy — the launch failed at step 4');
    } else {
      const fallbackMarker = path.join(path.dirname(fallback), 'resources', 'app.asar');
      const fallbackWritten = fs.statSync(fallbackMarker).mtimeMs;
      run = runCheckExe(exe, local);
      check('the fallback copy is reused rather than unpacked again',
        run.ok && run.exe === fallback, run.text);
      check('and it really was reused', fs.statSync(fallbackMarker).mtimeMs === fallbackWritten);
    }
  } finally {
    if (release) await release();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Windows may still hold it */ }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nThe check could not run: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
