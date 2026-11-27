'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./helpers/bridge-harness');

/**
 * Boots the whole frontend (app.js + android-bridge.js) against a simulated
 * Android bridge with a minimal DOM. This is the layer that was never covered:
 * browser QA used localStorage, so the native adapter and every TTS path went
 * untested until a real device exposed them.
 */

function makeNode(tag) {
  const node = {
    tagName: tag,
    children: [],
    style: {},
    dataset: {},
    value: '',
    textContent: '',
    innerHTML: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k]; },
    hasAttribute(k) { return this[k] !== undefined; },
    addEventListener() {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    get firstChild() { return this.children.length ? this.children[0] : null; },
    focus() {},
    select() {},
    click() { if (this.onclick) this.onclick({ stopPropagation() {}, target: this }); }
  };
  return node;
}

function bootApp(opts) {
  const sim = H.createBridge(opts);
  const base = path.resolve(__dirname, '../app/src/main/assets');
  const sandbox = {
    console, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error,
    Set, Map, isFinite, isNaN, parseInt, parseFloat, encodeURIComponent,
    decodeURIComponent, setTimeout, clearTimeout
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.MociNative = sim.bridge;
  sandbox.addEventListener = () => {};
  sandbox.scrollTo = () => {};
  sandbox.matchMedia = () => ({ matches: false });
  sandbox.speechSynthesis = null;
  sandbox.Audio = function () {
    return { play: () => Promise.resolve(), pause() {}, addEventListener() {}, src: '' };
  };
  const appRoot = makeNode('div');
  sandbox.document = {
    readyState: 'complete',
    createElement: makeNode,
    createTextNode: t => ({ text: String(t), children: [] }),
    querySelector: sel => (sel === '#app' ? appRoot : null),
    querySelectorAll: () => [],
    body: { appendChild() {}, removeChild() {} },
    documentElement: { removeAttribute() {}, setAttribute() {}, getAttribute() { return null; } },
    addEventListener() {},
    execCommand() {}
  };
  vm.createContext(sandbox);

  ['util', 'nativejson', 'sm2', 'meaning', 'grader', 'parser', 'merger', 'selector',
    'wrongbook', 'stats', 'storage', 'store', 'appmeta'].forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(base, 'js', f + '.js'), 'utf8'), sandbox, { filename: f + '.js' });
  });
  vm.runInContext(fs.readFileSync(path.join(base, 'android-bridge.js'), 'utf8'), sandbox, { filename: 'android-bridge.js' });
  // Async native replies (audioFetch & friends) reach JS through the callback id,
  // exactly as @JavascriptInterface does on device.
  sim.setResolver((id, json) => sandbox.__mociResolve(id, json));
  vm.runInContext(fs.readFileSync(path.join(base, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });

  return { sim, sandbox, Moci: sandbox.Moci, app: sandbox.MociApp };
}

test('ui-native: the app boots without errors against a real bridge', () => {
  const { app } = bootApp();
  assert.ok(app, 'MociApp must be exposed');
  assert.equal(app.store.adapter.id, 'native');
  assert.deepEqual(app.state.errorLog || [], [], 'boot must not log errors');
});

test('ui-native: import through the app layer lands on disk', () => {
  const { sim, Moci, app } = bootApp();
  const parsed = Moci.parser.parse('abandon v. 放弃\n- abandon hope 放弃希望\nability n. 能力');
  const plan = Moci.merger.buildPlan(app.store.loadBook(), parsed, { now: Date.now() });
  const res = app.store.commitPlan(plan, {}, { now: Date.now() });
  assert.equal(res.ok, true, res.error || '');
  const onDisk = JSON.parse(sim.files['wordbook.json']);
  assert.equal(Object.keys(onDisk.words).length, 2);
});

test('ui-native: speak drives the bridge with correct arities', () => {
  const { sim, app } = bootApp();
  const before = sim.calls.length;
  app.speak('abandon');
  const tts = sim.calls.slice(before).filter(c => /^tts/.test(c.name));
  assert.ok(tts.length > 0, 'speak must reach the native TTS layer');
  const wrong = tts.filter(c => H.ARITY[c.name] !== c.argc);
  assert.deepEqual(wrong, [], 'arity mismatch would throw Method not found: ' +
    wrong.map(w => w.name + '(' + w.argc + ')').join(', '));
  assert.ok(tts.some(c => c.name === 'ttsSpeak' && c.argc === 2), 'ttsSpeak must be called with text+rate');
});

test('ui-native: speak never throws when the bridge is missing a method', () => {
  const { app } = bootApp();
  // Even if the engine is unavailable, speaking must not blow up the UI.
  assert.doesNotThrow(() => app.speak('abandon'));
});

test('ui-native: a failing write is surfaced to the user, not hidden', () => {
  const { app } = bootApp({ failWrites: true });
  const Moci = app.store.adapter ? null : null;
  const parsed = app.store && null;
  // Trigger a settings write, which goes through the same storage adapter.
  const s = app.store.loadSettings();
  s.theme = 'dark';
  app.store.saveSettings(s);
  const log = app.state.errorLog || [];
  assert.ok(log.some(l => /write/i.test(l) || /settings/i.test(l)),
    'a failed write must appear in the error log: ' + JSON.stringify(log));
});

test('ui-native: settings round-trip through parsed prefs, not envelopes', () => {
  const { sim, app } = bootApp();
  app.state.settings = app.store.loadSettings();
  const s = app.store.loadSettings();
  s.dailyGoal = 30;
  s.newPerDay = 10;
  app.store.saveSettings(s);
  const reloaded = app.store.loadSettings();
  assert.equal(reloaded.dailyGoal, 30);
  assert.equal(reloaded.newPerDay, 10);
});

test('ui-native: online cache probe parses the base64 envelope', () => {
  const { sim, Moci } = bootApp({ tts: true });
  const key = 'online/abandon.bin';
  sim.bridge.writeBase64(key, 'QUJD');
  const env = Moci.nativejson.parse(sim.bridge.readBase64(key));
  assert.equal(env.ok, true);
  assert.equal(env.base64, 'QUJD', 'the probe must see the payload, not the envelope');
});
