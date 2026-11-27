package com.moci.cet6;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {

    static final int REQ_PICK_FILE = 1001;
    static final int REQ_CAMERA = 1002;
    static final int REQ_SAVE_FILE = 1003;

    private WebView web;
    private AtomicStore store;
    private Prefs prefs;
    private TtsEngine tts;
    private HttpProxy http;
    private NativeBridge bridge;
    private final Map<Integer, String> pending = new HashMap<>();

    private boolean debuggable;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;

        store = new AtomicStore(this);
        prefs = new Prefs(this);
        tts = new TtsEngine(this, prefs);
        http = new HttpProxy(this, prefs);

        web = new WebView(this);
        web.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(prefs.getBool("dark", false) ? Color.parseColor("#10131A") : Color.parseColor("#F7F8FA"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(false);
        if (debuggable) WebView.setWebContentsDebuggingEnabled(true);

        CookieManager.getInstance().setAcceptCookie(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleExternal(url);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                android.util.Log.d("MociConsole", cm.message() + " @" + cm.lineNumber());
                return true;
            }
        });

        bridge = new NativeBridge(this, store, prefs, tts, http, this);
        web.addJavascriptInterface(bridge, "MociNative");

        applyBars(prefs.getBool("dark", false));
        web.loadUrl("file:///android_asset/index.html");
    }

    private boolean handleExternal(String url) {
        if (url == null) return false;
        if (url.startsWith("file:///android_asset/")) return false;
        if (url.startsWith("http://") || url.startsWith("https://")) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) { }
            return true;
        }
        return true;
    }

    void applyBars(boolean dark) {
        runOnUiThread(() -> {
            try {
                getWindow().setStatusBarColor(Color.parseColor(dark ? "#10131A" : "#F7F8FA"));
                getWindow().setNavigationBarColor(Color.parseColor(dark ? "#10131A" : "#F7F8FA"));
                int flags = getWindow().getDecorView().getSystemUiVisibility();
                if (Build.VERSION.SDK_INT >= 23) {
                    if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                }
                if (Build.VERSION.SDK_INT >= 26) {
                    if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                    else flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
                getWindow().getDecorView().setSystemUiVisibility(flags);
                web.setBackgroundColor(Color.parseColor(dark ? "#10131A" : "#F7F8FA"));
            } catch (Throwable ignored) { }
        });
    }

    void jsResolve(String callbackId, String json) {
        if (callbackId == null || callbackId.isEmpty()) return;
        final String script = "window.__mociResolve && window.__mociResolve(" +
                org.json.JSONObject.quote(callbackId) + "," + org.json.JSONObject.quote(json == null ? "{}" : json) + ")";
        runOnUiThread(() -> {
            try { web.evaluateJavascript(script, null); } catch (Throwable ignored) { }
        });
    }

    void jsEvent(String name, String json) {
        final String script = "window.__mociEvent && window.__mociEvent(" +
                org.json.JSONObject.quote(name) + "," + org.json.JSONObject.quote(json == null ? "{}" : json) + ")";
        runOnUiThread(() -> {
            try { web.evaluateJavascript(script, null); } catch (Throwable ignored) { }
        });
    }

    void startPickFile(String cb) {
        pending.put(REQ_PICK_FILE, cb);
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"text/*", "application/json", "text/csv", "application/octet-stream"});
        try {
            startActivityForResult(i, REQ_PICK_FILE);
        } catch (ActivityNotFoundException e) {
            resolveError(REQ_PICK_FILE, "没有可用的文件选择器");
        }
    }

    void startPickImage(String cb) {
        pending.put(REQ_PICK_FILE + 10, cb);
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("image/*");
        try {
            startActivityForResult(i, REQ_PICK_FILE + 10);
        } catch (ActivityNotFoundException e) {
            resolveError(REQ_PICK_FILE + 10, "没有可用的图片选择器");
        }
    }

    void startCamera(String cb) {
        pending.put(REQ_CAMERA, cb);
        try {
            File dir = new File(getCacheDir(), "camera");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("no cache dir");
            File out = new File(dir, "shot-" + System.currentTimeMillis() + ".jpg");
            Uri uri = CameraFileProvider.uriFor(this, out);
            Intent i = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, uri);
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            pending.put(REQ_CAMERA + 1000, out.getAbsolutePath());
            startActivityForResult(i, REQ_CAMERA);
        } catch (Throwable t) {
            resolveError(REQ_CAMERA, "相机不可用：" + t.getMessage());
        }
    }

    void startSaveFile(String srcRel, String suggestedName, String mime, String cb) {
        pending.put(REQ_SAVE_FILE, cb);
        pending.put(REQ_SAVE_FILE + 1000, srcRel);
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(mime == null || mime.isEmpty() ? "text/plain" : mime);
        if (suggestedName != null && !suggestedName.isEmpty()) i.putExtra(Intent.EXTRA_TITLE, suggestedName);
        try {
            startActivityForResult(i, REQ_SAVE_FILE);
        } catch (ActivityNotFoundException e) {
            resolveError(REQ_SAVE_FILE, "没有可用的保存位置");
        }
    }

    private void resolveError(int req, String msg) {
        String cb = pending.remove(req);
        jsResolve(cb, "{\"ok\":false,\"error\":" + org.json.JSONObject.quote(msg == null ? "unknown" : msg) + "}");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK_FILE) {
            String cb = pending.remove(REQ_PICK_FILE);
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                jsResolve(cb, "{\"ok\":false,\"error\":\"cancelled\"}");
                return;
            }
            readUriResult(cb, data.getData(), 12 * 1024 * 1024, false);
            return;
        }
        if (requestCode == REQ_PICK_FILE + 10) {
            String cb = pending.remove(REQ_PICK_FILE + 10);
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                jsResolve(cb, "{\"ok\":false,\"error\":\"cancelled\"}");
                return;
            }
            readUriResult(cb, data.getData(), 16 * 1024 * 1024, true);
            return;
        }
        if (requestCode == REQ_CAMERA) {
            String cb = pending.remove(REQ_CAMERA);
            String path = pending.remove(REQ_CAMERA + 1000);
            if (resultCode != RESULT_OK || path == null) {
                jsResolve(cb, "{\"ok\":false,\"error\":\"cancelled\"}");
                return;
            }
            try {
                File f = new File(path);
                if (!f.exists() || f.length() == 0) {
                    jsResolve(cb, "{\"ok\":false,\"error\":\"照片为空\"}");
                    return;
                }
                String b64 = store.readBase64(relToRoot(f));
                String mime = "image/jpeg";
                jsResolve(cb, "{\"ok\":true,\"base64\":" + org.json.JSONObject.quote(b64)
                        + ",\"mime\":" + org.json.JSONObject.quote(mime)
                        + ",\"bytes\":" + f.length() + "}");
            } catch (Exception e) {
                jsResolve(cb, "{\"ok\":false,\"error\":" + org.json.JSONObject.quote(String.valueOf(e.getMessage())) + "}");
            }
            return;
        }
        if (requestCode == REQ_SAVE_FILE) {
            String cb = pending.remove(REQ_SAVE_FILE);
            String srcRel = pending.remove(REQ_SAVE_FILE + 1000);
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                jsResolve(cb, "{\"ok\":false,\"error\":\"cancelled\"}");
                return;
            }
            try {
                byte[] bytes = readStoreFile(srcRel);
                OutputStream out = getContentResolver().openOutputStream(data.getData());
                if (out == null) throw new Exception("open failed");
                try {
                    out.write(bytes);
                    out.flush();
                } finally {
                    out.close();
                }
                jsResolve(cb, "{\"ok\":true,\"bytes\":" + bytes.length + "}");
            } catch (Exception e) {
                jsResolve(cb, "{\"ok\":false,\"error\":" + org.json.JSONObject.quote(String.valueOf(e.getMessage())) + "}");
            }
        }
    }

    private byte[] readStoreFile(String rel) throws Exception {
        File f = store.resolve(rel);
        InputStream in = new java.io.FileInputStream(f);
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } finally {
            in.close();
        }
    }

    private String relToRoot(File f) throws Exception {
        String root = store.root().getCanonicalPath();
        String p = f.getCanonicalPath();
        if (!p.startsWith(root)) throw new Exception("outside root");
        String rel = p.substring(root.length()).replace('\\', '/');
        while (rel.startsWith("/")) rel = rel.substring(1);
        return rel;
    }

    private void readUriResult(String cb, Uri uri, int maxBytes, boolean wantBase64) {
        new Thread(() -> {
            try {
                String name = queryName(uri);
                InputStream in = getContentResolver().openInputStream(uri);
                if (in == null) throw new Exception("open failed");
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[64 * 1024];
                int n;
                int total = 0;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > maxBytes) throw new Exception("文件过大（上限 " + (maxBytes / 1024 / 1024) + "MB）");
                    bos.write(buf, 0, n);
                }
                in.close();
                byte[] bytes = bos.toByteArray();
                String mime = getContentResolver().getType(uri);
                StringBuilder json = new StringBuilder();
                json.append("{\"ok\":true,\"name\":").append(org.json.JSONObject.quote(name == null ? "file" : name));
                json.append(",\"bytes\":").append(bytes.length);
                json.append(",\"mime\":").append(org.json.JSONObject.quote(mime == null ? "" : mime));
                if (wantBase64 || (mime != null && mime.startsWith("image/"))) {
                    json.append(",\"base64\":").append(org.json.JSONObject.quote(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)));
                } else {
                    json.append(",\"text\":").append(org.json.JSONObject.quote(new String(bytes, java.nio.charset.StandardCharsets.UTF_8)));
                }
                json.append("}");
                jsResolve(cb, json.toString());
            } catch (Exception e) {
                jsResolve(cb, "{\"ok\":false,\"error\":" + org.json.JSONObject.quote(String.valueOf(e.getMessage())) + "}");
            }
        }).start();
    }

    private String queryName(Uri uri) {
        try (android.database.Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) return c.getString(idx);
            }
        } catch (Exception ignored) { }
        return uri.getLastPathSegment();
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            finishSelf();
            return;
        }
        web.evaluateJavascript("window.__mociBack ? window.__mociBack() : false", value -> {
            if (!"true".equals(value)) {
                finishSelf();
            }
        });
    }

    private void finishSelf() {
        finish();
    }

    @Override
    protected void onPause() {
        super.onPause();
        try { tts.stop(); } catch (Throwable ignored) { }
        try { web.onPause(); } catch (Throwable ignored) { }
    }

    @Override
    protected void onResume() {
        super.onResume();
        try { web.onResume(); } catch (Throwable ignored) { }
    }

    @Override
    protected void onDestroy() {
        try { http.shutdown(); } catch (Throwable ignored) { }
        try { tts.shutdown(); } catch (Throwable ignored) { }
        try {
            if (web != null) {
                web.removeJavascriptInterface("MociNative");
                web.destroy();
            }
        } catch (Throwable ignored) { }
        super.onDestroy();
    }

    void toast(String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg == null ? "" : msg, Toast.LENGTH_SHORT).show());
    }

    void copyText(String text) {
        runOnUiThread(() -> {
            try {
                android.content.ClipboardManager cm =
                        (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(android.content.ClipData.newPlainText("moci", text == null ? "" : text));
            } catch (Throwable ignored) { }
        });
    }

    void openTtsSettings() {
        try {
            Intent i = new Intent("com.android.settings.TTS_SETTINGS");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            try {
                startActivity(new Intent(Settings.ACTION_SETTINGS));
            } catch (Exception ignored) { }
        }
    }

    void shareText(String text) {
        try {
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType("text/plain");
            i.putExtra(Intent.EXTRA_TEXT, text);
            startActivity(Intent.createChooser(i, "分享"));
        } catch (Exception ignored) { }
    }

    WebView webView() {
        return web;
    }
}
