(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'), require('./grader.js'));
  else { root.Moci = root.Moci || {}; root.Moci.wrongbook = factory(root.Moci.util, root.Moci.grader); }
})(typeof self !== 'undefined' ? self : this, function (util, grader) {
  'use strict';

  var LIMIT = 30;
  var SPELLING = '拼写易错';
  var MEANING = '词义混淆';

  function wrongWords(book) {
    var words = book && book.words ? book.words : {};
    return Object.keys(words).map(function (k) { return words[k]; })
      .filter(function (w) { return (w.tags || []).length > 0; })
      .sort(function (a, b) { return (b.progress.lastWrongAt || 0) - (a.progress.lastWrongAt || 0); });
  }

  function wrongCount(book) {
    return wrongWords(book).length;
  }

  function hasWrongTag(w) {
    return (w.tags || []).indexOf(SPELLING) >= 0 || (w.tags || []).indexOf(MEANING) >= 0;
  }

  /**
   * Eviction order: mastered words first, then fewest wrongs, then oldest last
   * wrong time, then key for determinism.
   */
  function evictionOrder(list) {
    return list.slice().sort(function (a, b) {
      var am = a.progress && a.progress.pass ? 1 : 0;
      var bm = b.progress && b.progress.pass ? 1 : 0;
      if (am !== bm) return bm - am;
      var aw = (a.progress && a.progress.wrongCount) || 0;
      var bw = (b.progress && b.progress.wrongCount) || 0;
      if (aw !== bw) return aw - bw;
      var al = (a.progress && a.progress.lastWrongAt) || 0;
      var bl = (b.progress && b.progress.lastWrongAt) || 0;
      if (al !== bl) return al - bl;
      return a.en.localeCompare(b.en);
    });
  }

  function tagFor(w, kind) {
    var tags = w.tags || (w.tags = []);
    util.uniqPush(tags, kind);
  }

  /** Plans which words would have to lose their wrong tags to stay under 30. */
  function planEviction(book) {
    var list = wrongWords(book);
    if (list.length <= LIMIT) return { evict: [], over: 0 };
    var order = evictionOrder(list);
    return { evict: order.slice(0, list.length - LIMIT), over: list.length - LIMIT };
  }

  /**
   * Records a wrong answer: bumps counters, applies the spelling/meaning tag and
   * evicts overflow. Returns { evicted: [...] } so the UI can explain.
   */
  function markWrong(book, key, wrote, answer, kindOverride, now) {
    now = now || Date.now();
    var w = book.words[key];
    if (!w) return { ok: false };
    var kind = kindOverride || grader.classifyError(wrote, answer);
    tagFor(w, kind);
    w.progress = w.progress || {};
    w.progress.wrongCount = (w.progress.wrongCount || 0) + 1;
    w.progress.lastWrongAt = now;
    var evicted = evictOverflow(book);
    return { ok: true, kind: kind, evicted: evicted };
  }

  function evictOverflow(book) {
    var plan = planEviction(book);
    if (!plan.evict.length) return [];
    var removed = [];
    plan.evict.forEach(function (w) {
      var keep = (w.tags || []).filter(function (t) { return t !== SPELLING && t !== MEANING; });
      w.tags = keep;
      removed.push(w.en);
    });
    return removed;
  }

  /**
   * Manual tagging done by the user. When the book is full the caller must
   * confirm first (see planEviction), because the incoming word would otherwise
   * be the cheapest victim (wrongCount 1).
   */
  function addManualTag(book, key, tag, now) {
    now = now || Date.now();
    var w = book.words[key];
    if (!w) return { ok: false };
    if (wrongWords(book).length >= LIMIT && (w.tags || []).length === 0) {
      var plan = planEviction(book);
      return { needConfirm: true, wouldEvict: plan.evict.length ? plan.evict[0].en : null, plan: plan };
    }
    util.uniqPush(w.tags, tag);
    w.progress = w.progress || {};
    w.progress.wrongCount = Math.max(1, w.progress.wrongCount || 0);
    w.progress.lastWrongAt = now;
    var evicted = evictOverflow(book);
    return { ok: true, evicted: evicted };
  }

  function classify(key, wrong) {
    var map = {};
    wrong.forEach(function (w) {
      var wd = w.en;
      map[wd] = grader.classifyError(wd, key);
    });
    return map;
  }

  return {
    LIMIT: LIMIT,
    SPELLING: SPELLING,
    MEANING: MEANING,
    wrongWords: wrongWords,
    wrongCount: wrongCount,
    hasWrongTag: hasWrongTag,
    evictionOrder: evictionOrder,
    planEviction: planEviction,
    markWrong: markWrong,
    evictOverflow: evictOverflow,
    addManualTag: addManualTag,
    classify: classify
  };
});
