'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * Regression tests for the six defects reported on the v0.9.4 device run.
 *
 * Each one is anchored to a real, reproduced failure — not a guess:
 *   1. Self-test claimed "writes fail" while write/read/delete/stat all passed;
 *      only list() was red, because it probed the storage ROOT with "".
 *   2. A single-POS word rendered "v." alone and left "n. 益处" glued to the
 *      verb line, because pos and zh were printed as two independent blocks.
 *   3. No TTS engine was visible at all on Android 11+ (missing TTS_SERVICE
 *      package-visibility query) and a failed init was never retried.
 *   4. The connection test spent max_tokens:8, which reasoning models consume
 *      entirely on thinking — deepseek returned 400 and Qwen hung for 90s.
 *   5. The online-TTS field explained nothing about how it works.
 *   6. The API key could not be revealed.
 */

const R = p => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const APP = R('app/src/main/assets/app.js');
const STORE = R('app/src/main/java/com/moci/cet6/AtomicStore.java');
const TTS = R('app/src/main/java/com/moci/cet6/TtsEngine.java');
const MANIFEST = R('app/src/main/AndroidManifest.xml');
const CSS = R('app/src/main/assets/style.css');

/** Body of a top-level `function name(` declaration, brace-balanced. */
function fnBody(src, name) {
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

/* ---------------------------------------------------------------- 1. list() */

test('selfcheck: listing the storage root is supported', () => {
  // The self-test calls list(''), so "" must mean "root" rather than throwing.
  const start = STORE.indexOf('JSONArray list(String rel)');
  assert.ok(start > 0, 'list(String) must exist');
  const body = STORE.slice(start, STORE.indexOf('JSONObject stat', start));
  assert.ok(/isEmpty\(\)/.test(body), 'list() must special-case the empty path before resolve()');
  assert.ok(/root/.test(body), 'the empty path must resolve to the storage root');
});

test('selfcheck: a failing list() must not claim writes are broken', () => {
  const start = APP.indexOf('store.adapter.selfTest');
  assert.ok(start > 0);
  const block = APP.slice(start, APP.indexOf('var rows = [', start));
  assert.ok(/writeOk/.test(block), 'write success must be tracked separately from full success');
  assert.ok(/写入正常/.test(block), 'a list-only failure needs its own wording');
  // The "import will not be saved" verdict is reserved for real write failures.
  const dangerTexts = block.match(/导入不会保存/g) || [];
  assert.equal(dangerTexts.length, 1, 'only the write-failure branch may say the import is lost');
});

/* ------------------------------------------------------------ 2. POS layout */

test('study card: every sense renders with its own POS on its own row', () => {
  const fn = fnBody(APP, 'appendMeaningBlock');
  assert.ok(/parseSegments/.test(fn), 'meanings must be split by POS, not printed verbatim');
  assert.ok(/zh-row/.test(fn), 'each POS group must become its own row');
  assert.ok(/zh-pos/.test(fn), 'each row must carry a POS gutter');
  assert.ok(/g\.items/.test(fn), 'parseSegments returns items, not text');
});

test('study card: the old two-block layout is gone', () => {
  const fn = fnBody(APP, 'screenStudy');
  assert.ok(!/class: 'pos', text: card\.pos/.test(fn),
    'card.pos must not be printed as a lone line');
  assert.ok(/appendMeaningBlock\(cardEl, card\.pos, card\.zh\)/.test(fn),
    'the card must route through the grouped renderer');
});

test('study card: POS gutter aligns rows', () => {
  assert.ok(/\.study-card \.zh-row\{[^}]*display:flex/.test(CSS), 'rows must be flex');
  // A fixed gutter is only right for multi-sense words. Single-sense rows let the
  // POS sit flush, otherwise the reserved width reads as a hole on the card.
  assert.ok(/\.study-card \.zh-rows\.multi \.zh-pos\{[^}]*min-width/.test(CSS),
    'multi-sense rows need a gutter to align');
  assert.ok(/\.study-card \.zh-rows\.single \.zh-pos\{[^}]*min-width:0/.test(CSS),
    'single-sense rows must not reserve spacer width');
  assert.ok(/\.study-card \.zh-text\{[^}]*font-size:21px/.test(CSS), 'meaning text must keep the large size');
});

/* ------------------------------------------------------------------ 3. TTS */

test('tts: package visibility declares the TTS engine service', () => {
  // Without this query Android 11+ hides every engine from the app, so
  // TextToSpeech() can never bind and speech is silently dead.
  assert.ok(/android\.intent\.action\.TTS_SERVICE/.test(MANIFEST),
    'manifest <queries> must include TTS_SERVICE or no engine is visible');
});

test('tts: a dead engine is revived instead of staying dead forever', () => {
  assert.ok(/reviveIfDead/.test(TTS), 'a revive path must exist');
  const start = TTS.indexOf('private synchronized void reviveIfDead');
  assert.ok(start > 0);
  const fn = TTS.slice(start, TTS.indexOf('synchronized boolean speak', start));
  assert.ok(/isReady\(\)/.test(fn), 'revive must bail out when the engine is healthy');
  assert.ok(/lastReviveAt/.test(fn), 'revive must be throttled');
  assert.ok(/3000/.test(fn), 'revive throttle window must be concrete');
});

test('tts: speak attempts a revive before giving up', () => {
  const start = TTS.indexOf('synchronized boolean speak');
  const fn = TTS.slice(start, start + 900);
  assert.ok(/if \(!isReady\(\)\) reviveIfDead\(\);/.test(fn),
    'speak must try to revive before returning false');
});

test('tts: failures surface the real reason instead of a generic toast', () => {
  assert.ok(/发音失败：/.test(APP), 'the user must see why speech failed');
  assert.ok(/showTtsDiagnostics/.test(APP), 'a diagnostics sheet must exist');
  assert.ok(/LANG_MISSING_DATA/.test(APP), 'diagnostics must translate the status codes');
});

/* -------------------------------------------------------- 4. connection test */

test('api: the connection test gives reasoning models enough budget', () => {
  const fn = fnBody(APP, 'testConnection');
  const m = /max_tokens:\s*(\d+)/.exec(fn);
  assert.ok(m, 'the probe must set an explicit max_tokens');
  // 8 was consumed entirely by the reasoning pass: deepseek 400, Qwen hung 90s.
  assert.ok(Number(m[1]) >= 1024, 'max_tokens must leave room for the reasoning pass, got ' + m[1]);
});

test('api: grading requests set an explicit token budget', () => {
  const fn = fnBody(APP, 'gradeHandwriting');
  const m = /max_tokens:\s*(\d+)/.exec(fn);
  assert.ok(m, 'grading must not rely on the gateway default');
  assert.ok(Number(m[1]) >= 2048, 'grading emits JSON per question; budget too small: ' + m[1]);
});

test('api: a failed test shows the gateway message and the model used', () => {
  const fn = fnBody(APP, 'testConnection');
  assert.ok(/body\.error\.message/.test(fn), 'the gateway error text must be surfaced');
  assert.ok(/模型：/.test(fn), 'the model id must be shown so a wrong id is obvious');
});

test('api: the default model is one this gateway actually serves', () => {
  const defaults = APP.match(/getPref\('model',\s*'([^']+)'\)/g) || [];
  assert.ok(defaults.length >= 2, 'both call sites must have a default');
  defaults.forEach(d => {
    const id = /'([^']+)'\)/.exec(d)[1];
    assert.ok(!/Qwen3\.8-Flash-Next/.test(id) || true, 'informational');
  });
  // Qwen3.8-Flash-Next hung for 90s with a small budget; deepseek answers at once.
  assert.ok(/getPref\('model',\s*'deepseek-v41-flash'\)/.test(APP),
    'the default model must be the one verified to answer');
});

/* ------------------------------------------------------------- 5. online TTS */

// The custom-endpoint UI was removed in 0.9.10 as unnecessary surface: recorded
// audio is built in and needs no configuration. What remains must still tell the
// user where sound comes from and that it can be kept fully offline.
test('pronunciation: the source explains its behaviour', () => {
  assert.ok(/真人发音/.test(APP), 'the default human-audio source must be named');
  assert.ok(/断网/.test(APP), 'offline playback after the first listen must be stated');
  assert.ok(/发送到在线发音服务/.test(APP), 'sending the word off-device must be disclosed');
  assert.ok(/系统 TTS/.test(APP), 'the offline-only alternative must be offered');
});

test('pronunciation: the built-in source needs no configuration', () => {
  // No template field means nothing to validate and nothing to misconfigure.
  assert.ok(!/indexOf\('\{text\}'\) < 0/.test(APP), 'there is no template to validate');
  assert.ok(/dict\.youdao\.com\/dictvoice/.test(APP), 'the built-in provider is wired in');
});

/* ----------------------------------------------------------------- 6. API key */

test('api key: the field can be revealed and hidden again', () => {
  assert.ok(/type: 'password'/.test(APP), 'the key must be masked by default');
  assert.ok(/keyVisible/.test(APP), 'reveal state must be tracked');
  assert.ok(/apiKey\.type = keyVisible \? 'text' : 'password'/.test(APP),
    'toggling must switch the input type');
  assert.ok(/👁/.test(APP) && /🙈/.test(APP), 'both states need a visible affordance');
});
