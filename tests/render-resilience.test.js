'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/bridge-harness');

/**
 * A device report showed a blank screen with only "脚本错误 : Script error. (:0:0)".
 *
 * Cause: render() clears #app BEFORE building the view, so any exception thrown
 * while building leaves a permanently empty page. screenStudy() indexed
 * s.cards[s.index] without bounds checks, and an empty/out-of-range card list is
 * reachable (words deleted while a saved round was resuming).
 *
 * Two things are pinned here:
 *   1. screenStudy survives a bad session instead of throwing.
 *   2. render() can never leave the app blank, whatever a view does.
 */

const R = p => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const APP = R('app/src/main/assets/app.js');

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

/* ------------------------------------------------------- study screen guards */

test('study: an empty card list shows a message instead of crashing', () => {
  const fn = jsFn(APP, 'screenStudy');
  assert.ok(/!s\.cards \|\| !s\.cards\.length/.test(fn),
    's.cards[s.index] on an empty list is undefined, and reading .isNew then throws');
  assert.ok(/这一轮没有可学的卡片/.test(fn), 'the user needs to be told why it is empty');
});

test('study: an out-of-range index is clamped, not indexed blindly', () => {
  const fn = jsFn(APP, 'screenStudy');
  assert.ok(/s\.index >= s\.cards\.length/.test(fn), 'a stale index must not overflow');
  assert.ok(/s\.index = s\.cards\.length - 1/.test(fn), 'clamp to the last card');
  assert.ok(/s\.index < 0/.test(fn), 'and guard the negative case');
});

test('study: the guards run before the card is read', () => {
  const fn = jsFn(APP, 'screenStudy');
  const guardAt = fn.indexOf('!s.cards');
  const cardAt = fn.indexOf('var card = s.cards[s.index]');
  assert.ok(guardAt >= 0 && cardAt > guardAt, 'the bounds check must come first');
});

/* --------------------------------------------------------- render must not blank */

test('render: a throwing view cannot leave the app blank', () => {
  const fn = jsFn(APP, 'render');
  assert.ok(/try \{/.test(fn) && /catch/.test(fn),
    'clear(app) happens before drawing, so an exception here wipes the page');
  assert.ok(/renderCrashScreen/.test(fn), 'a recoverable screen must be substituted');
});

test('render: the fallback screen offers a way out', () => {
  const fn = jsFn(APP, 'renderCrashScreen');
  assert.ok(/回首页/.test(fn), 'the user must be able to leave the broken view');
  assert.ok(/你的数据不会因此丢失/.test(fn), 'reassurance matters when the app looks broken');
  assert.ok(/clearSession/.test(fn), 'a broken round must be discardable');
});

test('render: the failure is surfaced, not swallowed', () => {
  const fn = jsFn(APP, 'render');
  assert.ok(/showError/.test(fn), 'the underlying message must reach the error bar');
});

/* -------------------------------------------------------------- audio in review */

test('handwriting: the question list can be heard, but only in Chinese', () => {
  const fn = jsFn(APP, 'renderDictateHand');
  assert.ok(/speak\(q\.prompt\)/.test(fn),
    'the Chinese prompt is the only safe thing to read aloud here');
  // Reading the answer would hand over the spelling, exactly like printing the
  // owning word did.
  assert.ok(!/speak\(q\.answer\)/.test(fn), 'reading the answer would leak it');
});

test('handwriting: the review screen reads the answer, which is already shown', () => {
  const fn = jsFn(APP, 'renderHandResult');
  assert.ok(/speak\(r\.q\.answer\)/.test(fn),
    'on the review screen the answer is printed anyway, so audio is safe');
});

test('handwriting: the header count follows manual corrections', () => {
  const fn = jsFn(APP, 'renderHandResult');
  assert.ok(/refreshSummary/.test(fn), 'flipping a verdict must update the header count');
  assert.ok(/subEl\.textContent/.test(fn), 'the count is re-rendered in place');
});

/* ------------------------------------------------------------ runtime proof */

test('runtime: a bad session renders instead of throwing', () => {
  const vm = require('vm');
  const sim = H.createBridge();
  const base = path.resolve(__dirname, '../app/src/main/assets');
  function mkNode(tag) {
    return {
      tagName: tag, children: [], style: {}, dataset: {}, value: '', textContent: '',
      innerHTML: '', className: '',
      setAttribute(k, v) { this[k] = v; },
      getAttribute(k) { return this[k]; },
      hasAttribute(k) { return this[k] !== undefined; },
      addEventListener() {},
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { this.children = this.children.filter(x => x !== c); },
      get firstChild() { return this.children.length ? this.children[0] : null; },
      focus() {}, select() {}, click() {}
    };
  }
  const rootNode = mkNode('div');
  const sandbox = {
    console, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error,
    Set, Map, isFinite, isNaN, parseInt, parseFloat, encodeURIComponent,
    decodeURIComponent, setTimeout, clearTimeout
  };
  sandbox.self = sandbox; sandbox.window = sandbox; sandbox.MociNative = sim.bridge;
  sandbox.addEventListener = () => {}; sandbox.scrollTo = () => {};
  sandbox.matchMedia = () => ({ matches: false });
  sandbox.speechSynthesis = null;
  sandbox.Audio = function () { return { play: () => Promise.resolve(), pause() {}, addEventListener() {}, src: '' }; };
  sandbox.document = {
    readyState: 'complete', createElement: mkNode,
    createTextNode: t => ({ textContent: String(t), children: [] }),
    querySelector: s => (s === '#app' ? rootNode : null),
    querySelectorAll: () => [],
    body: { appendChild() {}, removeChild() {} },
    documentElement: { removeAttribute() {}, setAttribute() {}, getAttribute() { return null; } },
    addEventListener() {}, execCommand() {}
  };
  vm.createContext(sandbox);
  ['util', 'nativejson', 'sm2', 'meaning', 'grader', 'parser', 'merger', 'selector',
    'wrongbook', 'stats', 'storage', 'store', 'appmeta'].forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(base, 'js', f + '.js'), 'utf8'), sandbox, { filename: f + '.js' });
  });
  vm.runInContext(fs.readFileSync(path.join(base, 'android-bridge.js'), 'utf8'), sandbox, { filename: 'bridge' });
  vm.runInContext(fs.readFileSync(path.join(base, 'app.js'), 'utf8'), sandbox, { filename: 'app' });

  const app = sandbox.MociApp;
  assert.doesNotThrow(() => {
    app.state.session = { cards: [], index: 0, flipped: false, mode: null,
      questions: null, qIndex: 0, answers: [], finished: false };
    app.navigate('study');
  }, 'an empty card list must not throw');
  assert.doesNotThrow(() => {
    app.state.session = { cards: [{ key: 'a', en: 'a', zh: 'x', collo: [], isNew: true }],
      index: 99, flipped: false, mode: null, questions: null, qIndex: 0, answers: [], finished: false };
    app.navigate('study');
  }, 'an out-of-range index must not throw');
});
