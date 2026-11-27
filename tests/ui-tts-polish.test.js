'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * Three device complaints after 0.9.5, none of them about correctness:
 *
 *   1. Buttons gave no visible feedback — every control uses the same
 *      tap-highlight-suppressing rule and the pressed state only shifted
 *      brightness by 4%, so on white cards pressing looked like nothing
 *      happened and taps got repeated.
 *   2. Speech started ~2s after the tap — the study card never prefetched,
 *      so every press paid for a full synthesis.
 *   3. Speech sounded robotic — no voice was ever selected, so engines fell
 *      back to their lowest-quality default.
 */

const R = p => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const CSS = R('app/src/main/assets/style.css');
const APP = R('app/src/main/assets/app.js');
const TTS = R('app/src/main/java/com/moci/cet6/TtsEngine.java');

/** Balanced body of a top-level JS function. */
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

function rule(selector) {
  // Matches the first declaration block for an exact selector.
  const idx = CSS.indexOf(selector + '{');
  assert.ok(idx >= 0, 'missing CSS rule: ' + selector);
  const end = CSS.indexOf('}', idx);
  return CSS.slice(idx + selector.length + 1, end);
}

/* ------------------------------------------------- 1. touch feedback */

test('ui: buttons visibly darken and shrink while pressed', () => {
  const active = rule('.btn:active');
  const bright = /brightness\(([\d.]+)\)/.exec(active);
  assert.ok(bright, 'the pressed state must change brightness');
  assert.ok(Number(bright[1]) <= 0.85,
    'a 4% shift is invisible on white; pressed brightness must drop clearly, got ' + bright[1]);

  const scale = /scale\(([\d.]+)\)/.exec(active);
  assert.ok(scale, 'the pressed state must shrink');
  assert.ok(Number(scale[1]) <= 0.97, 'the shrink must be perceptible, got ' + scale[1]);

  assert.ok(/inset/.test(active), 'an inset shadow reads as "pushed in" even on white');
});

test('ui: ghost buttons gain a real background when pressed', () => {
  // A transparent button has nothing to darken, so brightness alone is a no-op.
  const active = rule('.btn.ghost:active');
  assert.ok(/background:var\(--line\)/.test(active),
    'a borderless/transparent button needs a fill change to look pressed');
});

test('ui: chips, tabs, speakers and rows all show a pressed state', () => {
  assert.ok(/\.chip:active\{/.test(CSS), 'chips must react to touch');
  assert.ok(/\.chip\.on:active\{/.test(CSS), 'a selected chip must react too');
  assert.ok(/\.tabs button:active\{/.test(CSS), 'tab buttons must react');
  assert.ok(/\.speak:active\{/.test(CSS), 'the speaker button must react');
  assert.ok(/\.rowcard:active\{/.test(CSS), 'tappable word rows must react');
});

test('ui: disabled buttons never animate as if pressed', () => {
  const d = rule('.btn:disabled:active');
  assert.ok(/transform:none/.test(d), 'a disabled button must not shrink');
  assert.ok(/filter:none/.test(d), 'a disabled button must not darken');
});

/* ------------------------------------------------- 2. speech latency */

test('tts latency: the study card prefetches before the user taps', () => {
  assert.ok(/prefetchStudyCards/.test(APP), 'a study-card prefetch helper must exist');

  const start = APP.indexOf('function startStudy');
  assert.ok(start > 0, 'startStudy must exist');
  const body = APP.slice(start, APP.indexOf('function ', start + 10));
  assert.ok(/prefetchStudyCards\(cards, 0\)/.test(body),
    'the first cards must be warmed when the session opens');
});

test('tts latency: moving between cards keeps the next words warm', () => {
  const next = APP.indexOf("text: s.index === total - 1 ? '进入听写' : '下一张'");
  assert.ok(next > 0, 'the next-card button must exist');
  const handler = APP.slice(next, next + 700);
  assert.ok(/prefetchStudyCards\(s\.cards, s\.index\)/.test(handler),
    'advancing must prefetch the cards now ahead of the user');
});

test('tts latency: prefetching covers several cards ahead plus collocations', () => {
  const body = jsFn(APP, 'prefetchStudyCards');
  assert.ok(/depth/.test(body) && /ahead/.test(body), 'the look-ahead depth must be configurable');
  assert.ok(/collo/.test(body), 'collocations get their own speaker buttons and must be warmed too');
  assert.ok(/splitPhrase/.test(body), 'collocations are spoken as their English part');
});

test('tts latency: prefetch protects against null cards and duplicates', () => {
  const body = jsFn(APP, 'prefetchStudyCards');
  assert.ok(/if \(!c\) continue/.test(body), 'a missing card must not break the loop');
  assert.ok(/!== c\.en/.test(body), 'a collocation identical to the word must not be queued twice');
});

/* ------------------------------------------------- 3. voice quality */

test('tts quality: a voice is actually selected instead of the engine default', () => {
  assert.ok(/getVoices\(\)/.test(TTS), 'the engine\'s voice list must be consulted');
  assert.ok(/setVoice\(/.test(TTS), 'the chosen voice must be applied');
  assert.ok(/pickBestVoice/.test(TTS), 'selection must be a named step');
});

test('tts quality: selection ranks by quality and matches the accent', () => {
  const start = TTS.indexOf('private void pickBestVoice');
  const body = TTS.slice(start, TTS.indexOf('void setAccent', start));
  assert.ok(/getQuality\(\)/.test(body), 'quality must drive the choice');
  assert.ok(/en_US/.test(body) && /en_GB/.test(body), 'both accents must be considered');
  assert.ok(/exact/.test(body), 'an exactly-matching accent must win over an approximate one');
});

test('tts quality: offline voices are preferred so playback stays instant', () => {
  const start = TTS.indexOf('private void pickBestVoice');
  const body = TTS.slice(start, TTS.indexOf('void setAccent', start));
  assert.ok(/isNetworkConnectionRequired/.test(body),
    'a network voice would trade latency back in');
});

test('tts quality: voice selection can never break speech', () => {
  const start = TTS.indexOf('private void pickBestVoice');
  const body = TTS.slice(start, TTS.indexOf('void setAccent', start));
  assert.ok(/catch \(Throwable/.test(body), 'selection is best-effort and must be swallowed');
  assert.ok(/Build\.VERSION\.SDK_INT < 21/.test(body), 'getVoices() requires API 21');
});

test('tts quality: the accent change re-picks the voice', () => {
  const start = TTS.indexOf('void setAccent');
  const body = TTS.slice(start, TTS.indexOf('String accent()', start));
  assert.ok(/pickBestVoice\(\)/.test(body),
    'each accent has its own best voice, so switching must re-select');
});

test('tts quality: the default rate is natural, not slowed down', () => {
  // 0.8 stretches every syllable and makes a synthesiser sound more mechanical.
  assert.ok(!/speechRate", "0\.8"/.test(TTS), 'the native default rate must not be 0.8');
  assert.ok(/speechRate", "1\.0"/.test(TTS), 'the native default rate should be 1.0');
  assert.ok(/return 1\.0f/.test(TTS), 'the rate fallback must match');
  assert.ok(!/speechRate: 0\.8/.test(APP), 'the UI default rate must match the native default');
});

test('tts quality: diagnostics expose the voice actually in use', () => {
  assert.ok(/o\.put\("voice"/.test(TTS), 'status must report the selected voice');
  assert.ok(/o\.put\("voiceCount"/.test(TTS), 'a low voice count explains poor audio');
  assert.ok(/当前音色/.test(APP), 'the diagnostics sheet must show it');
});
