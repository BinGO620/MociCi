package com.moci.cet6;

import android.os.Build;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** HTTPS-only network proxy. Only POST JSON (AI grading) and GET (audio fetch) are exposed. */
final class HttpProxy {
    private final Prefs prefs;
    private final ExecutorService pool = Executors.newFixedThreadPool(2);
    private final ExecutorService audioPool = Executors.newFixedThreadPool(2);
    private final java.io.File audioDir;

    HttpProxy(android.content.Context ctx, Prefs prefs) {
        this.prefs = prefs;
        this.audioDir = new java.io.File(ctx.getCacheDir(), "audio");
    }

    interface Callback {
        void done(String json);
    }

    private boolean allowed(String url) {
        if (url == null) return false;
        if (url.startsWith("https://")) return true;
        if (url.startsWith("http://")) return prefs.getBool("allowInsecureHttp", false);
        return false;
    }

    void shutdown() {
        pool.shutdownNow();
        audioPool.shutdownNow();
    }

    void postJson(String url, String body, Callback cb) {
        pool.execute(() -> {
            String result;
            HttpURLConnection conn = null;
            try {
                if (!allowed(url)) throw new Exception("仅允许 HTTPS 请求（可在设置中为自建服务开启 HTTP）");
                URL u = new URL(url);
                conn = (HttpURLConnection) u.openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(20_000);
                conn.setReadTimeout(120_000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                conn.setRequestProperty("Accept", "application/json");
                String auth = prefs.get("apiKey", "");
                if (auth != null && !auth.isEmpty()) {
                    conn.setRequestProperty("Authorization", "Bearer " + auth);
                }
                if (Build.VERSION.SDK_INT >= 19) conn.setRequestProperty("Accept-Encoding", "identity");
                byte[] payload = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(payload.length);
                OutputStream out = conn.getOutputStream();
                try {
                    out.write(payload);
                    out.flush();
                } finally {
                    out.close();
                }
                int code = conn.getResponseCode();
                InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
                String text = in == null ? "" : readAll(in, 8 * 1024 * 1024);
                StringBuilder extra = new StringBuilder();
                if (code >= 400) {
                    // A gateway rejection usually carries a JSON body explaining why.
                    // A hole-in-the-middle 403 (WAF /校园网关 / 运营商) returns an
                    // empty body, so the response headers are the only evidence left
                    // of who answered. Surface both rather than a bare status code.
                    extra.append(",\"server\":").append(org.json.JSONObject.quote(safeHeader(conn, "Server")));
                    extra.append(",\"via\":").append(org.json.JSONObject.quote(safeHeader(conn, "Via")));
                    extra.append(",\"waf\":").append(org.json.JSONObject.quote(safeHeader(conn, "X-Waf-Info")));
                    extra.append(",\"emptyBody\":").append(text.isEmpty() ? "true" : "false");
                }
                result = "{\"ok\":" + (code >= 200 && code < 300 ? "true" : "false")
                        + ",\"status\":" + code
                        + ",\"body\":" + org.json.JSONObject.quote(text) + extra + "}";
            } catch (Throwable t) {
                result = errorJson(t);
            } finally {
                if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) { }
            }
            cb.done(result);
        });
    }

    void getBase64(String url, Callback cb) {
        audioPool.execute(() -> {
            String result;
            HttpURLConnection conn = null;
            try {
                if (!allowed(url)) throw new Exception("仅允许 HTTPS 请求（可在设置中为自建服务开启 HTTP）");
                URL u = new URL(url);
                conn = (HttpURLConnection) u.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(15_000);
                conn.setReadTimeout(45_000);
                conn.setRequestProperty("Accept", "audio/*");
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) throw new Exception("HTTP " + code);
                InputStream in = conn.getInputStream();
                byte[] bytes;
                try {
                    bytes = readBytes(in, 6 * 1024 * 1024);
                } finally {
                    in.close();
                }
                String mime = conn.getContentType();
                if (mime == null) mime = "audio/mpeg";
                result = "{\"ok\":true,\"mime\":" + org.json.JSONObject.quote(mime)
                        + ",\"bytes\":" + bytes.length
                        + ",\"base64\":" + org.json.JSONObject.quote(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                        + "}";
            } catch (Throwable t) {
                result = errorJson(t);
            } finally {
                if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) { }
            }
            cb.done(result);
        });
    }

    /**
     * Downloads audio straight to the cache and reports only the path.
     *
     * The generic getBase64 path sends the whole clip through the JS bridge twice
     * (download → base64 → JS → writeBase64 → disk) and then plays it from a
     * data: URL, which is both slow and memory-hungry for a 30KB clip and worse
     * for anything larger. Writing the file natively and handing back a path lets
     * playback use a plain file:// URL, which is the same fast path the
     * system-TTS cache already uses.
     */
    void fetchToFile(String url, String key, Callback cb) {
        audioPool.execute(() -> {
            String result;
            HttpURLConnection conn = null;
            try {
                if (!allowed(url)) throw new Exception("仅允许 HTTPS 请求（可在设置中为自建服务开启 HTTP）");
                if (key == null || key.isEmpty()) throw new Exception("empty key");
                if (!audioDir.exists() && !audioDir.mkdirs()) throw new Exception("no cache dir");

                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(12_000);
                conn.setReadTimeout(30_000);
                conn.setRequestProperty("Accept", "audio/*");
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) throw new Exception("HTTP " + code);

                InputStream in = conn.getInputStream();
                byte[] bytes;
                try {
                    bytes = readBytes(in, 6 * 1024 * 1024);
                } finally {
                    in.close();
                }
                // A 200 with an empty body means the provider had nothing for this
                // text (observed on the pronunciation service for blank input).
                // Caching that would poison every later playback, so it is a failure.
                if (bytes.length == 0) throw new Exception("音频为空");

                java.io.File f = new java.io.File(audioDir, fileNameFor(key));
                java.io.File tmp = new java.io.File(audioDir, fileNameFor(key) + ".tmp");
                java.io.FileOutputStream out = new java.io.FileOutputStream(tmp);
                try {
                    out.write(bytes);
                    out.flush();
                    out.getFD().sync();
                } finally {
                    out.close();
                }
                if (f.exists() && !f.delete()) { /* best effort */ }
                if (!tmp.renameTo(f)) {
                    throw new Exception("缓存写入失败");
                }
                String mime = conn.getContentType();
                result = "{\"ok\":true,\"path\":" + org.json.JSONObject.quote(f.getAbsolutePath())
                        + ",\"bytes\":" + bytes.length
                        + ",\"mime\":" + org.json.JSONObject.quote(mime == null ? "audio/mpeg" : mime) + "}";
            } catch (Throwable t) {
                result = errorJson(t);
            } finally {
                if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) { }
            }
            cb.done(result);
        });
    }

    /** Path of an already-cached clip, or "" when nothing was fetched yet. */
    String cachedAudioPath(String key) {
        try {
            if (key == null || key.isEmpty()) return "";
            java.io.File f = new java.io.File(audioDir, fileNameFor(key));
            return f.exists() && f.length() > 0 ? f.getAbsolutePath() : "";
        } catch (Throwable t) {
            return "";
        }
    }

    /** Stable, filesystem-safe name derived from the caller's cache key. */
    private static String fileNameFor(String key) {
        return "a-" + Integer.toHexString(key.hashCode()) + "-" + Math.abs(key.length()) + ".bin";
    }

    private static String safeHeader(HttpURLConnection conn, String name) {
        try {
            String v = conn.getHeaderField(name);
            return v == null ? "" : v;
        } catch (Throwable t) {
            return "";
        }
    }

    private static String errorJson(Throwable t) {
        String msg = t.getMessage();
        if (msg == null) msg = t.getClass().getSimpleName();
        return "{\"ok\":false,\"error\":" + org.json.JSONObject.quote(msg) + "}";
    }

    private static String readAll(InputStream in, int max) throws Exception {
        return new String(readBytes(in, max), StandardCharsets.UTF_8);
    }

    private static byte[] readBytes(InputStream in, int max) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[32 * 1024];
        int n;
        int total = 0;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > max) throw new Exception("响应过大");
            bos.write(buf, 0, n);
        }
        return bos.toByteArray();
    }
}
