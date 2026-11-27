'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/bridge-harness');

const APP = fs.readFileSync(path.resolve(__dirname, '../app/src/main/assets/app.js'), 'utf8');

test('prefs: reading a raw prefGet result yields the envelope, not the value', () => {
  // Documents the shape that broke the app: a JSON string is always truthy.
  const sim = H.createBridge();
  sim.bridge.prefSet('apiKey', 'sk-real-key');
  const raw = sim.bridge.prefGet('apiKey');
  assert.equal(typeof raw, 'string');
  assert.equal(raw, '{"ok":true,"value":"sk-real-key"}');
  assert.ok(raw, 'a non-empty string is truthy, which is why !!raw was always true');
});

test('prefs: prefGetBool envelope is truthy even when the value is false', () => {
  const sim = H.createBridge();
  sim.bridge.prefSetBool('allowInsecureHttp', false);
  const raw = sim.bridge.prefGetBool('allowInsecureHttp', false);
  assert.equal(typeof raw, 'string');
  assert.ok(!!raw, '!!envelope was always true -> the toggle read as enabled');
});

test('prefs: no call site reads a raw pref envelope any more', () => {
  const direct = [];
  const re = /root\.MociNative\.(prefGet|prefGetBool)\s*\(/g;
  let m;
  while ((m = re.exec(APP)) !== null) {
    const before = APP.slice(Math.max(0, m.index - 60), m.index);
    // The only allowed use is inside the accessors, wrapped by nativeParse.
    if (!/nativeParse\s*\(\s*$/.test(before)) direct.push(m[1] + ' at ' + m.index);
  }
  assert.deepEqual(direct, [], 'unparsed pref reads: ' + direct.join('; '));
});

test('prefs: accessors parse the envelope and honour defaults', () => {
  const getPrefBody = APP.slice(APP.indexOf('function getPref(k, def)'), APP.indexOf('function setPref(k, v)'));
  assert.ok(getPrefBody.includes('nativeParse('), 'getPref must parse');
  assert.ok(getPrefBody.includes('r.value'), 'getPref must read .value');
  const boolBody = APP.slice(APP.indexOf('function getPrefBool(k, def)'), APP.indexOf('function setPrefBool(k, v)'));
  assert.ok(boolBody.includes('nativeParse('), 'getPrefBool must parse');
  assert.ok(boolBody.includes('!!r.value'), 'getPrefBool must read .value, not the envelope');
});

test('prefs: writes report failures instead of swallowing them', () => {
  const body = APP.slice(APP.indexOf('function setPref(k, v)'), APP.indexOf('function getPrefBool'));
  assert.ok(body.includes('showError'), 'a failed pref write must be visible');
});

test('prefs: api key round-trips through the harness as a plain string', () => {
  const sim = H.createBridge();
  const Moci = H.loadModules(sim.bridge);
  // Exercise the same parse the accessor performs.
  sim.bridge.prefSet('apiKey', 'sk-abc');
  const envelope = Moci.nativejson.parse(sim.bridge.prefGet('apiKey'));
  assert.equal(envelope.value, 'sk-abc');
  assert.equal(typeof envelope.value, 'string');
});

test('prefs: unset key falls back to the default, not to an envelope', () => {
  const sim = H.createBridge();
  const Moci = H.loadModules(sim.bridge);
  const env = Moci.nativejson.parse(sim.bridge.prefGet('missing'));
  assert.equal(env.value, null, 'an unset pref must be null so the caller can default');
});
