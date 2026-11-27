'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const NJ = require('../app/src/main/assets/js/nativejson.js');

const APP = fs.readFileSync(path.resolve(__dirname, '../app/src/main/assets/app.js'), 'utf8');
const HTML = fs.readFileSync(path.resolve(__dirname, '../app/src/main/assets/index.html'), 'utf8');

test('nativejson: parses the JSON strings that JavascriptInterface returns', () => {
  const v = NJ.parse('{"ok":true,"path":"/data/app/cache/tts/a.wav"}');
  assert.equal(v.ok, true);
  assert.equal(v.path, '/data/app/cache/tts/a.wav');
});

test('nativejson: a raw string has no ok/path (documents the original bug)', () => {
  const raw = '{"ok":true,"path":"x"}';
  assert.equal(raw.ok, undefined);
  assert.equal(raw.path, undefined);
});

test('nativejson: tolerates null, garbage, empty and objects', () => {
  assert.equal(NJ.parse(null), null);
  assert.equal(NJ.parse('not json'), null);
  assert.equal(NJ.parse(''), null);
  assert.deepEqual(NJ.parse({ ok: true }), { ok: true });
  assert.equal(NJ.parse(null, { ok: false }).ok, false);
});

test('nativejson: ok() refuses falsy payloads', () => {
  assert.equal(NJ.ok('{"ok":true}'), true);
  assert.equal(NJ.ok('{"ok":false,"error":"x"}'), false);
  assert.equal(NJ.ok(null), false);
  assert.equal(NJ.ok('garbage'), false);
});

test('app: the prefetch cache lookup parses the bridge reply', () => {
  const start = APP.indexOf('function prefetchedAudio');
  const fn = APP.slice(start, APP.indexOf('function onlineCacheKey', start));
  assert.ok(fn.includes('nativeParse('), 'must parse instead of reading .ok off a string');
  // Every guarded read must follow a nativeParse call, never a bare bridge result.
  assert.ok(!/=\s*root\.MociNative\.(ttsCachedPath|readBase64)\([^)]*\)\s*;/.test(fn),
    'no raw bridge result may be assigned and then inspected');
});

test('app: the audio cache probe parses the bridge reply', () => {
  const fn = APP.slice(APP.indexOf('function warmAudioCache'), APP.indexOf('function audioCacheKey'));
  assert.ok(fn.includes('nativeParse('), 'a raw JSON string must never be read as an object');
});

test('app: speakSystem parses the ttsSpeak reply before judging success', () => {
  const fn = APP.slice(APP.indexOf('function speakSystem'), APP.indexOf('var audioEl = null'));
  assert.ok(fn.includes('nativeParse('));
  assert.ok(fn.includes('spoken === false'));
});

test('app: cached human audio is played from a file path on a hit', () => {
  const start = APP.indexOf('function speak(text)');
  const fn = APP.slice(start, APP.indexOf('function warmAudioCache', start));
  assert.ok(fn.includes('prefetchedAudio(text)'), 'a cache hit must short-circuit before the engine');

  const prefetchStart = APP.indexOf('function prefetchedAudio');
  // Slice to the NEXT top-level declaration; audioCacheKey is first *called*
  // earlier in the file, so searching for its name would cut in the wrong place.
  const prefetchFn = APP.slice(prefetchStart, APP.indexOf('\n  function prefetchWord', prefetchStart));
  // Clips are downloaded to disk and played via file://; routing the bytes back
  // through JS as base64 + a data: URL was the slow path this replaced.
  assert.ok(prefetchFn.includes('audioCachedPath'), 'the disk cache must be consulted');
  assert.ok(prefetchFn.includes("'file://'"), 'cached clips play from a file URL');
  assert.ok(!prefetchFn.includes('data:'), 'audio must not travel through the bridge as base64');
});

test('index.html loads nativejson before app.js', () => {
  const nj = HTML.indexOf('js/nativejson.js');
  const app = HTML.indexOf('app.js');
  assert.ok(nj > 0, 'nativejson.js must be included');
  assert.ok(nj < app, 'nativejson.js must load before app.js');
});

test('ui: el() assigns textarea/select value via the property, not setAttribute', () => {
  const APP2 = fs.readFileSync(path.resolve(__dirname, '../app/src/main/assets/app.js'), 'utf8');
  const helper = APP2.slice(APP2.indexOf('var el = function'), APP2.indexOf('var $ = function'));
  // setAttribute('value') is ignored by <textarea>; editable boxes stayed empty.
  assert.ok(helper.includes("k === 'value'"), 'el must special-case the value key');
  assert.ok(helper.includes('node.value = v'), 'value must be assigned as a property');
});
