'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * Dictation gave away answers and was cluttered:
 *   - the phonetic transcription was printed, which is a spelling hint;
 *   - a phrase question printed its owning word ("所属：affect"), and that word
 *     is a literal component of the answer ("affect health").
 * What should remain: the Chinese prompt and a speaker. Nothing else.
 *
 * The user also asked for dictation to simply speak the thing being tested, and
 * for US pronunciation to be the default.
 */

const R = p => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const APP = R('app/src/main/assets/app.js');
const TTS = R('app/src/main/java/com/moci/cet6/TtsEngine.java');

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

/* --------------------------------------------- hints removed from dictation */

test('dictation: the phonetic transcription is not shown', () => {
  const body = jsFn(APP, 'renderDictateType');
  assert.ok(!/q\.phonetic/.test(body),
    'printing the phonetic spelling hands over the letters being tested');
  assert.ok(!/'\/' \+ /.test(body), 'no slashed phonetic display either');
});

test('dictation: a phrase question does not reveal its owning word', () => {
  const body = jsFn(APP, 'renderDictateType');
  assert.ok(!/q\.owner/.test(body),
    'the owner is a literal part of the answer, so showing it gives the answer away');
  assert.ok(!/所属/.test(body), 'the "所属" line must be gone');
});

test('dictation: only the Chinese prompt and a speaker remain', () => {
  const body = jsFn(APP, 'renderDictateType');
  assert.ok(/q\.prompt/.test(body), 'the Chinese meaning is the question');
  assert.ok(/听发音/.test(body), 'a speaker must remain');
  assert.ok(/speak\(q\.answer\)/.test(body), 'the speaker plays the answer being tested');
});

test('dictation: the no-meaning warning survives (it is not a hint)', () => {
  const body = jsFn(APP, 'renderDictateType');
  assert.ok(/noMeaning/.test(body),
    'a word with no meaning must still say it is spelling-only');
});

/* --------------------------------------------------- dictation speaks itself */

test('dictation: each question is spoken automatically when shown', () => {
  const body = jsFn(APP, 'renderDictateType');
  assert.ok(/state\.autoSpeak/.test(body), 'auto-speak must gate it');
  assert.ok(/speak\(speakText\)/.test(body), 'the answer must be spoken');
  assert.ok(/q\.answer/.test(body), 'it speaks exactly what must be written');
});

test('dictation: re-rendering the same question does not repeat audio', () => {
  const body = jsFn(APP, 'renderDictateType');
  assert.ok(/dictationSpoken/.test(body), 'a once-per-question guard must exist');
  assert.ok(/state\.dictationSpoken !==/.test(body), 'the guard must compare the current question');
});

// The entry button now renders an SVG icon alongside its label, so the anchor is
// the label text. The label comes AFTER the handler body, so the slice must look
// backwards from the label to find the handler.
test('dictation: a fresh round speaks the first question again', () => {
  const at = APP.indexOf("'键入听写'");
  assert.ok(at > 0, 'the typed-dictation entry point must exist');
  const handler = APP.slice(Math.max(0, at - 500), at);
  assert.ok(/state\.dictationSpoken = null/.test(handler),
    'starting a new round must reset the guard, or question 1 stays silent');
});

test('dictation: answers are prefetched so auto-speech is not delayed', () => {
  const body = jsFn(APP, 'prefetchDictation');
  assert.ok(/q\.answer/.test(body), 'prefetch must warm the answer');
  assert.ok(/ahead|depth/.test(body), 'it must look ahead, not just the current item');
  assert.ok(/prefetchDictation/.test(APP), 'the helper must be wired up');
  // Entering dictation and advancing both warm the queue.
  const at = APP.indexOf("'键入听写'");
  assert.ok(/prefetchDictation/.test(APP.slice(Math.max(0, at - 500), at)),
    'entering dictation must prefetch');
  const next = APP.indexOf("'下一题'");
  assert.ok(next > 0, 'the next-question button must exist');
  assert.ok(/prefetchDictation/.test(APP.slice(next, next + 500)),
    'advancing must keep the queue warm');
});

/* ------------------------------------------------- US accent by default */

test('accent: US English is the default everywhere', () => {
  assert.ok(/speechAccent: 'us'/.test(APP), 'the UI state default must be US');
  assert.ok(/getPref\('ttsAccent', 'us'\)/.test(APP), 'the settings default must be US');
  assert.ok(/prefs\.get\("ttsAccent", "us"\)/.test(TTS), 'the native default must be US');
});

test('accent: an unset or unknown value falls back to US, not UK', () => {
  assert.ok(/ttsAccent === 'uk' \? 'uk' : 'us'/.test(APP),
    'only an explicit uk selection may produce UK; anything else is US');
});

test('accent: the default is labelled as the default in the UI', () => {
  assert.ok(/美音 en-US（默认）/.test(APP), 'the US chip must be marked as the default');
  assert.ok(!/英音 en-GB（默认）/.test(APP), 'the UK chip must not claim to be the default');
});

test('accent: US is listed first so the default reads first', () => {
  const us = APP.indexOf('美音 en-US（默认）');
  const uk = APP.indexOf('英音 en-GB');
  assert.ok(us > 0 && uk > 0);
  assert.ok(us < uk, 'the default option should be presented first');
});
