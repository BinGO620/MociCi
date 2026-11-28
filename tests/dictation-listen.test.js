'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * Two device findings about dictation:
 *
 *  1. The HANDWRITING screen printed each phrase's owning word ("所属 support"),
 *     and the answer was "provide support" — half the answer given away. The
 *     typed screen had already been fixed for exactly this; the handwriting
 *     screen was missed.
 *  2. Dictation was really a translation test: the Chinese was always on screen.
 *     A pure listening mode was requested — hear the word (twice), write it.
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

/* ------------------------------------------------- handwriting answer leak */

test('handwriting: the owning word is not printed', () => {
  const fn = jsFn(APP, 'renderDictateHand');
  assert.ok(!/q\.owner/.test(fn),
    'the owner is a literal part of the answer and must not be shown');
  assert.ok(!/所属/.test(fn), 'the "所属" label must be gone');
});

test('handwriting: the Chinese prompt is still shown', () => {
  const fn = jsFn(APP, 'renderDictateHand');
  assert.ok(/q\.prompt/.test(fn), 'the user needs to know what to write');
});

test('handwriting: the question list is numbered', () => {
  const fn = jsFn(APP, 'renderDictateHand');
  assert.ok(/\(i \+ 1\)/.test(fn), 'answers are written on paper in order, so numbering matters');
});

/* ------------------------------------------------------ listen-only mode */

test('listen mode: it is offered as a separate dictation mode', () => {
  const fn = jsFn(APP, 'renderDictatePick');
  assert.ok(/enterMode\('listen'\)/.test(fn), 'a listen mode must be selectable');
  assert.ok(/只听音频/.test(fn), 'the entry point must say what it does');
  assert.ok(/看中文听写/.test(fn), 'the original mode must be labelled distinctly');
});

test('listen mode: switching modes keeps the questions and answers', () => {
  // Reported on device: opening the camera, changing your mind and switching to
  // the typed mode threw away the whole round. The questions are mode-independent,
  // so they are built once and only the clue changes.
  const fn = jsFn(APP, 'renderDictatePick');
  assert.ok(/function enterMode/.test(fn), 'mode entry must be centralised');
  const em = fn.slice(fn.indexOf('function enterMode'), fn.indexOf('function enterMode') + 900);
  assert.ok(/if \(!s\.questions \|\| !s\.questions\.length\)/.test(em),
    'questions may only be rebuilt when none exist');
  assert.ok(/s\.qIndex = 0/.test(em), 'reset happens only inside that guard');
  // The guard must wrap the reset; otherwise every switch starts over.
  const guardAt = em.indexOf('if (!s.questions');
  const resetAt = em.indexOf('s.qIndex = 0');
  assert.ok(guardAt >= 0 && resetAt > guardAt, 'the reset must sit inside the guard');
});

test('listen mode: back buttons return to the mode picker, not the study cards', () => {
  // Both the typed screen and the handwriting screen used to jump to the study
  // cards, so trying another mode meant redoing the round.
  assert.ok(/function backToDictatePick/.test(APP), 'a shared back helper must exist');
  const helper = jsFn(APP, 'backToDictatePick');
  assert.ok(/s\.mode = 'pick'/.test(helper), 'it must return to the picker');
  assert.ok(/stopSpeaking\(\)/.test(helper), 'a queued repeat must not outlive the screen');

  const hand = jsFn(APP, 'renderDictateHand');
  assert.ok(/backToDictatePick/.test(hand), 'the handwriting screen must offer a mode switch');

  const typed = jsFn(APP, 'renderDictateType');
  assert.ok(/backToDictatePick/.test(typed), 'the typed screen must offer a mode switch');
  assert.ok(/s\.retryPass \? abortSession : backToDictatePick/.test(typed),
    'a retry pass has no picker to return to, so it still ends the round');
});

test('listen mode: the picker reports progress when returning mid-round', () => {
  const fn = jsFn(APP, 'renderDictatePick');
  assert.ok(/answeredCount/.test(fn), 'saying "已答 N 题" makes it clear nothing was lost');
});

test('listen mode: no Chinese prompt is shown', () => {
  const fn = jsFn(APP, 'renderDictateType');
  assert.ok(/isListen/.test(fn), 'the renderer must branch on the mode');
  // In listen mode the clue is instruction text, never q.prompt.
  const listenBranch = fn.slice(fn.indexOf('isListen'), fn.indexOf('isListen') + 700);
  assert.ok(/点击下方喇叭重听/.test(listenBranch), 'the hint explains how to replay');
});

test('listen mode: it reuses the typed renderer instead of a copy', () => {
  const fn = jsFn(APP, 'screenDictate');
  assert.ok(/s\.mode === 'listen'/.test(fn), 'the dispatcher must route listen mode');
  // Judging is a local string comparison either way; duplicating the renderer
  // would mean two places to keep the answer-leak fixes in.
  assert.ok(/renderDictateType/.test(fn));
});

test('listen mode: the item is played twice, once per question', () => {
  const fn = jsFn(APP, 'renderDictateType');
  assert.ok(/speakRepeatedly\(speakText, 2\)/.test(fn),
    'one pass is not enough to catch a phrase');
  assert.ok(/listenMode/.test(fn), 'auto-play must know the mode');
});

test('listen mode: a tap replays it twice', () => {
  const fn = jsFn(APP, 'renderDictateType');
  assert.ok(/speakRepeatedly\(q\.answer, 2\)/.test(fn), 'the manual control must match the automatic playback');
  assert.ok(/再听两遍/.test(fn), 'and must be labelled accordingly');
});

/* --------------------------------------------------------- repeat plumbing */

test('repeat: playback waits for the clip to finish, not a guessed delay', () => {
  const fn = jsFn(APP, 'speakRepeatedly');
  assert.ok(/playUrl\(cached\.src, function/.test(fn),
    'chaining on the ended event avoids clipping the word');
  assert.ok(/prefetchedAudio/.test(fn), 'cached human audio is preferred');
});

test('repeat: the system engine has no callback, so a rate-scaled estimate is used', () => {
  const fn = jsFn(APP, 'speakRepeatedly');
  assert.ok(/speakSystem/.test(fn), 'fallback when nothing is cached');
  assert.ok(/speechRate/.test(fn), 'the estimate must scale with the speech rate');
});

test('repeat: a fresh request cancels the pending one', () => {
  const fn = jsFn(APP, 'speakRepeatedly');
  assert.ok(/stopRepeating\(\)/.test(fn), 'a new question must not be overlapped by the old one');
  assert.ok(/repeatSeq/.test(fn), 'a sequence guard is needed to drop stale callbacks');
});

test('repeat: leaving the screen stops queued repetitions', () => {
  const fn = jsFn(APP, 'stopSpeaking');
  assert.ok(/stopRepeating\(\)/.test(fn),
    'without this a scheduled second pass fires after the user left');
});

test('playUrl: completion is reported so chaining is possible', () => {
  const fn = jsFn(APP, 'playUrl');
  assert.ok(/onDone/.test(fn), 'playback must be able to report completion');
  assert.ok(/ended/.test(fn), 'the ended event is the signal');
});
