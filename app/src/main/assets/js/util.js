(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Moci = root.Moci || {}; root.Moci.util = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var WORD_RE = /^[A-Za-z](?:[A-Za-z'\-]*[A-Za-z])?$/;
  var CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
  var POS_SET = ('v vt vi n adj adv prep conj pron num art int interj aux abbr phr pl sing')
    .split(' ');

  function hasCJK(s) { return CJK_RE.test(s || ''); }

  function firstCJKIndex(s) {
    if (!s) return -1;
    for (var i = 0; i < s.length; i++) if (CJK_RE.test(s.charAt(i))) return i;
    return -1;
  }

  function normalizeWidth(s) {
    if (!s) return '';
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xFF01 && c <= 0xFF5E && c !== 0xFF0C && c !== 0xFF1B) {
        // fullwidth ASCII except Chinese comma/semicolon, which are meaningful in meanings
        out += String.fromCharCode(c - 0xFEE0);
      } else if (c === 0xFF5C) {
        out += '|';
      } else if (c === 0x3000) {
        out += ' ';
      } else {
        out += s.charAt(i);
      }
    }
    return out;
  }

  function stripZeroWidth(s) {
    return (s || '').replace(/[\u200B-\u200D\uFEFF\u2060]/g, '');
  }

  function normalizeQuotes(s) {
    return (s || '')
      .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');
  }

  function cleanLine(raw) {
    var s = stripZeroWidth(raw);
    s = normalizeWidth(s);
    s = s.replace(/\u00A0/g, ' ');
    s = normalizeQuotes(s);
    s = s.replace(/\s+$/, '');
    return s;
  }

  function collapseSpaces(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function wordKey(en) { return (en || '').trim().toLowerCase(); }

  function validWord(en) {
    var s = (en || '').trim();
    return s.length > 0 && s.length <= 64 && WORD_RE.test(s);
  }

  function isPosToken(tok) {
    var base = (tok || '').toLowerCase().replace(/\.$/, '');
    return POS_SET.indexOf(base) >= 0;
  }

  function levenshtein(a, b) {
    a = a || ''; b = b || '';
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = new Array(b.length + 1);
    var cur = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      cur[0] = i;
      var ca = a.charCodeAt(i - 1);
      for (var k = 1; k <= b.length; k++) {
        var cost = ca === b.charCodeAt(k - 1) ? 0 : 1;
        var v = Math.min(cur[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
        cur[k] = v;
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[b.length];
  }

  function editRatio(a, b) {
    var maxLen = Math.max((a || '').length, (b || '').length);
    if (maxLen === 0) return 0;
    return levenshtein(a, b) / maxLen;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function localDateKey(ts) {
    var d = ts instanceof Date ? ts : new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function parseDateKey(key) {
    var p = (key || '').split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function nextLocalMidnight(ts) {
    var d = new Date(ts);
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }

  function addDays(ts, n) {
    var d = new Date(ts);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  function nowIso() { return new Date().toISOString(); }

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);
  }

  function deepClone(v) {
    if (v === null || typeof v !== 'object') return v;
    return JSON.parse(JSON.stringify(v));
  }

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function uniqPush(arr, value) {
    if (!value) return arr;
    var key = collapseSpaces(value).toLowerCase();
    for (var i = 0; i < arr.length; i++) {
      if (collapseSpaces(arr[i]).toLowerCase() === key) return arr;
    }
    arr.push(value);
    return arr;
  }

  function debounce(fn, ms) {
    var timer = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function formatInterval(p, now) {
    var interval = Number(p && p.interval) || 0;
    if (interval >= 1) return interval + ' 天';
    if (p && p.due && p.due > now) {
      var mins = Math.max(1, Math.round((p.due - now) / 60000));
      return mins + ' 分钟后重练';
    }
    return '待复习';
  }

  function escapeRegExp(s) {
    return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  return {
    WORD_RE: WORD_RE,
    POS_SET: POS_SET,
    hasCJK: hasCJK,
    firstCJKIndex: firstCJKIndex,
    normalizeWidth: normalizeWidth,
    stripZeroWidth: stripZeroWidth,
    normalizeQuotes: normalizeQuotes,
    cleanLine: cleanLine,
    collapseSpaces: collapseSpaces,
    wordKey: wordKey,
    validWord: validWord,
    isPosToken: isPosToken,
    levenshtein: levenshtein,
    editRatio: editRatio,
    localDateKey: localDateKey,
    parseDateKey: parseDateKey,
    nextLocalMidnight: nextLocalMidnight,
    addDays: addDays,
    nowIso: nowIso,
    uid: uid,
    deepClone: deepClone,
    isPlainObject: isPlainObject,
    uniqPush: uniqPush,
    debounce: debounce,
    formatBytes: formatBytes,
    formatInterval: formatInterval,
    escapeRegExp: escapeRegExp
  };
});
