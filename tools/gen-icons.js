#!/usr/bin/env node
/**
 * Launcher icon generator — zero dependencies (pure zlib + CRC32).
 *
 * Produces an ADAPTIVE icon, not a pre-rounded bitmap: a solid background layer
 * plus a foreground layer whose artwork stays inside the 66% safe zone. Android
 * applies its own mask (circle, squircle, rounded square…), so baking the corners
 * in — as the AI-generated reference did — produced two rounded edges and a pale
 * ring on launchers using a different shape.
 *
 * Design: geometric white "M" with a sound-wave arc to its right, matching the
 * selected concept. Everything is drawn analytically so every density stays
 * crisp, and the same geometry feeds the legacy square PNG for old launchers.
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

function distToSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy || 1;
  let t = (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Smooth coverage from a signed distance: 1 inside, 0 outside, antialiased edge. */
function cov(dist, halfWidth, px) {
  return Math.max(0, Math.min(1, (halfWidth - dist) / px + 0.5));
}

/**
 * Foreground artwork in a unit box (0..1), drawn with crisp line segments.
 * Kept inside the adaptive safe zone: the mask may crop anything beyond 0.66,
 * so the glyph occupies roughly the middle 56%.
 */
function drawForeground(size, opts) {
  const px = Buffer.alloc(size * size * 4);
  const pxW = 1.6 / size;                    // antialias width in unit space
  const stroke = size * 0.070;               // M stroke thickness

  // Geometric M: left stem, two diagonals, right stem.
  const x0 = size * 0.200, x1 = size * 0.520;      // M sits left of centre
  const yTop = size * 0.325, yBot = size * 0.675;
  const midY = size * 0.555;
  const cxM = (x0 + x1) / 2;
  const segs = [
    [x0, yBot, x0, yTop],
    [x0, yTop, cxM, midY],
    [cxM, midY, x1, yTop],
    [x1, yTop, x1, yBot]
  ];

  // Sound wave: two arcs opening to the right, like a speaker emitting sound.
  // The sweep has to be wide (~90° total): a narrow wedge reads as an arrowhead
  // rather than a sound wave.
  const wcx = size * 0.545, wcy = size * 0.500;
  const arcs = [
    { r: size * 0.100, half: 0.78, w: size * 0.044 },
    { r: size * 0.185, half: 0.70, w: size * 0.044 }
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const sx = x + 0.5, sy = y + 0.5;

      // --- M
      let dM = Infinity;
      for (const [ax, ay, bx, by] of segs) {
        dM = Math.min(dM, distToSeg(sx, sy, ax, ay, bx, by));
      }
      let aM = cov(dM, stroke / 2, 1);

      // --- sound arcs (wedge with soft ends)
      let aW = 0;
      for (const arc of arcs) {
        const dx = sx - wcx, dy = sy - wcy;
        const r = Math.hypot(dx, dy);
        const dRing = Math.abs(r - arc.r);
        if (dRing > arc.w) continue;
        // Angle from +x axis; keep a forward-open wedge.
        const ang = Math.atan2(dy, dx);
        if (Math.abs(ang) > arc.half) continue;
        const edge = Math.min(
          cov(dRing, arc.w / 2, 1),
          // soften the wedge ends so they are not cut off flat
          Math.min(1, (arc.half - Math.abs(ang)) / 0.16)
        );
        aW = Math.max(aW, Math.max(0, edge));
      }

      const a = Math.max(aM, aW);
      if (opts.backgroundOnly) {
        px[i] = BRAND[0]; px[i + 1] = BRAND[1]; px[i + 2] = BRAND[2]; px[i + 3] = 255;
        continue;
      }
      // White artwork on transparent, so Android can mask and add effects.
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
      px[i + 3] = Math.round(255 * a);
    }
  }
  return px;
}

/** Legacy icon: brand rounded square with the same artwork composited on top. */
function drawLegacy(size) {
  const fg = drawForeground(size, {});
  const px = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const r = radius;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded-rect coverage
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

// Monochrome layer (Android 13+ themed icons): white glyph on transparent.
function writeAll() {
  for (const [dir, size] of Object.entries(LEGACY)) {
    const out = path.join(RES, dir);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'ic_launcher.png'), encodePng(size, drawLegacy(size)));
    console.log('legacy ', dir, size);
  }
  for (const [dir, size] of Object.entries(ADAPTIVE)) {
    const out = path.join(RES, dir);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'ic_launcher_foreground.png'), encodePng(size, drawForeground(size, {})));
    fs.writeFileSync(path.join(out, 'ic_launcher_background.png'), encodePng(size, drawForeground(size, { backgroundOnly: true })));
    console.log('adaptive', dir, size);
  }
}

writeAll();
