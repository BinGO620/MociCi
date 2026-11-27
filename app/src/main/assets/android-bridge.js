(function (root) {
  'use strict';
  if (!root.MociNative) return;
  var seq = 0;
  var pending = {};
  var events = {};

  root.__mociResolve = function (id, json) {
    var cb = pending[id];
    if (!cb) return;
    delete pending[id];
    var data;
    try { data = JSON.parse(json); } catch (e) { data = { ok: false, error: 'bad json' }; }
    cb(data);
  };

  root.__mociEvent = function (name, json) {
    var list = events[name] || [];
    var data;
    try { data = JSON.parse(json); } catch (e) { data = {}; }
    list.forEach(function (fn) { try { fn(data); } catch (e) { } });
  };

  function callback(prefix) {
    var id = prefix + '-' + (++seq);
    return { id: id, promise: null };
  }

  function wrap(prefix, invoke) {
    return new Promise(function (resolve) {
      var c = callback(prefix);
      // The timeout must be cleared once the call resolves. Leaving it armed kept
      // a 130-second timer alive per request: wasteful on device, and in tests it
      // held the process open long after every assertion had passed.
      //
      // Arm the timer BEFORE invoking: @JavascriptInterface callbacks can resolve
      // synchronously, and if the timer were installed afterwards the completion
      // would have nothing to clear and the timer would outlive the request.
      var done = false;
      var settle = function (result) {
        if (done) return;
        done = true;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        resolve(result);
      };
      var timer = setTimeout(function () {
        timer = null;
        if (!done) {
          delete pending[c.id];
          settle({ ok: false, error: 'timeout' });
        }
      }, 130000);

      pending[c.id] = function (result) {
        settle(result);
      };
      try {
        invoke(c.id);
      } catch (e) {
        delete pending[c.id];
        settle({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    });
  }

  var bridge = {
    platform: function () { return root.MociNative.platform(); },
    prefGet: function (k) { return root.MociNative.prefGet(k); },
    prefSet: function (k, v) { return root.MociNative.prefSet(k, v); },
    prefGetBool: function (k, d) { return root.MociNative.prefGetBool(k, d); },
    prefSetBool: function (k, v) { return root.MociNative.prefSetBool(k, v); },
    ttsStatus: function () { return root.MociNative.ttsStatus(); },
    ttsEngines: function () { return root.MociNative.ttsEngines(); },
    ttsSetEngine: function (p) { return root.MociNative.ttsSetEngine(p); },
    ttsSetAccent: function (a) { return root.MociNative.ttsSetAccent(a); },
    ttsSpeak: function (t, r) { return root.MociNative.ttsSpeak(t, r); },
    ttsStop: function () { return root.MociNative.ttsStop(); },
    ttsIsReady: function () { return root.MociNative.ttsIsReady(); },
    ttsPrefetch: function (t) { return root.MociNative.ttsPrefetch(t); },
    ttsCachedPath: function (t) { return root.MociNative.ttsCachedPath(t); },
    ttsOpenSettings: function () { return root.MociNative.ttsOpenSettings(); },
    copyText: function (t) { return root.MociNative.copyText(t); },
    applyTheme: function (d) { return root.MociNative.applyTheme(!!d); },
    toast: function (m) { return root.MociNative.toast(m); },
    storageInfo: function () { return root.MociNative.storageInfo(); },
    httpPost: function (url, body) {
      return wrap('post', function (id) { root.MociNative.httpPost(url, body, id); });
    },
    httpGetBase64: function (url) {
      return wrap('get', function (id) { root.MociNative.httpGetBase64(url, id); });
    },
    // Read-only JSON GET used by the connection diagnostic.
    httpGetJson: function (url) {
      return wrap('gj', function (id) { root.MociNative.httpGetJson(url, id); });
    },
    // Native-side download straight to disk: resolves {ok, path, bytes, mime}.
    audioFetch: function (url, key) {
      return wrap('aud', function (id) { root.MociNative.audioFetch(url, key, id); });
    },
    audioCachedPath: function (key) { return root.MociNative.audioCachedPath(key); },
    pickFile: function () { return wrap('pick', function (id) { root.MociNative.pickFile(id); }); },
    pickImage: function () { return wrap('img', function (id) { root.MociNative.pickImage(id); }); },
    camera: function () { return wrap('cam', function (id) { root.MociNative.camera(id); }); },
    saveFile: function (rel, name, mime) {
      return wrap('save', function (id) { root.MociNative.saveFile(rel, name, mime, id); });
    },
    on: function (name, fn) {
      (events[name] = events[name] || []).push(fn);
    }
  };

  root.MociBridge = bridge;
})(typeof self !== 'undefined' ? self : this);
