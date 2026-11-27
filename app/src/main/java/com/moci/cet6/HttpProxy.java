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

    HttpProxy(android.content.Context ctx, Prefs prefs) {
        this.prefs = prefs;
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
