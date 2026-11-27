'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * Camera capture crosses two different app-private directories:
 *   - CameraFileProvider writes into getCacheDir()/camera/
 *   - AtomicStore is sandboxed to getFilesDir()
 *
 * 0.9.3 shipped `store.readBase64(relToRoot(f))`, where relToRoot rejected any
 * path outside the store root. The capture therefore ALWAYS failed with
 * "outside root" and the app silently fell back to the gallery picker — a path
 * no unit test or browser run could ever reach. These tests pin the fix.
 */

const MA = fs.readFileSync(path.resolve(__dirname, '../app/src/main/java/com/moci/cet6/MainActivity.java'), 'utf8');
const PROVIDER = fs.readFileSync(path.resolve(__dirname, '../app/src/main/java/com/moci/cet6/CameraFileProvider.java'), 'utf8');
const STORE = fs.readFileSync(path.resolve(__dirname, '../app/src/main/java/com/moci/cet6/AtomicStore.java'), 'utf8');

/** Extracts the REQ_CAMERA branch of onActivityResult. */
function cameraBranch() {
  const start = MA.indexOf('if (requestCode == REQ_CAMERA)');
  assert.ok(start > 0, 'camera result branch must exist');
  const end = MA.indexOf('if (requestCode == REQ_SAVE_FILE)', start);
  assert.ok(end > start, 'camera branch must be followed by the save-file branch');
  return MA.slice(start, end);
}

test('camera: the capture is not read through the storage sandbox', () => {
  const branch = cameraBranch();
  assert.ok(!/store\.readBase64/.test(branch),
    'the capture lives in getCacheDir(), outside AtomicStore root — store.readBase64 always throws');
  assert.ok(!/relToRoot/.test(branch), 'the path-relativising helper must not be used for the capture');
});

test('camera: the removed helper does not come back anywhere', () => {
  assert.ok(!/relToRoot/.test(MA), 'relToRoot rejected every cache path; it must stay deleted');
});

test('camera: the capture directory and the store root are provably different', () => {
  // Guard the assumption behind the fix, not just the call site.
  assert.ok(/new File\(getCacheDir\(\),\s*"camera"\)/.test(MA), 'capture must be written under getCacheDir()/camera');
  assert.ok(/new File\(getContext\(\)\.getCacheDir\(\),\s*"camera"\)/.test(PROVIDER),
    'the provider must resolve the same directory the activity writes to');
  assert.ok(/this\.root\s*=\s*ctx\.getFilesDir\(\)/.test(STORE), 'store root is getFilesDir()');
  assert.ok(!/getCacheDir/.test(STORE), 'the store sandbox must never be widened to the cache dir');
});

test('camera: the provider and the activity agree on the authority', () => {
  const authority = /AUTHORITY\s*=\s*"([^"]+)"/.exec(PROVIDER)[1];
  assert.ok(new RegExp('android:authorities="' + authority.replace(/\./g, '\\.') + '"').test(
    fs.readFileSync(path.resolve(__dirname, '../app/src/main/AndroidManifest.xml'), 'utf8')),
    'manifest authorities must match CameraFileProvider.AUTHORITY');
});

test('camera: a large photo is downsampled before crossing the bridge', () => {
  assert.ok(/MAX_UPLOAD_EDGE/.test(MA), 'a max edge must bound the decoded bitmap');
  assert.ok(/inSampleSize/.test(MA), 'decoding must downsample, not allocate the full bitmap');
  assert.ok(/createScaledBitmap/.test(MA), 'the sampled bitmap must be scaled to the edge cap');
  assert.ok(/MAX_UPLOAD_BYTES/.test(MA), 'a compressed-size ceiling must exist');

  const edge = /MAX_UPLOAD_EDGE\s*=\s*(\d+)/.exec(MA);
  assert.ok(edge && Number(edge[1]) >= 800 && Number(edge[1]) <= 2048,
    'edge cap must stay legible for handwriting while bounding the payload');

  const bytes = /MAX_UPLOAD_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)/.exec(MA);
  assert.ok(bytes, 'byte cap must be declared as a product');
  const cap = Number(bytes[1]) * Number(bytes[2]);
  // Base64 inflates by 4/3; the resulting string must stay well under bridge limits.
  assert.ok(cap > 0 && cap * 4 / 3 < 4 * 1024 * 1024, 'base64 payload must stay small enough for evaluateJavascript');
});

test('camera: EXIF rotation is baked in before upload', () => {
  assert.ok(/ExifInterface/.test(MA), 'camera JPEGs store orientation in EXIF');
  assert.ok(/ORIENTATION_ROTATE_90/.test(MA), '90° rotation must be handled');
  assert.ok(/ORIENTATION_ROTATE_270/.test(MA), '270° rotation must be handled');
  assert.ok(/postRotate/.test(MA), 'rotation must be applied to the pixels');
  assert.ok(/applyExifRotation/.test(MA), 'rotation must run inside the capture pipeline');
});

test('camera: decoded bitmaps are recycled', () => {
  const start = MA.indexOf('private byte[] shrinkForUpload');
  assert.ok(start > 0, 'shrinkForUpload must exist');
  const fn = MA.slice(start, MA.indexOf('private static int sampleSizeFor', start));
  assert.ok(/recycle\(\)/.test(fn), 'multi-MB bitmaps must be released after compression');
  assert.ok(/finally/.test(fn), 'recycling must survive a compression failure');
});

test('camera: the temp capture is deleted after it is read', () => {
  const branch = cameraBranch();
  assert.ok(/f\.delete\(\)/.test(branch), 'the capture must not accumulate in the cache dir');
  assert.ok(/finally/.test(branch), 'cleanup must run even when reading fails');
});

test('camera: reading the capture happens off the UI thread', () => {
  const branch = cameraBranch();
  assert.ok(/new Thread\(/.test(branch),
    'base64-encoding a multi-MB photo on the UI thread would freeze the WebView');
});

test('camera: both success and failure resolve the JS callback', () => {
  const branch = cameraBranch();
  assert.ok(/jsResolve\(cb,\s*"\{\\"ok\\":true/.test(branch), 'success path must resolve');
  assert.ok(/jsResolve\(cb,\s*"\{\\"ok\\":false/.test(branch), 'failure path must resolve');
  // A cancelled capture resolves too, otherwise the JS promise hangs to timeout.
  assert.ok(/cancelled/.test(branch), 'cancellation must resolve instead of hanging');
});

test('camera: the JS side falls back to the picker only on a real error', () => {
  const APP = fs.readFileSync(path.resolve(__dirname, '../app/src/main/assets/app.js'), 'utf8');
  const start = APP.indexOf('function pickHandwritingImage');
  assert.ok(start > 0, 'pickHandwritingImage must exist');
  const fn = APP.slice(start, APP.indexOf('function gradeHandwriting', start));
  assert.ok(/r\.error\s*!==\s*'cancelled'/.test(fn),
    'a user cancellation must not silently trigger a second picker');
  assert.ok(/bridge\.pickImage/.test(fn), 'a capture failure should still offer the gallery');
});
