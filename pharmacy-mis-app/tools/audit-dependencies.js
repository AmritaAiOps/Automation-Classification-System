'use strict';

/**
 * Lists every DLL the released exe — and the Electron application inside it —
 * asks Windows for, straight out of their PE import tables.
 *
 *   node tools/audit-dependencies.js
 *
 * This is how the "no runtime to install" claim is checked rather than
 * asserted: anything here that is not an in-box Windows DLL is a thing the
 * customer would have to have, and would have to be documented.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Read a PE file's imported DLL names. */
function imports(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 2) !== 'MZ') throw new Error(file + ' is not a PE file');
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error(file + ' has no PE signature');

  const numberOfSections = buf.readUInt16LE(pe + 6);
  const optStart = pe + 24;
  const plus = buf.readUInt16LE(optStart) === 0x20b;
  const dirStart = optStart + (plus ? 112 : 96);
  const importRva = buf.readUInt32LE(dirStart + 1 * 8);
  if (!importRva) return [];

  // Section headers follow the optional header; each is 40 bytes.
  const sectionsStart = optStart + buf.readUInt16LE(pe + 20);
  const sections = [];
  for (let i = 0; i < numberOfSections; i += 1) {
    const s = sectionsStart + i * 40;
    sections.push({
      virtualAddress: buf.readUInt32LE(s + 12),
      virtualSize: buf.readUInt32LE(s + 8),
      rawSize: buf.readUInt32LE(s + 16),
      rawPointer: buf.readUInt32LE(s + 20),
    });
  }

  const toOffset = (rva) => {
    for (const s of sections) {
      if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize)) {
        return s.rawPointer + (rva - s.virtualAddress);
      }
    }
    return null;
  };

  const names = [];
  let entry = toOffset(importRva);
  if (entry == null) return [];
  // The import directory is a run of 20-byte descriptors ending in an all-zero one.
  for (; entry + 20 <= buf.length; entry += 20) {
    const nameRva = buf.readUInt32LE(entry + 12);
    if (nameRva === 0 && buf.readUInt32LE(entry) === 0) break;
    const at = toOffset(nameRva);
    if (at == null) continue;
    let end = at;
    while (end < buf.length && buf[end] !== 0) end += 1;
    names.push(buf.toString('ascii', at, end));
  }
  return [...new Set(names)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/**
 * DLLs that ship with every supported Windows install. Anything imported that
 * is not on this list is called out, because it would be a real dependency the
 * customer has to satisfy — a Visual C++ redistributable, most typically.
 */
const IN_BOX = new Set([
  'advapi32.dll', 'bcrypt.dll', 'comctl32.dll', 'comdlg32.dll', 'crypt32.dll', 'd3d11.dll',
  'dbghelp.dll', 'dhcpcsvc.dll', 'dwmapi.dll', 'dxgi.dll', 'gdi32.dll', 'gdiplus.dll',
  'imm32.dll', 'iphlpapi.dll', 'kernel32.dll', 'ktmw32.dll', 'mpr.dll', 'msimg32.dll',
  'ntdll.dll', 'ole32.dll', 'oleaut32.dll', 'oleacc.dll', 'pdh.dll', 'powrprof.dll',
  'propsys.dll', 'psapi.dll', 'rpcrt4.dll', 'secur32.dll', 'setupapi.dll', 'shcore.dll',
  'shell32.dll', 'shlwapi.dll', 'user32.dll', 'userenv.dll', 'usp10.dll', 'uxtheme.dll',
  'version.dll', 'wininet.dll', 'winmm.dll', 'winspool.drv', 'ws2_32.dll', 'wtsapi32.dll',
  'api-ms-win-core-winrt-l1-1-0.dll', 'api-ms-win-core-winrt-string-l1-1-0.dll',
  'api-ms-win-shcore-scaling-l1-1-1.dll', 'dcomp.dll', 'wldp.dll', 'cfgmgr32.dll',
  'winhttp.dll', 'urlmon.dll', 'msvcrt.dll', 'ncrypt.dll', 'authz.dll', 'esent.dll',
  'dwrite.dll', 'wintrust.dll', 'dhcpcsvc.dll', 'd3d9.dll', 'winspool.drv',
]);

/**
 * A DLL is fine if Windows ships it, or if the application ships it itself —
 * Electron brings its own ffmpeg.dll, for example, and that travels inside the
 * exe like everything else. Only a DLL that is neither is a real dependency
 * the customer would have to satisfy.
 */
function report(label, file, shippedBeside) {
  console.log('\n' + label);
  console.log('  ' + file);
  if (!fs.existsSync(file)) { console.log('  (not present — run npm run build first)'); return []; }

  const bundled = new Set(shippedBeside.map((n) => n.toLowerCase()));
  const dlls = imports(file);
  const outside = [];

  console.log('  imports ' + dlls.length + ' DLL(s):');
  for (const d of dlls) {
    const key = d.toLowerCase();
    if (IN_BOX.has(key)) console.log('    ' + d);
    else if (bundled.has(key)) console.log('    ' + d + '   (shipped inside the exe)');
    else { console.log('    ' + d + '   <-- NOT in-box and NOT bundled'); outside.push(d); }
  }
  return outside;
}

/** The DLLs the packaged application carries with it. */
function bundledDlls(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.dll'));
}

function main() {
  console.log('Pharmacy MIS — runtime dependency audit (PE import tables)');

  const unpacked = path.join(ROOT, 'build', 'win-unpacked');
  const bundled = bundledDlls(unpacked);

  let outside = [];
  // The launcher is a bare Node executable: it carries no DLLs of its own.
  outside = outside.concat(report('The released exe (the launcher):', path.join(ROOT, 'dist', 'Pharmacy-MIS.exe'), []));
  outside = outside.concat(report('The application inside it:', path.join(unpacked, 'Pharmacy MIS.exe'), bundled));
  console.log('\n  DLLs shipped inside the exe: ' + (bundled.join(', ') || '(none)'));

  console.log('\n' + '='.repeat(62));
  if (outside.length) {
    console.log('EXTERNAL DEPENDENCIES FOUND: ' + [...new Set(outside)].join(', '));
    console.log('These must be installed on the customer machine, or removed.');
    process.exit(1);
  }
  console.log('No dependency outside the DLLs that ship with Windows 10/11.');
  console.log('='.repeat(62));
}

main();
