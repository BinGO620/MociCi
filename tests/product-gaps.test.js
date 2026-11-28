'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/bridge-harness');

/**
 * Three product gaps identified by reviewing the app from four viewpoints
 * (PM / front-end / back-end / customer). All three were about the experience
 * being broken, not about code quality:
 *
 *  1. A first-run user opened an empty app with no obvious next step.
 *  2. Killing the app mid-round lost the whole round.
 *  3. A wordbook over 300 entries was silently incomplete.
 */

const R = p => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const APP = R('app/src/main/assets/app.js');
const STORE = R('app/src/main/assets/js/store.js');

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

/* ------------------------------------------------------------- resumable */

test('session: an interrupted round is persisted to its own file', () => {
  assert.ok(/var SESSION = 'session\.json'/.test(STORE), 'the round needs its own file');
  assert.ok(/Store\.prototype\.saveSession/.test(STORE));
  assert.ok(/Store\.prototype\.loadSession/.test(STORE));
  assert.ok(/Store\.prototype\.clearSession/.test(STORE));
});

test('session: only word keys are stored, never a copy of the wordbook', () => {
  const fn = jsFn(APP, 'persistSession');
  assert.ok(/c\.key/.test(fn), 'cards are reduced to their keys');
  // A frozen snapshot would go stale the moment a word is edited.
  assert.ok(!/zh:\s*c\.zh/.test(fn), 'meanings must be re-read from the wordbook on resume');
});

test('session: every position change is saved before the re-render', () => {
  // Flip, prev, next, judge, and next-question each move the user forward; a
  // crash right after any of them must not repeat that step.
  const calls = APP.match(/persistSession\(\);/g) || [];
  assert.ok(calls.length >= 5, 'expected a save at each step, found ' + calls.length);
  // Saving after render() would leave a window where the UI advanced but disk
  // did not.
  const flip = APP.indexOf('s.flipped = true;');
  const afterFlip = APP.slice(flip, flip + 200);
  assert.ok(afterFlip.indexOf('persistSession') < afterFlip.indexOf('render()'),
    'the save must happen before the re-render');
});

test('session: an explicitly finished round is not offered again', () => {
  const fn = jsFn(APP, 'abortSession');
  assert.ok(/store\.clearSession\(\)/.test(fn), 'ending a round on purpose must clear it');
});

test('session: a settled round is also cleared, not just an abandoned one', () => {
  // Regression caught while reviewing this feature: finishing a round left the
  // saved copy on disk, so home kept offering to "continue" a completed round.
  const fn = jsFn(APP, 'applySessionResults');
  assert.ok(/store\.clearSession\(\)/.test(fn),
    'settling a round must delete the saved copy');
});

test('session: a round older than a day is discarded', () => {
  const fn = /Store\.prototype\.loadSession[\s\S]*?\n  \};/.exec(STORE)[0];
  assert.ok(/24 \* 60 \* 60 \* 1000/.test(fn), 'a stale round would show cards no longer due');
  assert.ok(/clearSession/.test(fn), 'an expired round must be removed, not left to linger');
});

test('session: resuming rebuilds cards against the current wordbook', () => {
  const fn = jsFn(APP, 'resumeBanner');
  assert.ok(/words\[k\]/.test(fn), 'keys are resolved against the live wordbook');
  assert.ok(/filter\(Boolean\)/.test(fn), 'deleted words must not resurrect');
  assert.ok(/clearSession/.test(fn), 'a round whose words are all gone is dropped');
});

test('session: the home screen offers to continue', () => {
  const fn = jsFn(APP, 'renderHome');
  assert.ok(/resumeBanner/.test(fn), 'the offer must be visible where the user lands');
  const banner = jsFn(APP, 'resumeBanner');
  assert.ok(/继续/.test(banner), 'there must be a continue action');
  assert.ok(/放弃/.test(banner), 'and a way to decline');
});

/* ---------------------------------------------------------------- first run */

test('first run: the empty screen names the next action plainly', () => {
  const fn = jsFn(APP, 'renderHome');
  assert.ok(/先放入你的第一个词表/.test(fn), 'the heading must state the goal');
  assert.ok(/粘贴词表导入/.test(fn), 'the primary action must say what it does');
  assert.ok(/不知道怎么准备词表/.test(fn), 'a confused user needs an escape hatch');
});

test('first run: no sample wordbook is bundled', () => {
  // The product promise is a factory-empty book; shipping a demo list would
  // quietly break it.
  const fn = jsFn(APP, 'renderHome');
  assert.ok(!/示例词表|demoWords|sampleBook/.test(fn), 'no built-in list may appear');
  assert.ok(/不内置词库/.test(fn), 'and the reason should be stated');
});

test('first run: copying the prompt leads straight to the paste box', () => {
  const fn = jsFn(APP, 'showTemplate');
  assert.ok(/navigate\('import'\)/.test(fn),
    'after copying, the next step is pasting — do not make the user hunt for it');
});

/* ------------------------------------------------------- complete word list */

test('wordbook: the list is no longer cut off at 300', () => {
  assert.ok(!/list\.slice\(0, 300\)/.test(APP), 'a hard cut hides the tail of the book');
  assert.ok(/BOOK_PAGE/.test(APP), 'paging must be explicit');
  const fn = jsFn(APP, 'renderBook');
  assert.ok(/显示全部/.test(fn) || /再显示/.test(fn), 'large books need a way through');
});

test('wordbook: a new filter or query restarts paging', () => {
  const fn = jsFn(APP, 'renderBook');
  const matches = fn.match(/state\.bookShown = 0/g) || [];
  assert.ok(matches.length >= 2, 'both the query and the filter must reset the page');
});

test('wordbook: every entry is eventually reachable', () => {
  const fn = jsFn(APP, 'renderBook');
  assert.ok(/list\.length/.test(fn), 'the total count drives the remaining pages');
  assert.ok(/state\.bookShown = list\.length/.test(fn),
    'a "show all" path must exist so nothing is unreachable');
});

/* ------------------------------------------------------------ store wiring */

test('session store: round-trips through the same adapter as the wordbook', () => {
  const sim = H.createBridge();
  const Moci = H.loadModules(sim.bridge);
  const store = Moci.store.create(Moci.storage.pick(), {});
  const saved = store.saveSession({ kind: 'study', scope: 'all', cards: ['abandon'], index: 3, flipped: true });
  assert.equal(saved.ok, true, 'saving must succeed against the native adapter');
  const back = store.loadSession();
  assert.ok(back, 'the round must come back');
  assert.deepEqual(back.cards, ['abandon']);
  assert.equal(back.index, 3);
  assert.equal(back.flipped, true);
  store.clearSession();
  assert.equal(store.loadSession(), null, 'clearing must leave nothing behind');
});
