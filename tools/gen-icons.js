#!/usr/bin/env node
/**
 * Launcher icon generator — zero dependencies (pure zlib + CRC32).
 *
 * Design: a cute geometric owl — round coral head, two big eyes, a small orange
 * beak, two ear tufts — on a solid teal background. The owl is the app's mascot;
 * a letter-plus-pen mark was rejected by the user as ugly.
 *
 * Why hand-drawn geometry instead of the AI-generated reference illustration:
 * that image was a raster with antialiased outlines, so downscaling to 48dp left
 * soft fringes, and it had a baked-in background. Drawing the shapes analytically
 * keeps every density crisp and lets the icon be a proper adaptive icon.
 *
 * Outputs an ADAPTIVE icon (separate background/foreground layers) because the
 * launcher applies its own mask; baking corners in produced a pale double-rounded
 * ring on launchers using a different shape.
 */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RES = path.join(ROOT, 'app/src/main/res');

const LEGACY = {
  'mipmap-mdpi': 48, 'mipmap-hdpi': 72, 'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144, 'mipmap-xxxhdpi': 192
};
const ADAPTIVE = {
  'mipmap-mdpi': 108, 'mipmap-hdpi': 162, 'mipmap-xhdpi': 216,
  'mipmap-xxhdpi': 324, 'mipmap-xxxhdpi': 432
};

/** Palette — teal field, coral owl, warm beak, dark eyes. */
const BG = [0, 176, 165];
const HEAD = [242, 92, 74];
const HEAD_DARK = [214, 74, 58];
const FACE = [255, 236, 214];
const BEAK = [255, 176, 32];
const EYE = [58, 38, 34];
const OUTLINE = [52, 34, 30];

const SS = 4; // supersamples per axis

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
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
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

function inEllipse(px, py, cx, cy, rx, ry) {
  const dx = (px - cx) / rx, dy = (py - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

/** Rounded triangle (beak): a triangle with slightly softened corners. */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Which colour a point maps to, or null for transparent.
 * Coordinates are in pixel space of a `size`-wide square.
 */
function shadeAt(x, y, size, withBackground) {
  // Shrink the artwork around the centre so the owl fits the adaptive-icon safe
  // zone (the launcher may crop to a circle, so content must stay inside ~66%).
  //
  // Multiplying the offset by S (S < 1) shrinks the drawing. This was got wrong
  // twice by assuming division would shrink it — it does the opposite, because a
  // larger offset lets every shape reach further from the centre.
  const CONTENT_SCALE = 0.96;
  const cx0 = size / 2, cy0 = size / 2;
  x = cx0 + (x - cx0) * CONTENT_SCALE;
  y = cy0 + (y - cy0) * CONTENT_SCALE;

  const u = x / size, v = y / size;

  // Head: a wide ellipse, slightly taller than a circle for a friendly look.
  const headCx = 0.50, headCy = 0.535;
  const headRx = 0.305, headRy = 0.300;

  // Ear tufts: triangles that OVERLAP the head so they read as part of it rather
  // than floating above it. Their bases sit well inside the head ellipse.
  const earL = inTriangle(x, y, size * 0.285, size * 0.415, size * 0.230, size * 0.196, size * 0.400, size * 0.300);
  const earR = inTriangle(x, y, size * 0.715, size * 0.415, size * 0.770, size * 0.196, size * 0.600, size * 0.300);

  const inHead = inEllipse(x, y, size * headCx, size * headCy, size * headRx, size * headRy);

  if (!inHead && !earL && !earR) {
    return withBackground ? { rgb: BG, a: 1 } : null;
  }

  // Ear tufts carry the head colour.
  if (!inHead && (earL || earR)) return { rgb: HEAD, a: 1 };

  // Face plate: a paler ellipse inside the head, giving the owl its "mask".
  const faceCx = 0.50, faceCy = 0.575, faceRx = 0.255, faceRy = 0.235;
  const inFace = inEllipse(x, y, size * faceCx, size * faceCy, size * faceRx, size * faceRy);

  // Eyes: big white discs with a dark pupil and a small highlight.
  const eyeCxL = 0.395, eyeCxR = 0.605, eyeCy = 0.520;
  const eyeRx = 0.113, eyeRy = 0.118;
  const inEyeL = inEllipse(x, y, size * eyeCxL, size * eyeCy, size * eyeRx, size * eyeRy);
  const inEyeR = inEllipse(x, y, size * eyeCxR, size * eyeCy, size * eyeRx, size * eyeRy);

  const pupilRx = 0.072, pupilRy = 0.078;
  const inPupilL = inEllipse(x, y, size * (eyeCxL + 0.006), size * (eyeCy + 0.012), size * pupilRx, size * pupilRy);
  const inPupilR = inEllipse(x, y, size * (eyeCxR + 0.006), size * (eyeCy + 0.012), size * pupilRx, size * pupilRy);

  const hiR = 0.026;
  const inHiL = inEllipse(x, y, size * (eyeCxL + 0.035), size * (eyeCy - 0.030), size * hiR, size * hiR);
  const inHiR = inEllipse(x, y, size * (eyeCxR + 0.035), size * (eyeCy - 0.030), size * hiR, size * hiR);

  // Beak: a small downward triangle between the eyes, with soft corner look.
  const inBeak = inTriangle(
    x, y,
    size * 0.448, size * 0.610,
    size * 0.552, size * 0.610,
    size * 0.500, size * 0.722
  );

  if (inBeak) return { rgb: BEAK, a: 1 };
  if (inHiL || inHiR) return { rgb: [255, 255, 255], a: 1 };
  if (inPupilL || inPupilR) return { rgb: EYE, a: 1 };
  if (inEyeL || inEyeR) return { rgb: [255, 255, 255], a: 1 };
  if (inFace) return { rgb: FACE, a: 1 };

  // Body shading: darken only the very bottom sliver of the head so the owl reads
  // as rounded. An earlier hard cut at v>0.70 drew a visible horizontal seam.
  if (inHead && v > 0.775) return { rgb: HEAD_DARK, a: 1 };
  return { rgb: HEAD, a: 1 };
}

/** Foreground layer: owl on transparent, sized for the adaptive safe zone. */
function drawForeground(size) {
  const px = Buffer.alloc(size * size * 4);
  const step = 1 / SS, total = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shadeAt(x + (sx + 0.5) * step, y + (sy + 0.5) * step, size, false);
          if (!c) continue;
          r += c.rgb[0]; g += c.rgb[1]; b += c.rgb[2]; hits++;
        }
      }
      if (!hits) continue;
      const i = (y * size + x) * 4;
      // Average colour of covered subsamples; alpha from coverage. This keeps
      // edges smooth without the fringe a naive threshold produced.
      px[i] = Math.round(r / hits);
      px[i + 1] = Math.round(g / hits);
      px[i + 2] = Math.round(b / hits);
      px[i + 3] = Math.round(255 * hits / total);
    }
  }
  return px;
}

/** Solid teal field for the adaptive background layer. */
function drawBackground(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = BG[0];
    px[i * 4 + 1] = BG[1];
    px[i * 4 + 2] = BG[2];
    px[i * 4 + 3] = 255;
  }
  return px;
}

/** Legacy icon: teal rounded square with the owl composited on top. */
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
      px[i] = Math.round(BG[0] * (1 - a) + fg[i] * a);
      px[i + 1] = Math.round(BG[1] * (1 - a) + fg[i + 1] * a);
      px[i + 2] = Math.round(BG[2] * (1 - a) + fg[i + 2] * a);
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
