#!/usr/bin/env node
/**
 * Launcher icon generator — zero dependencies (pure zlib + CRC32).
 *
 * Design: a bold geometric "M" with a pen set diagonally beside it — the pen is
 * what the app is actually for (dictation). A sound wave was considered as a
 * third element but dropped: three marks turn to mush at 48dp, and the pen alone
 * says "write what you hear" more directly.
 *
 * Outputs an ADAPTIVE icon (separate background/foreground layers) rather than a
 * pre-rounded bitmap. Android applies the launcher's own mask, so baking corners
 * in produced a pale double-rounded ring on launchers using another shape.
 *
 * Every shape is sampled with 4x4 supersampling, which gives clean antialiasing
 * for arbitrary outlines and keeps every density crisp.
 */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RES = path.join(ROOT, 'app/src/main/res');

/** Legacy square icons (pre-API 26 launchers). */
const LEGACY = {
  'mipmap-mdpi': 48, 'mipmap-hdpi': 72, 'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144, 'mipmap-xxxhdpi': 192
};
/** Adaptive layers are 108dp; these are the pixel sizes per density. */
const ADAPTIVE = {
  'mipmap-mdpi': 108, 'mipmap-hdpi': 162, 'mipmap-xhdpi': 216,
  'mipmap-xxhdpi': 324, 'mipmap-xxxhdpi': 432
};

const BRAND = [47, 107, 255]; // #2F6BFF — same blue as the UI accent
const SS = 4;                 // supersamples per axis

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const o = rowStart + 1 + x * 4;
      raw[o] = pixels[i];
      raw[o + 1] = pixels[i + 1];
      raw[o + 2] = pixels[i + 2];
      raw[o + 3] = pixels[i + 3];
    }
  }
  return Buffer.concat([
    sig, chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------------------------------------------------------- geometry */

function distToSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy || 1;
  let t = (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Point in triangle (any winding). */
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Foreground artwork in pixel space.
 *
 * The three marks are described as predicates and sampled on a 4x4 grid, so
 * edges are antialiased without needing an analytic distance field for the pen.
 */
function glyphAt(x, y, size) {
  // --- M: two stems plus two diagonals
  const stroke = size * 0.074;
  const x0 = size * 0.150, x1 = size * 0.445;
  const yTop = size * 0.345, yBot = size * 0.655;
  const midY = size * 0.548;
  const cxM = (x0 + x1) / 2;
  const segs = [
    [x0, yBot, x0, yTop],
    [x0, yTop, cxM, midY],
    [cxM, midY, x1, yTop],
    [x1, yTop, x1, yBot]
  ];
  for (const [ax, ay, bx, by] of segs) {
    if (distToSeg(x, y, ax, ay, bx, by) <= stroke / 2) return true;
  }

  // --- Pen: diagonal body with a nib, tilted like it is writing.
  // Local +x points toward the nib (down-left on screen).
  const px0 = size * 0.700, py0 = size * 0.500;   // pen centre
  const ang = 112 * Math.PI / 180;                // nib points down, slightly left
  const L = size * 0.470, W = size * 0.086;
  const ca = Math.cos(-ang), sa = Math.sin(-ang);
  const dx = x - px0, dy = y - py0;
  const lx = dx * ca - dy * sa;
  const ly = dx * sa + dy * ca;

  const nibLen = L * 0.30;                        // nib is a third of the pen
  const bodyEnd = L * 0.5 - nibLen;               // where the nib starts
  const bodyStart = -L * 0.5;
  // barrel
  if (lx >= bodyStart && lx <= bodyEnd && Math.abs(ly) <= W / 2) return true;
  // rounded cap at the far end
  if (Math.hypot(lx - bodyStart, ly) <= W / 2) return true;
  // nib: slender triangle tapering to a sharp point
  if (lx > bodyEnd && lx <= L * 0.5) {
    const t = (lx - bodyEnd) / nibLen;            // 0 at base, 1 at tip
    const halfW = (W / 2) * (1 - t) * 1.05;
    if (Math.abs(ly) <= halfW) return true;
  }

  return false;
}

/** Foreground: white artwork on transparent, sized for the adaptive safe zone. */
function drawForeground(size) {
  const px = Buffer.alloc(size * size * 4);
  const step = 1 / SS;
  const total = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (glyphAt(x + (sx + 0.5) * step, y + (sy + 0.5) * step, size)) hits++;
        }
      }
      if (!hits) continue;
      const i = (y * size + x) * 4;
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
      px[i + 3] = Math.round(255 * hits / total);
    }
  }
  return px;
}

/** Solid brand fill for the adaptive background layer. */
function drawBackground(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = BRAND[0];
    px[i * 4 + 1] = BRAND[1];
    px[i * 4 + 2] = BRAND[2];
    px[i * 4 + 3] = 255;
  }
  return px;
}

/** Legacy icon: brand rounded square with the artwork composited on top. */
function drawLegacy(size) {
  const fg = drawForeground(size);
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = Math.max(Math.abs(x + 0.5 - size / 2) - (size / 2 - r), 0);
      const dy = Math.max(Math.abs(y + 0.5 - size / 2) - (size / 2 - r), 0);
      const bgA = Math.max(0, Math.min(1, r - Math.hypot(dx, dy) + 0.5));
      const a = fg[i + 3] / 255;
      px[i] = Math.round(BRAND[0] * (1 - a) + 255 * a);
      px[i + 1] = Math.round(BRAND[1] * (1 - a) + 255 * a);
      px[i + 2] = Math.round(BRAND[2] * (1 - a) + 255 * a);
      px[i + 3] = Math.round(255 * bgA);
    }
  }
  return px;
}

function writeAll() {
  for (const [dir, size] of Object.entries(LEGACY)) {
    const out = path.join(RES, dir);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'ic_launcher.png'), encodePng(size, drawLegacy(size)));
    console.log('legacy  ', dir, size);
  }
  for (const [dir, size] of Object.entries(ADAPTIVE)) {
    const out = path.join(RES, dir);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'ic_launcher_foreground.png'), encodePng(size, drawForeground(size)));
    fs.writeFileSync(path.join(out, 'ic_launcher_background.png'), encodePng(size, drawBackground(size)));
    console.log('adaptive', dir, size);
  }
}

writeAll();
