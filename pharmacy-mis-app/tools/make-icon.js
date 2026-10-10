'use strict';

/**
 * Generates assets/icon.ico — the application icon Windows shows in Explorer,
 * the taskbar, the title bar and Alt-Tab.
 *
 * It is generated rather than committed as a binary so the mark is reproducible
 * and reviewable: the whole thing is the drawing code below. Rendering is done
 * by hand into an RGBA buffer (supersampled 4x for clean edges), encoded as PNG
 * with the built-in zlib, and packed into a multi-resolution .ico. No image
 * library, no external tool.
 *
 *   node tools/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // supersampling factor

/* ---------------- the mark ----------------
 * A dark rounded tile carrying a pharmacy cross built out of three ascending
 * report bars — the two halves of the app in one shape: the pharmacy, and the
 * daily figures it reports.
 */

const INK = { bg1: [0x16, 0x1f, 0x2b], bg2: [0x0d, 0x13, 0x1a] };
const BAR = [0x4c, 0x9b, 0xe8];
const BAR_HI = [0x7d, 0xbb, 0xf5];
const CROSS = [0x4e, 0xc9, 0x8a];

/** Draw the icon at `n` x `n` into a flat RGBA byte array. */
function render(n) {
  const px = new Uint8ClampedArray(n * n * 4);
  const put = (x, y, rgb, a) => {
    if (x < 0 || y < 0 || x >= n || y >= n || a <= 0) return;
    const i = (y * n + x) * 4;
    const src = a >= 1 ? 1 : a;
    px[i] = px[i] * (1 - src) + rgb[0] * src;
    px[i + 1] = px[i + 1] * (1 - src) + rgb[1] * src;
    px[i + 2] = px[i + 2] * (1 - src) + rgb[2] * src;
    px[i + 3] = Math.max(px[i + 3], a * 255);
  };

  const r = n * 0.20; // corner radius
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, r), n - r);
    const cy = Math.min(Math.max(y, r), n - r);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };

  // background tile, with a soft top-to-bottom gradient
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (!inRounded(x + 0.5, y + 0.5)) continue;
      const t = y / n;
      put(x, y, [
        INK.bg1[0] * (1 - t) + INK.bg2[0] * t,
        INK.bg1[1] * (1 - t) + INK.bg2[1] * t,
        INK.bg1[2] * (1 - t) + INK.bg2[2] * t,
      ], 1);
    }
  }

  // three ascending bars along the bottom
  const rect = (x0, y0, w, h, rgb) => {
    for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y += 1) {
      for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x += 1) {
        if (!inRounded(x + 0.5, y + 0.5)) continue;
        put(x, y, rgb, 1);
      }
    }
  };

  const barW = n * 0.13;
  const gap = n * 0.075;
  const baseY = n * 0.76;
  const left = n * 0.20;
  const heights = [n * 0.20, n * 0.31, n * 0.42];
  for (let i = 0; i < 3; i += 1) {
    rect(left + i * (barW + gap), baseY - heights[i], barW, heights[i], i === 2 ? BAR_HI : BAR);
  }

  // the pharmacy cross, sitting over the tallest bar
  const armT = n * 0.085;
  const armL = n * 0.26;
  const ccx = n * 0.665;
  const ccy = n * 0.335;
  rect(ccx - armL / 2, ccy - armT / 2, armL, armT, CROSS);
  rect(ccx - armT / 2, ccy - armL / 2, armT, armL, CROSS);

  return px;
}

/** Render supersampled, then box-filter down — cheap, effective antialiasing. */
function renderAA(n) {
  const big = render(n * SS);
  const out = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * n * SS + (x * SS + sx)) * 4;
          const al = big[i + 3] / 255;
          r += big[i] * al; g += big[i + 1] * al; b += big[i + 2] * al; a += al;
        }
      }
      const i = (y * n + x) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return out;
}

/* ---------------- PNG encoding ---------------- */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, n) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  // 10..12 stay 0: deflate, adaptive filtering, no interlace

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(n * (n * 4 + 1));
  for (let y = 0; y < n; y += 1) {
    raw[y * (n * 4 + 1)] = 0;
    rgba.copy(raw, y * (n * 4 + 1) + 1, y * n * 4, (y + 1) * n * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- ICO container ---------------- */

/**
 * Windows Vista and later read PNG-compressed icon entries at every size, and
 * electron-builder requires a 256 px entry, so every entry is stored as PNG.
 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach((e, i) => {
    const at = i * 16;
    dir[at] = e.size >= 256 ? 0 : e.size;
    dir[at + 1] = e.size >= 256 ? 0 : e.size;
    dir[at + 2] = 0;   // palette
    dir[at + 3] = 0;   // reserved
    dir.writeUInt16LE(1, at + 4);   // colour planes
    dir.writeUInt16LE(32, at + 6);  // bits per pixel
    dir.writeUInt32BE(0, at + 8);
    dir.writeUInt32LE(e.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

function main() {
  const entries = SIZES.map((size) => ({ size, png: encodePng(renderAA(size), size) }));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const ico = buildIco(entries);
  fs.writeFileSync(OUT, ico);
  console.log(
    'Wrote ' + OUT + ' (' + (ico.length / 1024).toFixed(1) + ' KB, sizes '
    + SIZES.join('/') + ')',
  );
}

if (require.main === module) main();

module.exports = { main };
