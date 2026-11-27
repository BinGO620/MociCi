'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/bridge-harness');

/**
 * Persisted recorded audio with a budget.
 *
 * Two decisions are pinned here:
 *
 *  1. Clips live in the FILES dir, not the cache dir. Android purges the cache
 *     under storage pressure, so a word the user already "downloaded" would
 *     silently revert to the robotic system voice with no explanation.
 *  2. Persisting means something must bound the growth: imported books can be
 *     thousands of words, so a budget plus least-recently-used eviction keeps
 *     the feature from filling the device.
 *
 * Import warms only the next study group rather than the whole book, so the
 * first session is fully human-voiced without downloading words that may not be
 * studied for weeks.
 */

const R = p => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const APP = R('app/src/main/assets/app.js');
const HTTP = R('app/src/main/java/com/moci/cet6/HttpProxy.java');
const NB = R('app/src/main/java/com/moci/cet6/NativeBridge.java');

function javaMethod(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start > 0, 'missing method: ' + signature);
  let depth = 0;
  let i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(open, i + 1);
}

/* ------------------------------------------------------------- persistence */

test('audio: clips are stored in the files dir so they survive cache purges', () => {
  const ctor = javaMethod(HTTP, 'HttpProxy(android.content.Context ctx');
  assert.ok(/getFilesDir\(\)/.test(ctor), 'recorded audio must live in the files dir');
  assert.ok(!/getCacheDir\(\)/.test(ctor),
    'the cache dir can be purged by the system at any time');
});

test('audio: reads refresh the timestamp so eviction spares what is being heard', () => {
  const fn = javaMethod(HTTP, 'String cachedAudioPath(String key)');
  assert.ok(/setLastModified/.test(fn),
    'without this, eviction cannot tell a stale clip from a word still in rotation');
});

/* ------------------------------------------------------------------ budget */

test('audio: a budget bounds the persisted cache', () => {
  const fn = javaMethod(HTTP, 'long audioBudget()');
  assert.ok(/1024 \* 1024/.test(fn), 'the budget must be expressed in real units');
  assert.ok(/200L \* 1024 \* 1024/.test(fn), 'the ceiling must be explicit');
});

test('audio: the budget shrinks when the device is short on space', () => {
  const fn = javaMethod(HTTP, 'long audioBudget()');
  assert.ok(/getUsableSpace/.test(fn), 'free space must be considered');
  assert.ok(/free \/ 10/.test(fn), 'audio must never claim more than a slice of free space');
});

test('audio: eviction removes the least recently used clips first', () => {
  const fn = javaMethod(HTTP, 'void trimAudioCache(long budgetBytes)');
  assert.ok(/lastModified/.test(fn), 'the age signal must be the last-modified time');
  assert.ok(/sort/.test(fn), 'files must be ordered before deleting');
  assert.ok(/delete\(\)/.test(fn), 'eviction must actually delete');
  assert.ok(/<= budgetBytes/.test(fn), 'eviction must stop once inside the budget');
});

test('audio: the budget is enforced after every write', () => {
  const fn = javaMethod(HTTP, 'void fetchToFile(String url, String key, Callback cb)');
  assert.ok(/trimAudioCache\(audioBudget\(\)\)/.test(fn),
    'persisting without trimming would grow without bound');
});

test('audio: usage and a clear-out action are exposed to the UI', () => {
  assert.ok(/public String audioStats\(\)/.test(NB), 'settings needs a usage figure');
  assert.ok(/public String audioClear\(\)/.test(NB), 'the user must be able to reclaim the space');
  assert.equal(H.ARITY.audioStats, 0);
  assert.equal(H.ARITY.audioClear, 0);
});

test('audio: settings shows usage and the clear button', () => {
  const fn = jsFn(APP, 'audioStorageRow');
  assert.ok(/audioStats/.test(fn), 'the row must read real usage');
  assert.ok(/formatBytes/.test(fn), 'bytes must be human readable');
  assert.ok(/清除已缓存发音/.test(fn), 'a clear action must exist');
  assert.ok(/卸载才会清除/.test(fn), 'the user should know how long clips persist');
});

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

/* --------------------------------------------------------------- warming */

test('warm: an import warms the next study group', () => {
  const done = jsFn(APP, 'screenImportDone');
  assert.ok(/prefetchFirstStudyGroup/.test(done), 'the import flow must trigger warming');
  assert.ok(/setTimeout/.test(done), 'warming must not block the import screen');
});

test('warm: only the upcoming group is fetched, not the whole book', () => {
  const fn = jsFn(APP, 'prefetchFirstStudyGroup');
  assert.ok(/selectLearnGroup/.test(fn), 'it must reuse the same selection as study');
  assert.ok(/groupSize/.test(fn), 'the group size setting decides the scope');
  // Selecting a bounded group is what keeps an import of thousands of words
  // from turning into an unbounded download.
  assert.ok(!/loadBook\(\)\.words/.test(fn), 'it must not iterate every word in the book');
});

test('warm: warming is skipped when the system voice is selected', () => {
  const fn = jsFn(APP, 'prefetchFirstStudyGroup');
  assert.ok(/wantsHumanAudio\(\)/.test(fn),
    'no point downloading clips the user has opted out of');
});

test('warm: warming never lets an import fail', () => {
  const fn = jsFn(APP, 'prefetchFirstStudyGroup');
  assert.ok(/try \{/.test(fn) && /catch/.test(fn),
    'a network error during warming must not surface as an import failure');
});
