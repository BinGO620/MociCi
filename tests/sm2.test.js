'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SM2 = require('../app/src/main/assets/js/sm2.js');
const util = require('../app/src/main/assets/js/util.js');

const T0 = new Date(2026, 0, 1, 9, 0, 0).getTime(); // local 2026-01-01 09:00

test('sm2: first correct answer schedules 1 day from now', () => {
  const p = SM2.review(SM2.defaults(), true, T0);
  assert.equal(p.reps, 1);
  assert.equal(p.interval, 1);
  assert.equal(p.seen, true);
  assert.equal(p.pass, false);
  assert.equal(p.streak, 1);
  assert.equal(p.ef, 2.6);
  assert.equal(p.due, util.addDays(T0, 1));
});

test('sm2: second correct answer schedules 6 days', () => {
  let p = SM2.review(SM2.defaults(), true, T0);
  p = SM2.review(p, true, p.due);
  assert.equal(p.reps, 2);
  assert.equal(p.interval, 6);
});

test('sm2: third answer multiplies by the pre-update EF', () => {
  let p = SM2.review(SM2.defaults(), true, T0);
  p = SM2.review(p, true, p.due);
  const beforeEf = p.ef;
  p = SM2.review(p, true, p.due);
  assert.equal(p.interval, Math.round(6 * beforeEf));
  assert.equal(p.reps, 3);
});

test('sm2: intervals grow without shrinking over ten reviews', () => {
  let p = SM2.defaults();
  const intervals = [];
  let now = T0;
  for (let i = 0; i < 10; i++) {
    p = SM2.review(p, true, now);
    intervals.push(p.interval);
    now = p.due;
  }
  for (let i = 1; i < intervals.length; i++) {
    assert.ok(intervals[i] >= intervals[i - 1], intervals.join(','));
  }
  assert.ok(intervals[intervals.length - 1] > intervals[0]);
});

test('sm2: wrong answer resets reps and streak, retries tomorrow', () => {
  let p = SM2.review(SM2.defaults(), true, T0);
  p = SM2.review(p, true, p.due);
  const p2 = SM2.review(p, false, T0 + 1000);
  assert.equal(p2.reps, 0);
  assert.equal(p2.interval, 0);
  assert.equal(p2.streak, 0);
  assert.equal(p2.due, util.addDays(T0 + 1000, 1));
  assert.equal(p2.lapses, 1);
  assert.equal(p2.pass, false);
  assert.equal(p2.wrongCount, 1);
  assert.equal(p2.lastWrongAt, T0 + 1000);
});

test('sm2: EF floor is 1.3 no matter how many failures', () => {
  let p = SM2.defaults();
  for (let i = 0; i < 20; i++) p = SM2.review(p, false, T0 + i);
  assert.equal(p.ef, 1.3);
});

test('sm2: interval 0 after a lapse means the next success is 1 day', () => {
  let p = SM2.review(SM2.review(SM2.defaults(), true, T0), false, T0);
  p = SM2.review(p, true, T0 + 600000);
  assert.equal(p.interval, 1);
});

test('sm2: mastered when interval reaches 21 days or more', () => {
  let p = SM2.defaults();
  let now = T0;
  let guard = 0;
  while (p.interval < 21 && guard++ < 20) {
    p = SM2.review(p, true, now);
    now = p.due;
  }
  assert.ok(p.interval >= 21);
  assert.equal(p.pass, true);
  assert.equal(SM2.bucket(p), 'mastered');
});

test('sm2: interval capped at 365 days', () => {
  let p = SM2.defaults();
  let now = T0;
  for (let i = 0; i < 40; i++) {
    p = SM2.review(p, true, now);
    now = p.due;
  }
  assert.ok(p.interval <= 365);
});

test('sm2: due uses now + interval days across the month boundary', () => {
  const endOfMonth = new Date(2026, 0, 31, 23, 30).getTime();
  const p = SM2.review(SM2.defaults(), true, endOfMonth);
  assert.equal(p.due, util.addDays(endOfMonth, 1));
  assert.equal(new Date(p.due).getMonth(), 1);
  assert.equal(new Date(p.due).getDate(), 1);
});

test('sm2: isDue respects seen and due', () => {
  assert.equal(SM2.isDue({ seen: false, due: 0 }, T0), false);
  assert.equal(SM2.isDue({ seen: true, due: T0 }, T0), true);
  assert.equal(SM2.isDue({ seen: true, due: T0 + 1 }, T0), false);
});

test('sm2: normalizeProgress repairs missing and inverted values', () => {
  const p = SM2.normalizeProgress({ ef: 0.5, reps: -3, interval: -1, seen: true });
  assert.equal(p.ef, 1.3);
  assert.equal(p.reps, 0);
  assert.equal(p.interval, 0);
  assert.equal(p.seen, true);
  assert.equal(p.pass, false);
  assert.equal(p.wrongCount, 0);
  assert.equal(p.lastWrongAt, 0);
});

test('sm2: legacy minute interval migrated back to 0 days', () => {
  const legacy = { ef: 2.2, reps: 0, interval: 5, due: T0 + 300000, lapses: 2, seen: true, pass: false, last: T0 };
  assert.equal(SM2.looksLikeLegacyMinuteInterval(legacy), true);
  const p = SM2.normalizeProgress({ ...legacy, interval: 0 });
  assert.equal(p.interval, 0);
  assert.equal(p.due, T0 + 300000);
});

test('sm2: legacy detector ignores genuine 5-day intervals', () => {
  const p = { interval: 5, reps: 2, due: T0 + 5 * 86400000, last: T0 };
  assert.equal(SM2.looksLikeLegacyMinuteInterval(p), false);
});

test('sm2: interval is always an integer number of days', () => {
  let p = SM2.defaults();
  let now = T0;
  for (let i = 0; i < 15; i++) {
    p = SM2.review(p, true, now);
    assert.equal(p.interval, Math.round(p.interval));
    now = p.due;
  }
});

test('sm2: review does not mutate the input progress', () => {
  const p = SM2.normalizeProgress(SM2.defaults());
  const snapshot = JSON.stringify(p);
  SM2.review(p, true, T0);
  SM2.review(p, false, T0);
  assert.equal(JSON.stringify(p), snapshot);
});

test('sm2: bucket classifies new, learning and mastered', () => {
  assert.equal(SM2.bucket(SM2.defaults()), 'new');
  assert.equal(SM2.bucket(SM2.review(SM2.defaults(), true, T0)), 'learning');
  assert.equal(SM2.bucket({ seen: true, pass: true, interval: 21 }), 'mastered');
});

test('sm2: mastery requires a 3-answer streak, not just a long interval', () => {
  let p = { ef: 2.5, reps: 5, interval: 30, due: T0, lapses: 0, seen: true, pass: false, last: T0, wrongCount: 0, lastWrongAt: 0, streak: 0 };
  p = SM2.review(p, true, T0);          // streak 1
  assert.equal(p.pass, false);
  p = SM2.review(p, true, p.due);       // streak 2
  assert.equal(p.pass, false);
  p = SM2.review(p, true, p.due);       // streak 3
  assert.equal(p.streak, 3);
  assert.equal(p.pass, true);
  assert.ok(p.interval >= 21);
});

test('sm2: interval is capped at 180 days', () => {
  let p = SM2.defaults();
  let now = T0;
  for (let i = 0; i < 40; i++) {
    p = SM2.review(p, true, now);
    now = p.due;
  }
  assert.equal(p.interval, 180);
  assert.ok(p.interval <= 180);
});

test('sm2: a lapse revokes mastery even when previously passed', () => {
  let p = { ef: 2.5, reps: 6, interval: 60, due: T0, lapses: 0, seen: true, pass: true, last: T0, wrongCount: 0, lastWrongAt: 0, streak: 3 };
  p = SM2.review(p, false, T0);
  assert.equal(p.pass, false);
  assert.equal(p.streak, 0);
  assert.equal(p.ef, 2.18);
});

test('sm2: normalizeProgress refuses mastery without streak', () => {
  const p = SM2.normalizeProgress({ ef: 2.5, reps: 5, interval: 30, seen: true, pass: true, streak: 1 });
  assert.equal(p.pass, false);
});

test('sm2: normalizeProgress keeps mastery with streak and interval', () => {
  const p = SM2.normalizeProgress({ ef: 2.5, reps: 5, interval: 30, seen: true, pass: true, streak: 3 });
  assert.equal(p.pass, true);
});

test('sm2: normalizeProgress clamps legacy 365-day intervals to 180', () => {
  const p = SM2.normalizeProgress({ seen: true, interval: 365, streak: 9, pass: true });
  assert.equal(p.interval, 180);
});

test('sm2: old records without streak default to 0 and lose pass', () => {
  const p = SM2.normalizeProgress({ seen: true, interval: 30, pass: true });
  assert.equal(p.streak, 0);
  assert.equal(p.pass, false);
});

test('sm2: streak increments across consecutive correct answers', () => {
  let p = SM2.defaults();
  let now = T0;
  const streaks = [];
  for (let i = 0; i < 5; i++) {
    p = SM2.review(p, true, now);
    streaks.push(p.streak);
    now = p.due;
  }
  assert.deepEqual(streaks, [1, 2, 3, 4, 5]);
});
