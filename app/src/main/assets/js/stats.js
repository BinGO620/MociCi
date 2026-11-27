(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'));
  else { root.Moci = root.Moci || {}; root.Moci.stats = factory(root.Moci.util); }
})(typeof self !== 'undefined' ? self : this, function (util) {
  'use strict';

  function empty() {
    return {
      version: 1,
      updatedAt: util.nowIso(),
      tempPhraseWrong: 0,
      days: {},
      sessions: []
    };
  }

  function migrate(input) {
    if (!input || typeof input !== 'object') return empty();
    var out = empty();
    out.tempPhraseWrong = Number(input.tempPhraseWrong) || 0;
    out.updatedAt = typeof input.updatedAt === 'string' ? input.updatedAt : util.nowIso();
    var days = input.days && typeof input.days === 'object' ? input.days : {};
    Object.keys(days).forEach(function (k) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
      var d = days[k] || {};
      out.days[k] = {
        answered: Number(d.answered) || 0,
        correct: Number(d.correct) || 0,
        sessions: Number(d.sessions) || 0,
        newWords: Number(d.newWords) || 0,
        reviewed: Number(d.reviewed) || 0,
        tempAnswered: Number(d.tempAnswered) || 0,
        tempCorrect: Number(d.tempCorrect) || 0
      };
    });
    out.sessions = Array.isArray(input.sessions) ? input.sessions.filter(function (s) {
      return s && typeof s === 'object' && typeof s.at === 'string';
    }).slice(-200) : [];
    return out;
  }

  function dayBucket(stats, ts) {
    var key = util.localDateKey(ts);
    if (!stats.days[key]) {
      stats.days[key] = {
        answered: 0, correct: 0, sessions: 0, newWords: 0, reviewed: 0,
        tempAnswered: 0, tempCorrect: 0
      };
    }
    return stats.days[key];
  }

  /**
   * Records one finished dictation. `perWord` aggregates question results by
   * word key; a word counts as reviewed once, and as new only if it was unseen
   * before this session.
   */
  function recordSession(stats, input, now) {
    now = now || Date.now();
    var out = migrate(stats);
    var bucket = dayBucket(out, now);
    var type = input.type === 'temp' ? 'temp' : 'learn';
    var total = Number(input.total) || 0;
    var correct = Number(input.correct) || 0;

    if (type === 'temp') {
      bucket.tempAnswered += total;
      bucket.tempCorrect += correct;
      out.tempPhraseWrong += (total - correct);
    } else {
      bucket.answered += total;
      bucket.correct += correct;
      bucket.sessions += 1;
      bucket.newWords += Number(input.newWords) || 0;
      bucket.reviewed += Number(input.reviewed) || 0;
    }

    var session = { at: new Date(now).toISOString(), type: type, total: total, correct: correct };
    if (type === 'temp') session.tempCorrect = correct;
    out.sessions.push(session);
    if (out.sessions.length > 200) out.sessions = out.sessions.slice(-200);
    out.updatedAt = new Date(now).toISOString();
    return out;
  }

  function todayStats(stats, now) {
    var key = util.localDateKey(now == null ? Date.now() : now);
    var d = stats && stats.days ? stats.days[key] : null;
    return d || { answered: 0, correct: 0, sessions: 0, newWords: 0, reviewed: 0, tempAnswered: 0, tempCorrect: 0 };
  }

  /** Consecutive days ending today (or yesterday, if today is still empty). */
  function streaks(stats, now) {
    now = now || Date.now();
    var days = stats && stats.days ? stats.days : {};
    var keys = Object.keys(days).filter(function (k) { return days[k] && days[k].answered > 0; }).sort();
    if (!keys.length) return { current: 0, longest: 0, totalDays: 0 };

    var longest = 0, run = 0, prev = null;
    keys.forEach(function (k) {
      var d = util.parseDateKey(k).getTime();
      if (prev != null && Math.round((d - prev) / 86400000) === 1) run += 1;
      else run = 1;
      longest = Math.max(longest, run);
      prev = d;
    });

    var cursor = new Date(now);
    cursor.setHours(0, 0, 0, 0);
    if (!days[util.localDateKey(cursor.getTime())] || days[util.localDateKey(cursor.getTime())].answered === 0) {
      cursor.setDate(cursor.getDate() - 1);
    }
    var current = 0;
    while (true) {
      var k = util.localDateKey(cursor.getTime());
      if (!days[k] || days[k].answered <= 0) break;
      current += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return { current: current, longest: longest, totalDays: keys.length };
  }

  function lastDays(stats, count, now) {
    now = now || Date.now();
    var out = [];
    var cursor = new Date(now);
    cursor.setHours(0, 0, 0, 0);
    for (var i = count - 1; i >= 0; i--) {
      var d = new Date(cursor.getTime());
      d.setDate(d.getDate() - i);
      var key = util.localDateKey(d.getTime());
      var raw = stats && stats.days ? stats.days[key] : null;
      var answered = raw ? raw.answered : 0;
      var correct = raw ? raw.correct : 0;
      out.push({
        date: key,
        answered: answered,
        correct: correct,
        rate: answered > 0 ? correct / answered : null,
        low: answered > 0 && correct / answered < 0.6,
        newWords: raw ? raw.newWords : 0,
        reviewed: raw ? raw.reviewed : 0
      });
    }
    return out;
  }

  return {
    empty: empty,
    migrate: migrate,
    dayBucket: dayBucket,
    recordSession: recordSession,
    todayStats: todayStats,
    streaks: streaks,
    lastDays: lastDays
  };
});
