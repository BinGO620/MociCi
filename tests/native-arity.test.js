'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * Android resolves @JavascriptInterface methods by exact arity. Calling a
 * 2-argument Java method with 3 JS arguments throws "Method not found" — which
 * silently broke ALL storage writes on a real device while every unit test and
 * browser run stayed green. These tests pin the contract.
 */

const NB = fs.readFileSync(path.resolve(__dirname, '../app/src/main/java/com/moci/cet6/NativeBridge.java'), 'utf8');
const STORAGE = fs.readFileSync(path.resolve(__dirname, '../app/src/main/assets/js/storage.js'), 'utf8');
const BRIDGE_JS = fs.readFileSync(path.resolve(__dirname, '../app/src/main/assets/android-bridge.js'), 'utf8');
const APP = fs.readFileSync(path.resolve(__dirname, '../app/src/main/assets/app.js'), 'utf8');

/** method name -> declared parameter count, parsed from the Java source. */
function javaArities() {
  const map = {};
  const re = /public\s+(?:String|void)\s+([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(NB)) !== null) {
    const params = m[2].trim();
    map[m[1]] = params === '' ? 0 : params.split(',').length;
  }
  return map;
}

const ARITY = javaArities();

function jsArities(source, pattern) {
  const out = [];
  const re = new RegExp(pattern, 'g');
  let m;
  while ((m = re.exec(source)) !== null) out.push(m);
  return out;
}

test('native: writeText is declared with exactly 2 parameters', () => {
  assert.equal(ARITY.writeText, 2);
});

test('native: storage adapter calls writeText with 2 arguments', () => {
  assert.ok(/call2\('writeText',\s*rel,\s*text\)/.test(STORAGE),
    'writeText must be invoked through call2, not a generic 3-arg helper');
  assert.ok(!/call\('writeText'/.test(STORAGE), 'no generic-arity helper may be used');
});

test('native: storage adapter uses arity-specific helpers only', () => {
  assert.ok(!/\bcall\(/.test(STORAGE), 'the old 3-arg call() helper must be gone');
  ['call0', 'call1', 'call2'].forEach(h => assert.ok(STORAGE.includes('function ' + h), h + ' missing'));
});

test('native: every storage method uses the arity its Java signature declares', () => {
  const pairs = [
    ['readText', 1], ['stat', 1], ['list', 1], ['delete', 1], ['storageInfo', 0]
  ];
  pairs.forEach(([fn, n]) => {
    assert.equal(ARITY[fn], n, fn + ' Java arity drifted');
    const helper = 'call' + n + "('" + fn + "'";
    assert.ok(STORAGE.includes(helper), fn + ' must be called via ' + 'call' + n);
  });
});

test('native: android-bridge ttsSpeak passes exactly 2 arguments', () => {
  assert.equal(ARITY.ttsSpeak, 2);
  assert.ok(/ttsSpeak:\s*function\s*\(\s*t\s*,\s*r\s*\)/.test(BRIDGE_JS));
});

test('native: android-bridge zero-argument methods take no params', () => {
  ['ttsStop', 'ttsStatus', 'ttsEngines', 'platform', 'storageInfo', 'ttsIsReady'].forEach(fn => {
    assert.equal(ARITY[fn], 0, fn + ' Java arity');
    const re = new RegExp(fn + ':\\s*function\\s*\\(\\s*\\)');
    assert.ok(re.test(BRIDGE_JS), fn + ' must be declared with no JS params');
  });
});

test('native: prefGet/prefSet arities match the Java side', () => {
  assert.equal(ARITY.prefGet, 1);
  assert.equal(ARITY.prefSet, 2);
  assert.ok(/prefGet:\s*function\s*\(\s*k\s*\)/.test(BRIDGE_JS));
  assert.ok(/prefSet:\s*function\s*\(\s*k\s*,\s*v\s*\)/.test(BRIDGE_JS));
});

test('native: every method the JS bridge calls exists in Java', () => {
  const called = new Set();
  const re = /root\.MociNative\.([a-zA-Z]+)\s*\(/g;
  let m;
  [BRIDGE_JS, APP].forEach(src => {
    while ((m = re.exec(src)) !== null) called.add(m[1]);
  });
  const missing = [...called].filter(fn => !(fn in ARITY));
  assert.deepEqual(missing, [], 'JS calls methods Java does not expose: ' + missing.join(', '));
});

test('native: storage self-test hook exists for on-device diagnosis', () => {
  assert.ok(/selfTest:\s*function/.test(STORAGE));
  assert.ok(STORAGE.includes("call2('writeText'"), 'self-test must exercise the real writer');
});

test('native: a failed write surfaces an error instead of pretending success', () => {
  // The native adapter's write lives after the memory/web adapters.
  const nativeStart = STORAGE.indexOf('function nativeAdapter');
  const start = STORAGE.indexOf('write: function (rel, text)', nativeStart);
  const fn = STORAGE.slice(start, STORAGE.indexOf('},', start) + 2);
  assert.ok(start > nativeStart, 'must locate the native adapter write');
  assert.ok(fn.includes('call2'), 'write goes through call2');
  assert.ok(!fn.includes('ok: true'), 'must never fabricate a success result');
});
