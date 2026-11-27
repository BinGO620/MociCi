(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'), require('./sm2.js'));
  else { root.Moci = root.Moci || {}; root.Moci.selector = factory(root.Moci.util, root.Moci.sm2); }
})(typeof self !== 'undefined' ? self : this, function (util, sm2) {
  'use strict';

  var GROUP_SIZE = 15;
  var REVIEW_NEW = 8;
  var NEW_WORDS = 7;
  var DICTATION_PHRASE_TARGET = 7;
  var DICTATION_PHRASE_MIN = 6;

  /** Deterministic shuffle so tests can pin the order. */
  function shuffle(list, seed) {
    var arr = list.slice();
    var s = seed == null ? 20260101 : seed >>> 0;
    function rnd() {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    }
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /**
   * Scope is intentionally overlapping for "wrong"/"due": a word can be both a
   * wrong word and due. "new"/"learning"/"mastered" are mutually exclusive and
   * come from the SM-2 bucket, so seen words never appear under "new".
   */
  function inScope(w, scope, now) {
    if (!scope || scope === 'all') return true;
    if (scope === 'due') return sm2.isDue(w.progress, now);
    if (scope === 'wrong') return (w.tags || []).length > 0;
    if (scope === 'new') return sm2.isNew(w.progress);
    if (scope === 'learning') return sm2.isLearning(w.progress);
    if (scope === 'mastered') return sm2.isMastered(w.progress);
    return true;
  }

  /**
   * Builds one 15-card group: up to 8 due reviews + up to 7 new words. A short
   * side is filled from the other side, then from not-yet-due old words in due
   * order. Only when the scope holds fewer than 15 words is the group smaller.
   */
  function selectLearnGroup(book, opts) {
    opts = opts || {};
    var now = opts.now == null ? Date.now() : opts.now;
    var scope = opts.scope || 'all';
    var groupSize = Math.max(1, Number(opts.groupSize) || GROUP_SIZE);
    var newTarget = Math.max(0, Math.min(groupSize, opts.newPerDay == null ? NEW_WORDS : Number(opts.newPerDay)));
    var reviewTarget = groupSize - newTarget;
    var words = util.isPlainObject(book.words) ? book.words : {};
    // A word with no Chinese meaning can only be dictated blind, so it never
    // enters a dictation queue (it still appears on study cards).
    var all = Object.keys(words).map(function (k) { return words[k]; })
      .filter(function (w) { return inScope(w, scope, now); })
      .filter(function (w) { return !opts.requireMeaning || !!String(w.zh || '').trim(); });

    var due = all.filter(function (w) { return sm2.isDue(w.progress, now); });
    var fresh = all.filter(function (w) { return sm2.isNew(w.progress); });
    var rest = all.filter(function (w) {
      return !sm2.isDue(w.progress, now) && !sm2.isNew(w.progress);
    });

    due.sort(function (a, b) { return (a.progress.due - b.progress.due) || (a.createdAt - b.createdAt); });
    fresh.sort(function (a, b) { return (a.createdAt - b.createdAt) || a.en.localeCompare(b.en); });
    rest.sort(function (a, b) { return (a.progress.due - b.progress.due) || (a.createdAt - b.createdAt); });

    var pickedReview = due.slice(0, reviewTarget);
    var pickedNew = fresh.slice(0, newTarget);
    var used = {};
    pickedReview.concat(pickedNew).forEach(function (w) { used[util.wordKey(w.en)] = true; });

    function take(pool, limit, out) {
      for (var i = 0; i < pool.length && out.length < limit; i++) {
        var k = util.wordKey(pool[i].en);
        if (used[k]) continue;
        used[k] = true;
        out.push(pool[i]);
      }
    }

    if (pickedNew.length < newTarget) take(due, newTarget, pickedNew);
    // Reviews may borrow from the new pool, but never the reverse when the user
    // explicitly set newPerDay to 0: that means a pure review session.
    if (pickedReview.length < reviewTarget && newTarget > 0) take(fresh, reviewTarget, pickedReview);
    var cards;
    if (pickedReview.length + pickedNew.length < groupSize) {
      var fillers = [];
      var restPool = newTarget > 0 ? rest : rest.concat(due.filter(function (w) {
        return pickedReview.indexOf(w) < 0;
      }));
      take(restPool, groupSize - pickedReview.length - pickedNew.length, fillers);
      cards = pickedReview.concat(pickedNew, fillers);
    } else {
      cards = pickedReview.concat(pickedNew);
    }

    var out = cards.map(function (w) {
      var isNew = sm2.isNew(w.progress);
      return {
        key: util.wordKey(w.en),
        en: w.en,
        phonetic: w.phonetic || '',
        pos: w.pos || '',
        zh: w.zh || '',
        collo: (w.collo || []).slice(),
        isReview: !isNew,
        isNew: isNew
      };
    });
    return shuffle(out, opts.seed == null ? (opts.seedValue || 7) : opts.seed);
  }

  /**
   * Builds the dictation queue. Every card contributes one question; up to 7
   * cards with collocations become phrase questions (at least 6 when possible).
   */
  function buildDictation(cards, opts) {
    opts = opts || {};
    var seed = opts.seed == null ? 11 : opts.seed;
    // Defensive: no-meaning cards are never dictated, regardless of the caller.
    cards = cards.filter(function (c) { return !!String(c.zh || '').trim(); });
    var withPhrase = cards.filter(function (c) { return (c.collo || []).length > 0; });
    var shuffledPhrase = shuffle(withPhrase, seed);
    var target = Math.min(DICTATION_PHRASE_TARGET, shuffledPhrase.length);
    if (shuffledPhrase.length >= DICTATION_PHRASE_MIN && target < DICTATION_PHRASE_MIN) {
      target = DICTATION_PHRASE_MIN;
    }

    var chosen = {};
    var phrasePicks = [];
    for (var i = 0; i < shuffledPhrase.length && phrasePicks.length < target; i++) {
      chosen[shuffledPhrase[i].key] = true;
      phrasePicks.push(shuffledPhrase[i]);
    }

    var questions = [];
    cards.forEach(function (c) {
      if (chosen[c.key]) {
        var pick = phrasePicks.filter(function (p) { return p.key === c.key; })[0];
        var list = pick.collo.slice();
        var phrase = list[Math.floor((seed + list.length) % list.length)];
        var split = requireSplit(phrase);
        questions.push({
          type: 'phrase',
          key: c.key,
          owner: c.en,
          ownerKey: c.key,
          prompt: split.zh,
          answer: split.en,
          rawPhrase: phrase,
          noMeaning: false
        });
      } else {
        questions.push({
          type: 'word',
          key: c.key,
          owner: c.en,
          ownerKey: c.key,
          prompt: (c.pos ? c.pos + ' ' : '') + (c.zh || ''),
          answer: c.en,
          noMeaning: !c.zh,
          phonetic: c.phonetic || ''
        });
      }
    });
    return shuffle(questions, seed + 1);
  }

  /** Avoids a circular dependency: parser.splitPhraseBody, inlined. */
  function requireSplit(phrase) {
    var s = String(phrase || '').trim();
    var idx = -1;
    for (var i = 0; i < s.length; i++) {
      if (util.hasCJK(s.charAt(i))) { idx = i; break; }
    }
    if (idx < 0) return { en: util.collapseSpaces(s), zh: '' };
    return {
      en: util.collapseSpaces(s.slice(0, idx)),
      zh: util.collapseSpaces(s.slice(idx))
    };
  }

  /** Builds a temporary phrase dictation from hand-picked collocations. */
  function buildTempPhraseQuiz(phrases, seed) {
    return shuffle(phrases.map(function (p) {
      var split = requireSplit(p.raw || p.en);
      return {
        type: 'phrase',
        key: p.id,
        owner: p.owner,
        ownerKey: p.ownerKey,
        prompt: split.zh,
        answer: split.en,
        rawPhrase: p.raw,
        temp: true
      };
    }), seed == null ? 13 : seed);
  }

  return {
    GROUP_SIZE: GROUP_SIZE,
    REVIEW_NEW: REVIEW_NEW,
    NEW_WORDS: NEW_WORDS,
    DICTATION_PHRASE_TARGET: DICTATION_PHRASE_TARGET,
    DICTATION_PHRASE_MIN: DICTATION_PHRASE_MIN,
    shuffle: shuffle,
    inScope: inScope,
    selectLearnGroup: selectLearnGroup,
    buildDictation: buildDictation,
    buildTempPhraseQuiz: buildTempPhraseQuiz,
    splitPhrase: requireSplit
  };
});
