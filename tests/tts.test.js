'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * The Android TTS engine is not runnable in Node, so these tests pin the
 * contract that matters for the "instant playback" requirement: engine created
 * at startup, language/rate configured once, stop-before-speak, prefetch cache
 * naming and the accented default.
 */
const SRC = fs.readFileSync(path.resolve(__dirname, '../app/src/main/java/com/moci/cet6/TtsEngine.java'), 'utf8');
const ACT = fs.readFileSync(path.resolve(__dirname, '../app/src/main/java/com/moci/cet6/MainActivity.java'), 'utf8');
const APP = fs.readFileSync(path.resolve(__dirname, '../app/src/main/assets/app.js'), 'utf8');

test('tts: engine is constructed in the constructor (startup init)', () => {
  const ctor = SRC.slice(SRC.indexOf('TtsEngine(Context ctx'), SRC.indexOf('private Locale locale()'));
  assert.ok(/init\(\);/.test(ctor), 'constructor calls init()');
});

test('tts: language and rate set once inside onInit', () => {
  const init = SRC.slice(SRC.indexOf('private void init()'), SRC.indexOf('synchronized void setEngine'));
  assert.ok(init.includes('setLanguage(locale())'));
  assert.ok(init.includes('setSpeechRate(rate())'));
  assert.ok(init.includes('configured = true'));
});

test('tts: speak stops first, then re-asserts the locale', () => {
  const speak = SRC.slice(SRC.indexOf('synchronized boolean speak('));
  const body = speak.slice(0, speak.indexOf('synchronized void stop()'));
  // Re-asserting the locale each attempt is deliberate: a status cached at
  // onInit can be stale (voice pack installed later), and trusting it is what
  // made the app claim "no English voice" on a device that could speak.
  //
  // Stopping may run through the stop() wrapper (which also releases the
  // MediaPlayer used by the synthesize-then-play path), so both forms count.
  const stops = [body.indexOf('stop();'), body.indexOf('tts.stop()')].filter(i => i >= 0);
  const stopAt = stops.length ? Math.min.apply(null, stops) : -1;
  const langAt = body.indexOf('setLanguage(locale())');
  assert.ok(stopAt >= 0, 'speak stops the previous utterance');
  assert.ok(langAt >= 0, 'speak re-asserts the locale');
  assert.ok(stopAt < langAt, 'stop must come before re-configuring');
});

test('tts: a negative language probe does not hard-block speaking', () => {
  assert.ok(!SRC.includes('if (!canSpeakEnglish()) {'), 'canSpeakEnglish must not gate speak()');
  const gate = SRC.slice(SRC.indexOf('boolean canSpeakEnglish()'));
  assert.ok(gate.slice(0, 240).includes('return true'), 'a negative probe is not proof of failure');
});

test('tts: default accent is British', () => {
  assert.ok(SRC.includes('prefs.get("ttsAccent", "uk")'));
});

test('tts: en-GB maps to Locale.UK and en-US to Locale.US', () => {
  assert.ok(SRC.includes('"us".equals(accent) ? Locale.US : Locale.UK'));
});

test('tts: prefetch writes to the cache dir with a stable name', () => {
  assert.ok(SRC.includes('synthesizeToFile('));
  assert.ok(SRC.includes('cacheName(text)'));
  assert.ok(SRC.includes('new File(ctx.getCacheDir(), "tts")'));
});

test('tts: cached path is exposed for zero-latency playback', () => {
  assert.ok(SRC.includes('String cachedPath(String text)'));
  assert.ok(SRC.includes('f.exists() && f.length() > 0'));
});

test('tts: readiness requires both init success and one-time configuration', () => {
  assert.ok(SRC.includes('return ready && configured;'));
});

test('tts: shutdown clears the audio cache', () => {
  const sd = SRC.slice(SRC.indexOf('synchronized void shutdown()'));
  assert.ok(sd.includes('cacheDir.listFiles()'));
});

test('tts bridge: prefetch / cachedPath / isReady / setRate are exposed', () => {
  const NB = fs.readFileSync(path.resolve(__dirname, '../app/src/main/java/com/moci/cet6/NativeBridge.java'), 'utf8');
  ['ttsPrefetch', 'ttsCachedPath', 'ttsIsReady', 'ttsSetRate', 'ttsSetAccent'].forEach(function (m) {
    assert.ok(NB.includes(m), m + ' missing from NativeBridge');
  });
});

test('app: speak stops audio before playing (no stacked audio)', () => {
  const fn = APP.slice(APP.indexOf('function speak(text)'), APP.indexOf('function warmOnlineCache'));
  assert.ok(fn.includes('stopSpeaking()'));
});

test('app: a prefetched file is preferred over the engine', () => {
  const fn = APP.slice(APP.indexOf('function speak(text)'), APP.indexOf('function warmOnlineCache'));
  assert.ok(fn.indexOf('prefetchedFile(text)') < fn.indexOf('speakSystem(text)'));
});

test('app: online TTS never blocks (system voice speaks first)', () => {
  const fn = APP.slice(APP.indexOf('function warmOnlineCache'), APP.indexOf('function prefetchedFile'));
  assert.ok(!fn.includes('await '), 'cache warming must not await');
});

test('app: next question is prefetched after advancing', () => {
  assert.ok(APP.includes('prefetchWord('));
  assert.ok(APP.includes("s.mode = 'type'; // reuse the typed renderer"));
});

test('app: card flip fires audio before the re-render', () => {
  const idx = APP.indexOf('翻面看释义');
  const block = APP.slice(idx, idx + 420);
  assert.ok(block.indexOf('speak(card.en)') < block.indexOf('render()'), 'speak must precede render');
});
