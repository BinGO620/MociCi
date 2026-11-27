(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'));
  else { root.Moci = root.Moci || {}; root.Moci.sm2 = factory(root.Moci.util); }
})(typeof self !== 'undefined' ? self : this, function (util) {
  'use strict';

  function defaults() {
    return {
      ef: 2.5, reps: 0, interval: 0, due: 0, lapses: 0,
      seen: false, pass: false, last: 0, wrongCount: 0, lastWrongAt: 0,
      streak: 0
    };
  }

  var MAX_INTERVAL_DAYS = 180;
  var PASS_STREAK = 3;

  function normalizeProgress(p) {
    var out = defaults();
    if (!p || typeof p !== 'object') return out;
    var keys = ['ef', 'reps', 'interval', 'due', 'lapses', 'last', 'wrongCount', 'lastWrongAt', 'streak'];
    for (var i = 0; i < keys.length; i++) {
      var v = Number(p[keys[i]]);
      if (isFinite(v)) out[keys[i]] = v;
    }
    out.seen = !!p.seen;
    out.pass = !!p.pass;
    if (out.ef < 1.3) out.ef = 1.3;
    if (out.reps < 0) out.reps = 0;
    if (out.streak < 0) out.streak = 0;
    if (out.interval < 0) out.interval = 0;
    if (out.interval > MAX_INTERVAL_DAYS) out.interval = MAX_INTERVAL_DAYS;
    // Mastery requires a sustained streak, not just a long interval.
    out.pass = out.pass && out.streak >= PASS_STREAK && out.interval >= 21;
    return out;
  }

  /**
   * SM-2 with day-based intervals. `interval` is always days; a wrong answer
   * resets the streak and schedules the word for the next day (in-session retry
   * is handled by the dictation flow, not by a five-minute due hack).
   */
  function review(p, correct, now) {
    var cur = normalizeProgress(p);
    now = now || Date.now();
    var next = {
      ef: cur.ef, reps: cur.reps, interval: cur.interval, due: cur.due,
      lapses: cur.lapses, seen: true, pass: cur.pass, last: now,
      wrongCount: cur.wrongCount, lastWrongAt: cur.lastWrongAt, streak: cur.streak
    };
    if (!correct) {
      next.ef = Math.max(1.3, round2(cur.ef - 0.32));
      next.reps = 0;
      next.lapses = cur.lapses + 1;
      next.interval = 0;
      next.due = util.addDays(now, 1);
      next.pass = false;
      next.wrongCount = cur.wrongCount + 1;
      next.lastWrongAt = now;
      next.streak = 0;
      return next;
    }
    var interval;
    if (cur.reps === 0) interval = 1;
    else if (cur.reps === 1) interval = 6;
    else interval = Math.round(cur.interval * cur.ef);
    if (!isFinite(interval) || interval < 1) interval = 1;
    if (interval > MAX_INTERVAL_DAYS) interval = MAX_INTERVAL_DAYS;
    next.interval = interval;
    next.ef = cur.ef + 0.1;
    next.reps = cur.reps + 1;
    next.streak = cur.streak + 1;
    next.pass = next.streak >= PASS_STREAK && interval >= 21;
    next.due = util.addDays(now, interval);
    return next;
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function isNew(p) { return !p || !p.seen; }
  function isMastered(p) { return !!p && !!p.pass; }
  function isLearning(p) { return !!p && !!p.seen && !p.pass; }
  function isDue(p, now) { return !!p && !!p.seen && Number(p.due) <= (now || Date.now()); }

  function bucket(p) {
    if (isNew(p)) return 'new';
    if (isMastered(p)) return 'mastered';
    return 'learning';
  }

  /** Exposed for migration: detects the legacy "5 minutes stored as 5" sentinel. */
  function looksLikeLegacyMinuteInterval(p) {
    if (!p || typeof p !== 'object') return false;
    if (Number(p.interval) !== 5) return false;
    if (Number(p.reps) !== 0) return false;
    if (!Number(p.due) || !Number(p.last)) return false;
    var delta = Number(p.due) - Number(p.last);
    return delta > 0 && delta <= 6 * 60 * 1000;
  }

  return {
    defaults: defaults,
    normalizeProgress: normalizeProgress,
    review: review,
    isNew: isNew,
    isMastered: isMastered,
    isLearning: isLearning,
    isDue: isDue,
    bucket: bucket,
    looksLikeLegacyMinuteInterval: looksLikeLegacyMinuteInterval
  };
});
