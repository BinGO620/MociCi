'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * Three device findings after 0.9.9:
 *
 *  1. The speed slider did nothing. It only ever reached the system engine;
 *     recorded audio (the default source) was played with no playbackRate at all.
 *     The slider also could not reach its right end, because the range control
 *     inherited the text-input box whose side padding pushed the track inward.
 *  2. The custom "third-party TTS" block asked for an endpoint nobody has, so it
 *     was removed from settings.
 *  3. An empty-body 403 was reported as a guess. The app now proves where the
 *     block sits by probing a read-only endpoint.
 */

const R = p => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const APP = R('app/src/main/assets/app.js');
const CSS = R('app/src/main/assets/style.css');
const BRIDGE = R('app/src/main/assets/android-bridge.js');
const NB = R('app/src/main/java/com/moci/cet6/NativeBridge.java');
const HP = R('app/src/main/java/com/moci/cet6/HttpProxy.java');
const H = require('./helpers/bridge-harness');

function jsFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start > 0, 'function ' + name + ' must exist');
  let depth = 0;
  let i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(open, i + 1);
}

/* ------------------------------------------------------------ speed control */

test('rate: recorded audio actually applies the speed setting', () => {
  const fn = jsFn(APP, 'playUrl');
  assert.ok(/playbackRate/.test(fn),
    'the clip played with no playbackRate, so the slider did nothing on the default source');
  assert.ok(/speechRate/.test(fn), 'the setting must be read');
});

test('rate: speeding up does not raise the pitch', () => {
  const fn = jsFn(APP, 'playUrl');
  assert.ok(/preservesPitch/.test(fn), 'without this a faster clip sounds like a chipmunk');
});

test('rate: playback rate is set before play() is called', () => {
  const fn = jsFn(APP, 'playUrl');
  const rateAt = fn.indexOf('playbackRate');
  const playAt = fn.indexOf('.play()');
  assert.ok(rateAt >= 0 && playAt >= 0 && rateAt < playAt,
    'setting the rate after play() starts would not apply to that playback');
});

test('rate: the slider is styled as a slider, not a text box', () => {
  // Inheriting .input put 12px of side padding on the track, so the thumb could
  // never visually reach the right end — reported as "the slider is stuck".
  const block = /input\.input\[type=range\]\{[\s\S]*?\n\}/.exec(CSS);
  assert.ok(block, 'the range control needs its own rule');
  assert.ok(/padding:0/.test(block[0]), 'inherited padding is what pushed the track inward');
  assert.ok(/::-webkit-slider-runnable-track/.test(CSS), 'the track needs explicit styling');
  assert.ok(/::-webkit-slider-thumb/.test(CSS), 'the thumb needs explicit styling');
});

test('rate: the slider styling covers Firefox as well', () => {
  assert.ok(/::-moz-range-track/.test(CSS));
  assert.ok(/::-moz-range-thumb/.test(CSS));
});

/* ---------------------------------------------------- third-party TTS removed */

test('settings: the custom endpoint block is gone', () => {
  assert.ok(!/自定义发音接口/.test(APP), 'the custom endpoint UI must be removed');
  assert.ok(!/保存发音接口/.test(APP), 'its save button must be removed too');
  // The input element must not be instantiated either, or it would be dead code.
  assert.ok(!/var online = el\('input'/.test(APP), 'the unused input must be deleted');
});

test('settings: the audio card still explains where sound comes from', () => {
  const fn = jsFn(APP, 'renderSettings');
  assert.ok(/真人发音/.test(fn), 'the source choice remains');
  assert.ok(/系统 TTS/.test(fn), 'the fallback remains selectable');
  assert.ok(/语速/.test(fn), 'the speed control remains');
  assert.ok(/audioStorageRow/.test(fn), 'storage usage stays visible');
});

/* ------------------------------------------------------- 403 localisation */

test('403: the app probes a read-only endpoint to locate the block', () => {
  const fn = jsFn(APP, 'probeGatewayModels');
  assert.ok(/\/models/.test(fn), 'a trivial read-only endpoint is the probe');
  assert.ok(/httpGetJson/.test(fn), 'it must use the plain JSON GET');
});

test('403: an equally blocked probe points at the campus-network restriction', () => {
  const fn = jsFn(APP, 'testConnection');
  assert.ok(/网关拒绝访问/.test(fn), 'the verdict must be stated when the probe is blocked');
  assert.ok(/与 API Key、模型名无关/.test(fn), 'the user must stop chasing the key');
  // The real cause on this deployment: the university gateway only answers
  // requests sourced from the campus network, so a 5G connection is refused.
  assert.ok(/校园网|校园 WiFi/.test(fn), 'the campus-network requirement must be named');
  assert.ok(/VPN/.test(fn), 'a VPN is the usual workaround and must be offered');
});

test('403: a reachable probe rules the network out', () => {
  const fn = jsFn(APP, 'testConnection');
  assert.ok(/网关可达/.test(fn), 'a working probe means the block is request-specific');
});

test('403: an inconclusive probe is not over-claimed', () => {
  const fn = jsFn(APP, 'probeGatewayModels');
  assert.ok(/finish\(null\)/.test(fn), 'a failed probe must resolve as inconclusive');
  assert.ok(/12000|setTimeout/.test(fn), 'the probe must time out instead of hanging the UI');
});

test('403: the diagnostic probe exists on the native side', () => {
  assert.ok(/public void httpGetJson\(String url, String callbackId\)/.test(NB));
  assert.ok(/void getJson\(String url, Callback cb\)/.test(HP));
  assert.ok(/Authorization/.test(/void getJson[\s\S]*?\n    \}/.exec(HP)[0]),
    'the probe must carry credentials, or a 401 would masquerade as a block');
  assert.equal(H.ARITY.httpGetJson, 2);
  assert.ok(/httpGetJson: function/.test(BRIDGE), 'the bridge must expose it');
});

test('403: the probe reuses the same authorisation, so only the path differs', () => {
  const probe = jsFn(APP, 'probeGatewayModels');
  const prefs = jsFn(APP, 'testConnection');
  assert.ok(/base \+ '\/models'/.test(probe), 'the probe targets the configured gateway');
  assert.ok(/base/.test(prefs), 'both use the same base URL');
});
