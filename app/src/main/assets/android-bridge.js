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
      pending[c.id] = resolve;
      try {
        invoke(c.id);
      } catch (e) {
        delete pending[c.id];
        resolve({ ok: false, error: String(e && e.message ? e.message : e) });
      }
      setTimeout(function () {
        if (pending[c.id]) {
          delete pending[c.id];
          resolve({ ok: false, error: 'timeout' });
        }
      }, 130000);
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
    ttsSpeak: function (t, r) { return root.MociNative.ttsSpeak(t, r); },
    ttsStop: function () { return root.MociNative.ttsStop(); },
    ttsOpenSettings: function () { return root.MociNative.ttsOpenSettings(); },
    copyText: function (t) { return root.MociNative.copyText(t); },
    openTtsSettings: function () { return root.MociNative.openTtsSettings(); },
    applyTheme: function (d) { return root.MociNative.applyTheme(!!d); },
    toast: function (m) { return root.MociNative.toast(m); },
    storageInfo: function () { return root.MociNative.storageInfo(); },
    httpPost: function (url, body) {
      return wrap('post', function (id) { root.MociNative.httpPost(url, body, id); });
    },
    httpGetBase64: function (url) {
      return wrap('get', function (id) { root.MociNative.httpGetBase64(url, id); });
    },
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
