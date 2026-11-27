'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/bridge-harness');

/**
 * Pronunciation rebuild: recorded human audio, fetched once and cached.
 *
 * The device's only speech engine is a basic formant synthesiser, so tuning it
 * could never make speech pleasant. Human audio turns quality into a solved
 * problem; caching keeps the app offline-capable after the first listen.
 *
 * Also covered: two stutter causes in the system-TTS fallback, and the
 * bridge's timer leak, which held a 130s timer per request.
 */

const R = p => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const APP = R('app/src/main/assets/app.js');
const BRIDGE = R('app/src/main/assets/android-bridge.js');
const HTTP = R('app/src/main/java/com/moci/cet6/HttpProxy.java');
const NB = R('app/src/main/java/com/moci/cet6/NativeBridge.java');
const TTS = R('app/src/main/java/com/moci/cet6/TtsEngine.java');
const CSS = R('app/src/main/assets/style.css');

/* ------------------------------------------------------- human audio source */

test('audio: human audio is the default source', () => {
  assert.ok(/voiceSource: 'human'/.test(APP), 'the state default must be human audio');
  assert.ok(/state\.settings\.voiceSource \|\| 'human'/.test(APP), 'the loaded default must match');
  assert.ok(/真人发音（默认）/.test(APP), 'the UI must label it as the default');
});

test('audio: the default provider is a recorded-audio service, accent aware', () => {
  const fn = /function audioSourceUrl[\s\S]*?\n  }/.exec(APP);
  assert.ok(fn, 'audioSourceUrl must exist');
  assert.ok(/dict\.youdao\.com\/dictvoice/.test(fn[0]), 'the verified provider must be wired in');
  assert.ok(/type=/.test(fn[0]), 'the provider distinguishes accents by a type parameter');
  assert.ok(/speechAccent === 'uk'/.test(fn[0]), 'the chosen accent must select the clip');
});

test('audio: a custom endpoint can override the built-in provider', () => {
  const fn = /function audioSourceUrl[\s\S]*?\n  }/.exec(APP)[0];
  assert.ok(/onlineTts/.test(fn), 'a user endpoint must take precedence');
  assert.ok(/\{text\}/.test(fn), 'the custom template keeps {text}');
  assert.ok(/\{accent\}/.test(fn), 'the custom template may use {accent}');
});

test('audio: the cache key includes the accent', () => {
  const fn = /function audioCacheKey[\s\S]*?\n  }/.exec(APP)[0];
  assert.ok(/speechAccent === 'uk' \? 'uk' : 'us'/.test(fn),
    'without the accent in the key, switching accent would replay the old clip');
});

/* ------------------------------------------------------- downloadable to disk */

test('audio: clips download straight to disk instead of crossing the bridge', () => {
  const fn = /void fetchToFile[\s\S]*?\n    }/.exec(HTTP);
  assert.ok(fn, 'fetchToFile must exist');
  assert.ok(/FileOutputStream/.test(fn[0]), 'the native side writes the file');
  assert.ok(/getAbsolutePath/.test(fn[0]), 'it reports a path, not a payload');
  assert.ok(!/Base64\.encodeToString/.test(fn[0]),
    'returning base64 would send the clip through JS twice');
});

test('audio: an empty response is a failure, never a cached clip', () => {
  const fn = /void fetchToFile[\s\S]*?\n    }/.exec(HTTP)[0];
  assert.ok(/bytes\.length == 0/.test(fn), 'a 200 with no body must be rejected');
  assert.ok(/音频为空/.test(fn), 'the rejection must say why');
});

test('audio: a download is written atomically', () => {
  const fn = /void fetchToFile[\s\S]*?\n    }/.exec(HTTP)[0];
  assert.ok(/\.tmp/.test(fn), 'write to a temp file first');
  assert.ok(/renameTo/.test(fn), 'then rename into place');
  assert.ok(/getFD\(\)\.sync\(\)/.test(fn), 'and fsync before renaming');
});

test('audio: the bridge exposes exactly the documented arities', () => {
  assert.equal(H.ARITY.audioFetch, 3);
  assert.equal(H.ARITY.audioCachedPath, 1);
  assert.ok(/public void audioFetch\(String url, String key, String callbackId\)/.test(NB));
  assert.ok(/public String audioCachedPath\(String key\)/.test(NB));
});

test('audio: playback uses file:// rather than a data URL', () => {
  const fn = /function prefetchedAudio[\s\S]*?\n  }/.exec(APP)[0];
  assert.ok(/audioCachedPath/.test(fn), 'the disk cache is consulted first');
  assert.ok(/'file:\/\//.test(fn), 'a hit plays from the file system');
  assert.ok(!/data:/.test(fn), 'no base64 data URL for human audio');
});

test('audio: a cache miss still speaks immediately', () => {
  const fn = /function speak\(text\)[\s\S]*?\n  }/.exec(APP)[0];
  const systemAt = fn.indexOf('speakSystem');
  assert.ok(systemAt > 0, 'the system voice must cover a miss');
  assert.ok(/warmAudioCache/.test(fn), 'and the clip is fetched in the background');
  assert.ok(systemAt < fn.indexOf('warmAudioCache'),
    'speaking must not wait for the download');
});

/* ------------------------------------------------- system TTS stutter causes */

test('tts: speak no longer reconfigures the engine on every utterance', () => {
  const fn = /synchronized boolean speak[\s\S]*?\n    }/.exec(TTS)[0];
  assert.ok(/localeApplied/.test(fn), 'the locale must be applied once, not every time');
  assert.ok(/if \(!localeApplied \|\| langStatus < 0\)/.test(fn),
    're-apply only when it was never applied or the engine reported a bad status');
});

test('tts: speak no longer stops the engine a second time', () => {
  const fn = /synchronized boolean speak[\s\S]*?\n    }/.exec(TTS)[0];
  // Strip comments first: the explanation of WHY the call was removed mentions
  // it, and a naive substring test would match its own documentation.
  const code = fn.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/tts\.stop\(\)/.test(code),
    'JS already stops before calling in; a second flush chops the attack');
  assert.ok(/QUEUE_FLUSH/.test(code), 'QUEUE_FLUSH still prevents overlapping audio');
});

test('tts: switching accent still re-applies the locale', () => {
  const fn = /void setAccent[\s\S]*?\n    }/.exec(TTS)[0];
  assert.ok(/setLanguage/.test(fn), 'a new accent needs its own language binding');
  assert.ok(/localeApplied = true/.test(fn), 'and must mark it applied');
});

/* ------------------------------------------------------------- bridge timers */

test('bridge: the per-request timeout is disarmed on completion', () => {
  const fn = /function wrap\(prefix, invoke\)[\s\S]*?\n  }/.exec(BRIDGE)[0];
  assert.ok(/clearTimeout/.test(fn), 'a finished request must not leave a timer armed');
  // The timer has to be armed before invoke(): native replies can arrive
  // synchronously, and a timer installed afterwards would never be cleared.
  const timerAt = fn.indexOf('setTimeout');
  const invokeAt = fn.indexOf('invoke(c.id)');
  assert.ok(timerAt >= 0 && invokeAt >= 0 && timerAt < invokeAt,
    'the timeout must be armed before invoking the native method');
  assert.ok(/settle/.test(fn), 'completion must go through one guarded path');
});

/* ------------------------------------------------------------- meaning rows */

test('ui: a single-sense word has no reserved POS gutter', () => {
  assert.ok(/\.study-card \.zh-rows\.single \.zh-pos\{[^}]*min-width:0/.test(CSS),
    'the spacer was the hole the user saw');
  assert.ok(/\.study-card \.zh-rows\.multi \.zh-pos\{[^}]*min-width:28px/.test(CSS),
    'multi-sense rows keep a narrowed gutter');
  const fn = /function appendMeaningBlock[\s\S]*?\n  }/.exec(APP)[0];
  assert.ok(/groups\.length > 1 \? 'multi' : 'single'/.test(fn),
    'the renderer must choose the class from the sense count');
});
