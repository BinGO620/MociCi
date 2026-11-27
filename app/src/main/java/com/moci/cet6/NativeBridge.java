package com.moci.cet6;

import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/** The only surface exposed to the WebView. Every method is synchronous and returns a JSON string. */
final class NativeBridge {
    private final MainActivity activity;
    private final AtomicStore store;
    private final Prefs prefs;
    private final TtsEngine tts;
    private final HttpProxy http;

    NativeBridge(MainActivity activity, AtomicStore store, Prefs prefs, TtsEngine tts, HttpProxy http, MainActivity unused) {
        this.activity = activity;
        this.store = store;
        this.prefs = prefs;
        this.tts = tts;
        this.http = http;
    }

    private static String ok(JSONObject o) {
        try {
            o.put("ok", true);
        } catch (Exception ignored) { }
        return o.toString();
    }

    private static String err(String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", false);
            o.put("error", message == null ? "unknown" : message);
        } catch (Exception ignored) { }
        return o.toString();
    }

    // ---------- storage ----------

    @JavascriptInterface
    public String readText(String rel) {
        try {
            String s = store.readText(rel);
            JSONObject o = new JSONObject();
            o.put("text", s);
            o.put("exists", s != null);
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String writeText(String rel, String text) {
        try {
            JSONObject o = new JSONObject();
            o.put("bytes", store.writeText(rel, text));
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String writeBase64(String rel, String b64) {
        try {
            JSONObject o = new JSONObject();
            o.put("bytes", store.writeBase64(rel, b64));
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String readBase64(String rel) {
        try {
            JSONObject o = new JSONObject();
            o.put("base64", store.readBase64(rel));
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String list(String rel) {
        try {
            JSONObject o = new JSONObject();
            o.put("items", store.list(rel));
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String stat(String rel) {
        try {
            return ok(store.stat(rel));
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String delete(String rel) {
        try {
            JSONObject o = new JSONObject();
            o.put("deleted", store.delete(rel));
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String copy(String from, String to) {
        try {
            String text = store.readText(from);
            if (text == null) return err("源文件不存在");
            JSONObject o = new JSONObject();
            o.put("bytes", store.writeText(to, text));
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String storageInfo() {
        try {
            return ok(store.storageInfo());
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    // ---------- prefs ----------

    @JavascriptInterface
    public String prefGet(String key) {
        try {
            JSONObject o = new JSONObject();
            o.put("value", prefs.get(key, null));
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String prefSet(String key, String value) {
        try {
            prefs.set(key, value);
            JSONObject o = new JSONObject();
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String prefGetBool(String key, boolean def) {
        try {
            JSONObject o = new JSONObject();
            o.put("value", prefs.getBool(key, def));
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String prefSetBool(String key, boolean value) {
        try {
            prefs.setBool(key, value);
            return ok(new JSONObject());
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    // ---------- tts ----------

    @JavascriptInterface
    public String ttsStatus() {
        try {
            return ok(tts.status());
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String ttsEngines() {
        try {
            JSONObject o = new JSONObject();
            o.put("items", tts.engines());
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String ttsSetEngine(String pkg) {
        try {
            tts.setEngine(pkg);
            return ok(new JSONObject());
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String ttsSpeak(String text, float rate) {
        try {
            JSONObject o = new JSONObject();
            o.put("spoken", tts.speak(text, rate));
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String ttsStop() {
        try {
            tts.stop();
            return ok(new JSONObject());
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String ttsOpenSettings() {
        try {
            activity.openTtsSettings();
            return ok(new JSONObject());
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    // ---------- http ----------

    @JavascriptInterface
    public void httpPost(String url, String body, String callbackId) {
        http.postJson(url, body, json -> activity.jsResolve(callbackId, json));
    }

    @JavascriptInterface
    public void httpGetBase64(String url, String callbackId) {
        http.getBase64(url, json -> activity.jsResolve(callbackId, json));
    }

    /** Downloads audio straight to the cache; resolves with {ok, path, bytes}. */
    @JavascriptInterface
    public void audioFetch(String url, String key, String callbackId) {
        http.fetchToFile(url, key, json -> activity.jsResolve(callbackId, json));
    }

    /** Path of an already-cached clip, or {ok:true, path:""} when absent. */
    @JavascriptInterface
    public String audioCachedPath(String key) {
        try {
            JSONObject o = new JSONObject();
            o.put("path", http.cachedAudioPath(key));
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    // ---------- misc ----------

    @JavascriptInterface
    public void pickFile(String callbackId) {
        activity.startPickFile(callbackId);
    }

    @JavascriptInterface
    public void pickImage(String callbackId) {
        activity.startPickImage(callbackId);
    }

    @JavascriptInterface
    public void camera(String callbackId) {
        activity.startCamera(callbackId);
    }

    @JavascriptInterface
    public void saveFile(String srcRel, String suggestedName, String mime, String callbackId) {
        activity.startSaveFile(srcRel, suggestedName, mime, callbackId);
    }

    @JavascriptInterface
    public String toast(String msg) {
        try {
            activity.toast(msg);
            return ok(new JSONObject());
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String copyText(String text) {
        try {
            activity.copyText(text);
            return ok(new JSONObject());
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String ttsSetAccent(String accent) {
        try {
            tts.setAccent(accent);
            JSONObject o = new JSONObject();
            o.put("accent", tts.accent());
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String ttsIsReady() {
        try {
            JSONObject o = new JSONObject();
            o.put("ready", tts.isReady());
            o.put("english", tts.canSpeakEnglish());
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String ttsPrefetch(String text) {
        try {
            JSONObject o = new JSONObject();
            o.put("started", tts.prefetch(text));
            o.put("path", tts.cachedPath(text));
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String ttsCachedPath(String text) {
        try {
            JSONObject o = new JSONObject();
            o.put("path", tts.cachedPath(text));
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String ttsSetRate(float rate) {
        try {
            prefs.set("speechRate", String.valueOf(rate));
            tts.applyRateFromPrefs();
            return ok(new JSONObject());
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String applyTheme(boolean dark) {
        try {
            activity.applyBars(dark);
            return ok(new JSONObject());
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }

    @JavascriptInterface
    public String platform() {
        try {
            JSONObject o = new JSONObject();
            o.put("os", "android");
            o.put("sdk", android.os.Build.VERSION.SDK_INT);
            o.put("device", android.os.Build.MODEL == null ? "" : android.os.Build.MODEL);
            o.put("version", "1.0");
            return ok(o);
        } catch (Throwable t) {
            return err(String.valueOf(t.getMessage()));
        }
    }
}
