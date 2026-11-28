// Measures the foreground layer's ink coverage, used to calibrate icon scaling.
// Kept as a file so the shell quoting cannot mangle the code.
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GEN = path.join(ROOT, 'tools/gen-icons.js');
const FG = path.join(ROOT, 'app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png');

function decode(file) {
  const b = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const t = b.toString('ascii', p + 4, p + 8);
    const d = b.slice(p + 8, p + 8 + len);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    p += 12 + len;
  }
  const ch = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch + 1;
  const px = Buffer.alloc(w * h * ch);
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride];
    for (let x = 0; x < w * ch; x++) {
      const cur = raw[y * stride + 1 + x];
      const a = x >= ch ? px[y * w * ch + x - ch] : 0;
      const up = y > 0 ? px[(y - 1) * w * ch + x] : 0;
      const ul = (x >= ch && y > 0) ? px[(y - 1) * w * ch + x - ch] : 0;
      let v = cur;
      if (f === 1) v = (cur + a) & 255;
      else if (f === 2) v = (cur + up) & 255;
      else if (f === 3) v = (cur + ((a + up) >> 1)) & 255;
      else if (f === 4) {
        const pa = Math.abs(up - ul), pb = Math.abs(a - ul), pc = Math.abs(a + up - 2 * ul);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : ul);
        v = (cur + pr) & 255;
      }
      px[y * w * ch + x] = v;
    }
  }
  return { w, h, ch, px };
}

function bounds() {
  const img = decode(FG);
  let minX = img.w, maxX = 0, minY = img.h, maxY = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (img.px[(y * img.w + x) * img.ch + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    wPct: (maxX - minX) / img.w * 100,
    hPct: (maxY - minY) / img.h * 100
  };
}

const base = fs.readFileSync(GEN, 'utf8');
const values = [0.55, 0.7, 0.85, 1.0, 1.2, 1.5];
console.log('scale -> width%  height%');
for (const v of values) {
  const patched = base.replace(/const CONTENT_SCALE = [\d.]+;/, 'const CONTENT_SCALE = ' + v + ';');
  fs.writeFileSync(GEN, patched);
  execFileSync(process.execPath, [GEN], { stdio: 'ignore' });
  const b = bounds();
  console.log(String(v).padEnd(6) + b.wPct.toFixed(1).padStart(6) + '%' + b.hPct.toFixed(1).padStart(8) + '%');
}
// restore the original value
fs.writeFileSync(GEN, base);
console.log('restored');
