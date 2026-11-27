(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Moci = root.Moci || {}; root.Moci.nativejson = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * The JavascriptInterface methods return JSON *strings*. Reading properties off
   * those strings silently yields undefined, which once made the TTS prefetch
   * cache and the online cache look permanently empty. Every direct
   * MociNative call whose result is inspected must go through this.
   */
  function parse(raw, fallback) {
    if (raw == null) return fallback === undefined ? null : fallback;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return fallback === undefined ? null : fallback;
    try {
      var v = JSON.parse(raw);
      return v == null ? (fallback === undefined ? null : fallback) : v;
    } catch (e) {
      return fallback === undefined ? null : fallback;
    }
  }

  function ok(raw) {
    var v = parse(raw, null);
    return !!(v && v.ok);
  }

  return { parse: parse, ok: ok };
});
