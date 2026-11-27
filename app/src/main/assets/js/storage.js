(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Moci = root.Moci || {}; root.Moci.storage = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Adapters expose a small synchronous file API. The Android bridge is
   * synchronous through addJavascriptInterface, so the app and tests share one
   * code path.
   */
  function memoryAdapter(seed) {
    var files = Object.assign({}, seed || {});
    var mtimes = {};
    var clock = 0;
    return {
      id: 'memory',
      read: function (rel) {
        if (files[rel] == null) return null;
        if (files[rel] && files[rel].kind === 'binary') return null;
        return files[rel];
      },
      write: function (rel, text) {
        files[rel] = text;
        mtimes[rel] = ++clock;
        return { ok: true, bytes: text.length };
      },
      exists: function (rel) { return files[rel] != null; },
      list: function (dir) {
        var prefix = dir.replace(/\/+$/, '') + '/';
        var out = [];
        Object.keys(files).forEach(function (k) {
          if (k.indexOf(prefix) !== 0) return;
          var rest = k.slice(prefix.length);
          var name = rest.split('/')[0];
          var isDir = rest.indexOf('/') >= 0;
          if (out.some(function (o) { return o.name === name; })) return;
          out.push({
            name: name, dir: isDir,
            size: isDir ? 0 : String(files[k]).length,
            mtime: mtimes[k] || 0
          });
        });
        return out;
      },
      del: function (rel) {
        Object.keys(files).forEach(function (k) {
          if (k === rel || k.indexOf(rel.replace(/\/+$/, '') + '/') === 0) {
            delete files[k];
            delete mtimes[k];
          }
        });
        return { ok: true };
      },
      stat: function (rel) {
        var isDir = Object.keys(files).some(function (k) { return k.indexOf(rel.replace(/\/+$/, '') + '/') === 0; });
        return {
          exists: files[rel] != null || isDir,
          size: files[rel] != null ? String(files[rel]).length : 0,
          dir: isDir, mtime: mtimes[rel] || 0
        };
      },
      dump: function () { return Object.assign({}, files); }
    };
  }

  function webAdapter(prefix) {
    prefix = prefix || 'moci:';
    var indexKey = prefix + '__files__';
    var MAX_BYTES = 4 * 1024 * 1024;
    function readIndex() {
      try {
        var raw = localStorage.getItem(indexKey);
        return raw ? JSON.parse(raw) : [];
      } catch (e) { return []; }
    }
    function writeIndex(list) {
      try { localStorage.setItem(indexKey, JSON.stringify(list)); } catch (e) { }
    }
    function track(rel) {
      var list = readIndex();
      if (list.indexOf(rel) < 0) { list.push(rel); writeIndex(list); }
    }
    function untrack(rel) {
      var list = readIndex().filter(function (k) {
        return k !== rel && k.indexOf(rel.replace(/\/+$/, '') + '/') !== 0;
      });
      writeIndex(list);
    }
    /** localStorage caps around 5MB; refuse early instead of throwing QuotaExceeded. */
    function checkQuota(rel, text) {
      var bytes = (text || '').length;
      if (bytes > MAX_BYTES) {
        return { ok: false, error: '数据过大（' + Math.round(bytes / 1024 / 1024 * 10) / 10 + 'MB），浏览器版上限 4MB，请改用 Android 版或先导出备份' };
      }
      try {
        var used = 0;
        var keys = readIndex();
        for (var i = 0; i < keys.length; i++) {
          var v = localStorage.getItem(prefix + keys[i]);
          used += (v ? v.length : 0);
        }
        if (used + bytes > MAX_BYTES) {
          return { ok: false, error: '浏览器存储接近上限（已用 ' + Math.round(used / 1024) + 'KB），请先导出备份或删除部分数据' };
        }
      } catch (e) { /* measuring is advisory only */ }
      return null;
    }
    return {
      id: 'web',
      read: function (rel) {
        try { return localStorage.getItem(prefix + rel); } catch (e) { return null; }
      },
      write: function (rel, text) {
        var deny = checkQuota(rel, text);
        if (deny) return deny;
        try {
          localStorage.setItem(prefix + rel, text);
        } catch (e) {
          var over = e && /quota/i.test(String(e.name || e.message));
          return {
            ok: false,
            error: over ? '浏览器存储已满，请导出备份或改用 Android 版' : String(e.message || e)
          };
        }
        localStorage.setItem(prefix + '__mtime__' + rel, String(Date.now()));
        track(rel);
        return { ok: true, bytes: text.length };
      },
      exists: function (rel) {
        try { return localStorage.getItem(prefix + rel) != null; } catch (e) { return false; }
      },
      list: function (dir) {
        var base = dir.replace(/\/+$/, '');
        var prefix2 = base ? base + '/' : '';
        var seen = {};
        var out = [];
        readIndex().forEach(function (k) {
          if (!prefix2) return;
          if (k.indexOf(prefix2) !== 0) return;
          var rest = k.slice(prefix2.length);
          if (!rest) return;
          var slash = rest.indexOf('/');
          var name = slash < 0 ? rest : rest.slice(0, slash);
          if (seen[name]) return;
          seen[name] = true;
          if (slash >= 0) {
            out.push({ name: name, dir: true, size: 0, mtime: 0 });
            return;
          }
          var value = localStorage.getItem(prefix + k);
          out.push({
            name: name, dir: false,
            size: value ? value.length : 0,
            mtime: Number(localStorage.getItem(prefix + '__mtime__' + k)) || 0
          });
        });
        out.sort(function (a, b) { return a.name.localeCompare(b.name); });
        return out;
      },
      del: function (rel) {
        localStorage.removeItem(prefix + rel);
        var list = readIndex().filter(function (k) {
          if (k === rel) { localStorage.removeItem(prefix + k); return false; }
          if (k.indexOf(rel.replace(/\/+$/, '') + '/') === 0) { localStorage.removeItem(prefix + k); return false; }
          return true;
        });
        writeIndex(list);
        return { ok: true };
      },
      stat: function (rel) {
        var value = null;
        try { value = localStorage.getItem(prefix + rel); } catch (e) { }
        var isDir = readIndex().some(function (k) { return k.indexOf(rel.replace(/\/+$/, '') + '/') === 0; });
        return { exists: value != null || isDir, size: value ? value.length : 0, dir: isDir, mtime: 0 };
      }
    };
  }

  function nativeAdapter(bridge) {
    // Android's @JavascriptInterface resolves methods by exact arity: calling a
    // two-argument Java method with three JS arguments throws "Method not found".
    // Always invoke with the precise number of arguments the method declares.
    function invoke(args, run) {
      try {
        var raw = run();
        return typeof raw === 'string' ? JSON.parse(raw) : (raw || { ok: false, error: 'empty reply' });
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    }
    function call0(fn) {
      return invoke([], function () { return bridge[fn](); });
    }
    function call1(fn, a) {
      return invoke([a], function () { return bridge[fn](a); });
    }
    function call2(fn, a, b) {
      return invoke([a, b], function () { return bridge[fn](a, b); });
    }
    return {
      id: 'native',
      read: function (rel) {
        var r = call1('readText', rel);
        return r && r.ok ? r.text : null;
      },
      write: function (rel, text) {
        return call2('writeText', rel, text);
      },
      exists: function (rel) {
        var r = call1('stat', rel);
        return !!(r && r.ok && r.exists);
      },
      list: function (dir) {
        var r = call1('list', dir);
        return r && r.ok && Array.isArray(r.items) ? r.items : [];
      },
      del: function (rel) {
        return call1('delete', rel) || { ok: false };
      },
      stat: function (rel) {
        var r = call1('stat', rel);
        return r && r.ok ? r : { exists: false, size: 0, dir: false, mtime: 0 };
      },
      info: function () {
        var r = call0('storageInfo');
        return r && r.ok ? r : {};
      },
      bytesOf: function (rel) {
        var r = call1('readText', rel);
        return r && r.ok && r.text != null ? r.text.length : 0;
      },
      /** Diagnostics: proves which native methods actually answer on this device. */
      selfTest: function () {
        var probe = 'probe.json';
        var payload = '{"ok":true}';
        var results = {};
        var w = call2('writeText', probe, payload);
        results.writeText = !!(w && w.ok);
        var r = call1('readText', probe);
        results.readText = !!(r && r.ok && r.text === payload);
        var d = call1('delete', probe);
        results.delete = !!(d && d.ok);
        var st = call1('stat', 'wordbook.json');
        results.stat = !!(st && st.ok);
        var li = call1('list', '');
        results.list = !!(li && li.ok);
        var inf = call0('storageInfo');
        results.storageInfo = !!(inf && inf.ok);
        results.firstError = (!results.writeText && w && w.error) || (!results.readText && r && r.error) || '';
        return results;
      }
    };
  }

  function pick() {
    try {
      if (typeof MociNative !== 'undefined' && MociNative && typeof MociNative.readText === 'function') {
        return nativeAdapter(MociNative);
      }
    } catch (e) { /* not in Android */ }
    try {
      if (typeof localStorage !== 'undefined') return webAdapter('moci:');
    } catch (e) { /* storage disabled */ }
    return memoryAdapter();
  }

  /**
   * One-way promotion of browser-era data into native storage. A user who
   * debugged in the browser and then installs the APK should not lose their
   * wordbook; only files that do not exist natively are copied.
   */
  function migrateWebToNative(native, web, knownFiles) {
    var copied = [];
    (knownFiles || ['wordbook.json', 'stats.json', 'deleted.json', 'settings.json']).forEach(function (rel) {
      try {
        if (native.exists(rel)) return;
        var text = web.read(rel);
        if (text == null || text === '') return;
        var r = native.write(rel, text);
        if (r && r.ok !== false) copied.push(rel);
      } catch (e) { /* skip a file rather than abort the migration */ }
    });
    return copied;
  }

  return {
    memoryAdapter: memoryAdapter,
    webAdapter: webAdapter,
    nativeAdapter: nativeAdapter,
    pick: pick,
    migrateWebToNative: migrateWebToNative
  };
});
