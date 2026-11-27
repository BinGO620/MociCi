(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'));
  else { root.Moci = root.Moci || {}; root.Moci.grader = factory(root.Moci.util); }
})(typeof self !== 'undefined' ? self : this, function (util) {
  'use strict';

  var STOP = ('a an the to of in on at for with by from up down out off over into onto about as ' +
    'be is are was were been being do does did done have has had it its this that these those ' +
    'he she they we you i me him her them us my your his their our sb sth oneself one some any ' +
    'no not and or but if so than then there here when where which who whom whose how why all ' +
    'both each few more most other such only own same too very just can could will would shall ' +
    'should may might must').split(' ');

  /** Display/grading normalization: NFKC, lowercase, quotes/dashes, zero-width, whitespace. */
  function normalizeAnswer(s) {
    var t = String(s == null ? '' : s);
    if (t.normalize) t = t.normalize('NFKC');
    t = util.stripZeroWidth(t);
    t = t.replace(/\u00A0/g, ' ');
    t = t.replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'");
    t = t.replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');
    t = t.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-');
    t = t.toLowerCase();
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  function judgeTyped(input, answer) {
    var a = normalizeAnswer(input);
    var b = normalizeAnswer(answer);
    return { correct: a.length > 0 && a === b, normalized: a, expected: b };
  }

  function lettersOnly(s) {
    return normalizeAnswer(s).replace(/[^a-z0-9]/g, '');
  }

  /**
   * AI handwriting leniency, and only here: when the model marked an answer wrong
   * but the written text equals the answer once spaces/punctuation are removed,
   * treat it as correct. Real spelling and preposition errors still fail.
   */
  function applyHandwritingExemption(wrote, answer, aiCorrect) {
    if (aiCorrect) return { correct: true, exempted: false };
    var w = lettersOnly(wrote);
    var a = lettersOnly(answer);
    if (w && a && w === a) return { correct: true, exempted: true };
    return { correct: false, exempted: false };
  }

  /** Classifies a wrong answer as a spelling slip or a meaning mix-up. */
  function classifyError(wrote, answer) {
    var w = lettersOnly(wrote);
    var a = lettersOnly(answer);
    if (!w || !a) return '词义混淆';
    var d = util.levenshtein(w, a);
    var ratio = d / Math.max(w.length, a.length);
    if (d <= 1 || ratio <= 0.34) return '拼写易错';
    return '词义混淆';
  }

  /**
   * Which word should receive the error tag for a wrong phrase question?
   * owner key first (it always exists), then the longest content word that is
   * present in the wordbook, then the owner.
   */
  function coreWordForPhrase(phraseEn, ownerKey, knownKeys) {
    var owner = util.wordKey(ownerKey);
    var tokens = String(phraseEn || '').toLowerCase().match(/[a-z][a-z'\-]*/g) || [];
    var content = [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (STOP.indexOf(t) >= 0) continue;
      if (t.length < 3) continue;
      if (t === owner) return owner;
      content.push(t);
    }
    var known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys || []);
    content.sort(function (a, b) { return b.length - a.length; });
    for (var j = 0; j < content.length; j++) {
      if (known.has(content[j])) return content[j];
    }
    return owner;
  }

  /** Inflection suggestions; purely heuristic and never applied automatically. */
  function baseCandidates(word) {
    var w = (word || '').toLowerCase();
    var out = [];
    function add(x) { if (x && x.length >= 2 && x !== w && out.indexOf(x) < 0) out.push(x); }
    if (/ies$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/ied$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/es$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
    if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
    if (/ying$/.test(w)) add(w.slice(0, -4) + 'ie');
    if (/ing$/.test(w)) {
      var stem = w.slice(0, -3);
      add(stem);
      add(stem + 'e');
      if (/([b-df-hj-np-tv-z])\1$/.test(stem)) add(stem.slice(0, -1));
    }
    if (/ed$/.test(w)) {
      var s2 = w.slice(0, -2);
      add(s2);
      add(w.slice(0, -1));
      if (/([b-df-hj-np-tv-z])\1$/.test(s2)) add(s2.slice(0, -1));
    }
    return out;
  }

  /**
   * Final verdict for one AI-graded item, in priority order:
   *  1. transcription equals the answer (spacing aside) -> correct
   *  2. letters-only equal -> correct, flagged as the handwriting space exemption
   *  3. the model said correct but the letters really differ -> wrong (the model
   *     auto-corrected a misspelling while transcribing)
   *  4. otherwise trust the model's judgement
   */
  function reconcileAiVerdict(wrote, answer, aiCorrect) {
    var w = normalizeAnswer(wrote);
    var a = normalizeAnswer(answer);
    if (!a) return { correct: false, exempted: false, note: 'no-answer' };
    if (!w) return { correct: false, exempted: false, note: 'empty' };

    if (w === a) return { correct: true, exempted: false, note: 'text-equal' };

    var lettersOnlyEqual = lettersOnly(wrote) === lettersOnly(answer);
    if (lettersOnlyEqual) return { correct: true, exempted: true, note: 'space-exempt' };

    if (aiCorrect) return { correct: false, exempted: false, note: 'transcription-mismatch' };
    return { correct: false, exempted: false, note: '' };
  }

  return {
    STOP: STOP,
    normalizeAnswer: normalizeAnswer,
    judgeTyped: judgeTyped,
    lettersOnly: lettersOnly,
    applyHandwritingExemption: applyHandwritingExemption,
    reconcileAiVerdict: reconcileAiVerdict,
    classifyError: classifyError,
    coreWordForPhrase: coreWordForPhrase,
    baseCandidates: baseCandidates
  };
});
