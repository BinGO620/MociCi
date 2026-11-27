package com.moci.cet6;

import android.content.Context;
import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * System TTS wrapper tuned for instant playback.
 *
 * Startup cost is the dominant latency source on many ROMs, so the engine is
 * created in Activity.onCreate and language/rate are configured exactly once in
 * onInit. Every speak() stops the previous utterance first (no overlapping audio
 * when flipping cards fast), and prefetch() synthesises the next word to a cache
 * file so the following tap can play from disk.
 *
 * Default accent is en-GB (CET-6 listening is British-leaning); en-US is kept as
 * an alternative.
 */
final class TtsEngine {
    private final Context ctx;
    private final Prefs prefs;
    private final File cacheDir;
    private TextToSpeech tts;
    private volatile boolean ready;
    private volatile String engineName;
    private volatile int langStatus = TextToSpeech.LANG_NOT_SUPPORTED;
    private volatile String lastError;
    private volatile String accent;
    private volatile boolean configured;
    private volatile String voiceName;
    private long uttSeq;

    TtsEngine(Context ctx, Prefs prefs) {
        this.ctx = ctx.getApplicationContext();
        this.prefs = prefs;
        this.engineName = prefs.get("ttsEngine", null);
        this.accent = prefs.get("ttsAccent", "us");
        this.cacheDir = new File(ctx.getCacheDir(), "tts");
        init();
    }

    private Locale locale() {
        return "us".equals(accent) ? Locale.US : Locale.UK;
    }

    /**
     * Chooses the best-sounding English voice the engine actually ships.
     *
     * Previously no voice was selected at all, so every engine fell back to its
     * default — on most ROMs the smallest, fastest and most robotic formant
     * voice. That default is what made speech sound mechanical. Engines publish
     * several English voices ranked by Voice.QUALITY_*, so pick the highest
     * quality one for the current accent.
     *
     * Never throws: an engine with no voices (or no getVoices()) simply keeps
     * its default rather than losing speech entirely.
     */
    private void pickBestVoice() {
        try {
            if (tts == null) return;
            if (Build.VERSION.SDK_INT < 21) return; // getVoices() needs API 21+
            java.util.Set<android.speech.tts.Voice> voices;
            try {
                voices = tts.getVoices();
            } catch (Throwable t) {
                return;
            }
            if (voices == null || voices.isEmpty()) return;

            String want = "us".equals(accent) ? "en_US" : "en_GB";
            android.speech.tts.Voice best = null;
            int bestScore = Integer.MIN_VALUE;
            for (android.speech.tts.Voice v : voices) {
                if (v == null || v.getLocale() == null) continue;
                if (!"en".equalsIgnoreCase(v.getLocale().getLanguage())) continue;

                boolean exact = want.equalsIgnoreCase(v.getLocale().toString());
                // Quality dominates — that is the whole point of selecting.
                int score = v.getQuality() * 100;
                if (exact) score += 300;                 // right accent beats a better wrong one
                if (!v.isNetworkConnectionRequired()) score += 40; // offline + instant
                String n = v.getName() == null ? "" : v.getName().toLowerCase();
                if (n.contains("local") || n.contains("embedded")) score += 10;
                if (n.contains("network")) score -= 10;

                if (score > bestScore) { bestScore = score; best = v; }
            }
            if (best != null) {
                int r = tts.setVoice(best);
                if (r == TextToSpeech.SUCCESS) voiceName = best.getName();
                else lastError = "setVoice failed (" + r + ")";
            }
        } catch (Throwable t) {
            lastError = t.getMessage(); // voice choice is an optimisation, never fatal
        }
    }

    void setAccent(String value) {
        String next = "us".equals(value) ? "us" : "uk";
        if (next.equals(accent) && configured) return;
        accent = next;
        prefs.set("ttsAccent", accent);
        // A language change is the one case that must re-touch the engine:
        // the best-quality voice differs per accent.
        if (tts != null) {
            try {
                langStatus = tts.setLanguage(locale());
                pickBestVoice();
                tts.setSpeechRate(rate());
            } catch (Throwable t) {
                lastError = t.getMessage();
            }
        }
    }

    String accent() {
        return accent;
    }

    private float rate() {
        try {
            float r = Float.parseFloat(prefs.get("speechRate", "1.0"));
            return clampRate(r);
        } catch (Throwable t) {
            return 1.0f;
        }
    }

    private void init() {
        ready = false;
        configured = false;
        langStatus = TextToSpeech.LANG_NOT_SUPPORTED;
        lastError = null;
        voiceName = null;
        try {
            TextToSpeech.OnInitListener listener = status -> {
                if (status == TextToSpeech.SUCCESS) {
                    ready = true;
                    try {
                        // One-time configuration: language + voice + rate + pitch.
                        langStatus = tts.setLanguage(locale());
                        pickBestVoice();
                        tts.setSpeechRate(rate());
                        tts.setPitch(1.0f);
                        configured = true;
                    } catch (Throwable t) {
                        lastError = t.getMessage();
                    }
                } else {
                    ready = false;
                    lastError = "init failed (" + status + ")";
                }
            };
            if (engineName != null && !engineName.isEmpty()) {
                tts = new TextToSpeech(ctx, listener, engineName);
            } else {
                tts = new TextToSpeech(ctx, listener);
            }
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) { }
                @Override public void onDone(String utteranceId) { }
                @Override public void onError(String utteranceId) { }
            });
        } catch (Throwable t) {
            ready = false;
            lastError = t.getMessage();
        }
    }

    synchronized void setEngine(String pkg) {
        engineName = (pkg == null || pkg.isEmpty()) ? null : pkg;
        prefs.set("ttsEngine", engineName);
        if (tts != null) {
            try { tts.stop(); tts.shutdown(); } catch (Throwable ignored) { }
            tts = null;
        }
        init();
    }

    boolean isReady() {
        return ready && configured;
    }

    /**
     * Readiness is *not* a hard gate on the language status. Some engines report
     * LANG_MISSING_DATA / LANG_NOT_SUPPORTED during onInit and still synthesise
     * English once a voice is auto-downloaded or picked. We only treat a failure
     * as fatal after a real speak() attempt fails, so the UI never claims "no
     * English voice" based purely on a stale status code.
     */
    boolean canSpeakEnglish() {
        if (!isReady()) return false;
        return true;
    }

    /** True only when the engine positively reported a usable English locale. */
    boolean englishConfirmed() {
        return isReady() && langStatus != TextToSpeech.LANG_MISSING_DATA
            && langStatus != TextToSpeech.LANG_NOT_SUPPORTED;
    }

    /** Re-attempts language selection; called before a speak and by diagnostics. */
    boolean recheckLanguage() {
        if (tts == null) return false;
        try {
            langStatus = tts.setLanguage(locale());
            return langStatus != TextToSpeech.LANG_MISSING_DATA
                && langStatus != TextToSpeech.LANG_NOT_SUPPORTED;
        } catch (Throwable t) {
            lastError = t.getMessage();
            return false;
        }
    }

    JSONArray engines() {
        JSONArray arr = new JSONArray();
        try {
            if (tts == null) return arr;
            List<TextToSpeech.EngineInfo> list = new ArrayList<>(tts.getEngines());
            for (TextToSpeech.EngineInfo e : list) {
                JSONObject o = new JSONObject();
                o.put("label", e.label == null ? e.name : e.label);
                o.put("pkg", e.name);
                o.put("default", e.name != null && e.name.equals(getDefaultEngine()));
                arr.put(o);
            }
        } catch (Throwable ignored) { }
        return arr;
    }

    private String getDefaultEngine() {
        try {
            if (tts == null) return "";
            return tts.getDefaultEngine();
        } catch (Throwable t) {
            return "";
        }
    }

    /** How many English voices the engine exposes; a low count explains poor audio. */
    private int countEnglishVoices() {
        try {
            if (tts == null || Build.VERSION.SDK_INT < 21) return 0;
            java.util.Set<android.speech.tts.Voice> vs = tts.getVoices();
            if (vs == null) return 0;
            int n = 0;
            for (android.speech.tts.Voice v : vs) {
                if (v != null && v.getLocale() != null && "en".equalsIgnoreCase(v.getLocale().getLanguage())) n++;
            }
            return n;
        } catch (Throwable t) {
            return 0;
        }
    }

    JSONObject status() {
        JSONObject o = new JSONObject();
        try {
            o.put("ready", isReady());
            // "englishConfirmed" means the engine positively reported an English
            // locale. It is informational only: the app never disables the speaker
            // from it, because a negative answer is not proof of failure.
            o.put("english", englishConfirmed());
            o.put("langStatus", langStatus);
            o.put("accent", accent);
            o.put("engine", engineName == null ? "" : engineName);
            o.put("defaultEngine", getDefaultEngine());
            o.put("voice", voiceName == null ? "" : voiceName);
            o.put("voiceCount", countEnglishVoices());
            o.put("error", lastError == null ? "" : lastError);
            o.put("sdk", Build.VERSION.SDK_INT);
        } catch (Exception ignored) { }
        return o;
    }

    float clampRate(float rate) {
        if (Float.isNaN(rate) || rate < 0.3f) return 0.3f;
        if (rate > 2.0f) return 2.0f;
        return rate;
    }

    void applyRateFromPrefs() {
        if (tts == null) return;
        try { tts.setSpeechRate(rate()); } catch (Throwable ignored) { }
    }

    private static String cacheName(String text) {
        String key = text == null ? "" : text.trim().toLowerCase();
        return "tts-" + Integer.toHexString(key.hashCode()) + "-" + Math.abs(key.length()) + ".wav";
    }

    private File cacheFile(String text) {
        if (!cacheDir.exists() && !cacheDir.mkdirs()) return null;
        return new File(cacheDir, cacheName(text));
    }

    /** Playable cache path for a text, or null when nothing was prefetched. */
    String cachedPath(String text) {
        try {
            File f = cacheFile(text);
            return f != null && f.exists() && f.length() > 0 ? f.getAbsolutePath() : null;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * Synthesises one word to the cache directory so a later tap is a local file
     * playback. Never blocks the UI thread caller (TTS is async by nature).
     */
    synchronized boolean prefetch(String text) {
        if (!canSpeakEnglish()) return false;
        try {
            File f = cacheFile(text);
            if (f == null) return false;
            if (f.exists() && f.length() > 0) return true;
            if (f.exists() && !f.delete()) return false;
            tts.setSpeechRate(rate());
            int r = tts.synthesizeToFile(text, null, f, "prefetch-" + (++uttSeq));
            return r == TextToSpeech.SUCCESS;
        } catch (Throwable t) {
            lastError = t.getMessage();
            return false;
        }
    }

    /** Last time a re-init was attempted, to keep a failing engine from spinning. */
    private long lastReviveAt;

    /**
     * Rebuilds the engine when it never came up. A transient failure (engine
     * service not yet bound, voice data being installed, package visibility
     * granted after a manifest change) otherwise disabled speech for the whole
     * process lifetime — every later tap returned false with no way back except
     * force-stopping the app.
     *
     * Throttled: at most one attempt per few seconds, so a device with no usable
     * engine does not allocate a new TextToSpeech on every single tap.
     */
    private synchronized void reviveIfDead() {
        if (isReady()) return;
        long now = System.currentTimeMillis();
        if (now - lastReviveAt < 3000) return;
        lastReviveAt = now;
        try {
            if (tts != null) {
                try { tts.stop(); tts.shutdown(); } catch (Throwable ignored) { }
                tts = null;
            }
            init();
        } catch (Throwable t) {
            lastError = t.getMessage();
        }
    }

    synchronized boolean speak(String text, float rate) {
        if (text == null || text.trim().isEmpty()) return false;
        if (!isReady()) reviveIfDead();
        if (!isReady()) {
            lastError = "tts not ready";
            return false;
        }
        try {
            // Always stop first: fast card flipping must never stack audio.
            tts.stop();
            // Re-assert the locale on every attempt: a status cached at onInit can
            // be stale (voice pack downloaded later, or engine reporting late).
            langStatus = tts.setLanguage(locale());
            tts.setSpeechRate(clampRate(rate));
            String id = "moci-" + (++uttSeq);
            int r = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id);
            if (r != TextToSpeech.SUCCESS) {
                lastError = "speak returned " + r;
                return false;
            }
            return true;
        } catch (Throwable t) {
            lastError = t.getMessage();
            return false;
        }
    }

    synchronized void stop() {
        try { if (tts != null) tts.stop(); } catch (Throwable ignored) { }
    }

    synchronized void shutdown() {
        try {
            if (tts != null) { tts.stop(); tts.shutdown(); }
        } catch (Throwable ignored) { }
        tts = null;
        ready = false;
        configured = false;
        try {
            File[] files = cacheDir.listFiles();
            if (files != null) for (File f : files) f.delete();
        } catch (Throwable ignored) { }
    }
}
