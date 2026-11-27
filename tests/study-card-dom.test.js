'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/bridge-harness');

/**
 * DOM-level check for the study-card POS layout.
 *
 * The v0.9.4 device report described a verb whose "v." occupied its own line
 * while the noun sense stayed on the verb's line. String-level tests cannot see
 * that — only the rendered tree can. This boots the real frontend against the
 * simulated bridge and inspects the nodes it produces.
 */

function makeNode(tag) {
  return {
    tagName: tag, children: [], style: {}, dataset: {}, value: '',
    textContent: '', innerHTML: '',
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k]; },
    hasAttribute(k) { return this[k] !== undefined; },
    addEventListener() {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    get firstChild() { return this.children.length ? this.children[0] : null; },
    click() { if (this.onclick) this.onclick({ stopPropagation() {}, target: this }); }
  };
}

/** el() writes node.className, not the class attribute. */
function clsOf(node) {
  if (!node) return '';
  return String(node.className || node['class'] || '');
}

/** Text of a node, including children. */
function textOf(node) {
  if (!node) return '';
  if (node.children && node.children.length) {
    return node.children.map(textOf).join('');
  }
  return String(node.textContent || node.value || '');
}

function boot() {
  const vm = require('vm');
  const sim = H.createBridge();
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
  sandbox.Audio = function () { return { play: () => Promise.resolve(), pause() {}, addEventListener() {}, src: '' }; };
  const appRoot = makeNode('div');
  sandbox.document = {
    readyState: 'complete',
    createElement: makeNode,
    createTextNode: t => ({ textContent: String(t), children: [] }),
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
  vm.runInContext(fs.readFileSync(path.join(base, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
  return { sim, sandbox, app: sandbox.MociApp };
}

/** Renders one card body and returns the POS rows as [{pos, text}]. */
function renderRows(pos, zh) {
  const { app } = boot();
  const container = makeNode('div');
  app.appendMeaningBlock(container, pos, zh);
  const rows = [];
  (function walk(n) {
    if (!n) return;
    if (clsOf(n) === 'zh-row') {
      const posNode = (n.children || []).find(c => clsOf(c) === 'zh-pos');
      const textNode = (n.children || []).find(c => clsOf(c) === 'zh-text');
      rows.push({
        pos: posNode ? textOf(posNode).trim() : '',
        text: textNode ? textOf(textNode).trim() : ''
      });
      return;
    }
    (n.children || []).forEach(walk);
  })(container);
  return rows;
}

test('study card dom: verb and noun each get their own aligned row', () => {
  const rows = renderRows('v.', '有益于 n. 益处');
  assert.deepEqual(rows, [
    { pos: 'v.', text: '有益于' },
    { pos: 'n.', text: '益处' }
  ], 'the noun sense must not stay on the verb line');
});

test('study card dom: a repeated leading marker is not printed twice', () => {
  const rows = renderRows('v.', 'v. 有益于 n. 益处');
  assert.equal(rows.length, 2, 'a marker matching the entry POS must be folded into it');
  assert.equal(rows[0].pos, 'v.');
  assert.equal(rows[0].text, '有益于');
});

test('study card dom: multi-sense, multi-item stays readable', () => {
  const rows = renderRows('v.', 'v. 有益于；对…有益 n. 益处；好处；福利');
  assert.deepEqual(rows, [
    { pos: 'v.', text: '有益于；对…有益' },
    { pos: 'n.', text: '益处；好处；福利' }
  ]);
});

test('study card dom: a single-sense word still shows its POS once', () => {
  const rows = renderRows('n.', '益处');
  assert.deepEqual(rows, [{ pos: 'n.', text: '益处' }]);
});

test('study card dom: a multi-token entry POS is preserved verbatim', () => {
  const rows = renderRows('n. adj.', '受影响的');
  assert.deepEqual(rows, [{ pos: 'n. adj.', text: '受影响的' }]);
});

test('study card dom: a word with no meaning still renders a usable line', () => {
  const rows = renderRows('v.', '');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pos, 'v.');
  assert.ok(/无释义/.test(rows[0].text), 'the empty case must explain itself');
});

test('study card dom: a meaning with no entry POS keeps its own marker', () => {
  const rows = renderRows('', '有益于 n. 益处');
  assert.equal(rows.length, 2, 'both senses must survive');
  assert.equal(rows[1].pos, 'n.');
  assert.equal(rows[1].text, '益处');
});
