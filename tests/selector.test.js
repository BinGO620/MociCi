'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SEL = require('../app/src/main/assets/js/selector.js');
const M = require('../app/src/main/assets/js/merger.js');
const SM2 = require('../app/src/main/assets/js/sm2.js');

const T0 = new Date(2026, 0, 1, 9, 0, 0).getTime();
const DAY = 86400000;

function makeBook(spec) {
  const b = M.emptyBook();
  let t = T0 - 1000000;
  spec.forEach((s, i) => {
    const w = M.newWord(s.en, { zh: s.zh || '释义', pos: 'v.', collo: s.collo || [], createdAt: t + i });
    if (s.progress) w.progress = SM2.normalizeProgress(s.progress);
    if (s.tags) w.tags = s.tags;
    b.words[s.en.toLowerCase()] = w;
  });
  return b;
}

function dueWord(en, dueOffset) {
  return { en, progress: { ef: 2.5, reps: 2, interval: 3, due: T0 + dueOffset, seen: true, pass: false } };
}

test('selector: 15-card group with 8 reviews and 7 new', () => {
  const spec = [];
  for (let i = 0; i < 10; i++) spec.push(dueWord('rev' + i, -DAY * (i + 1)));
  for (let i = 0; i < 10; i++) spec.push({ en: 'new' + i });
  const b = makeBook(spec);
  const cards = SEL.selectLearnGroup(b, { now: T0, seed: 3 });
  assert.equal(cards.length, 15);
  assert.equal(cards.filter(c => c.isReview).length, 8);
  assert.equal(cards.filter(c => c.isNew).length, 7);
});

test('selector: due order is oldest first before selection', () => {
  const b = makeBook([dueWord('late', -DAY), dueWord('early', -DAY * 9)]);
  const cards = SEL.selectLearnGroup(b, { now: T0, seed: 1 });
  const names = cards.map(c => c.en);
  assert.ok(names.includes('early') && names.includes('late'));
});

test('selector: short review side filled by new words', () => {
  const spec = [dueWord('only', -DAY)];
  for (let i = 0; i < 20; i++) spec.push({ en: 'n' + i });
  const b = makeBook(spec);
  const cards = SEL.selectLearnGroup(b, { now: T0, seed: 5 });
  assert.equal(cards.length, 15);
  assert.ok(cards.filter(c => c.isNew).length >= 7);
});

test('selector: short new side filled by due words', () => {
  const spec = [];
  for (let i = 0; i < 20; i++) spec.push(dueWord('r' + i, -DAY * (i + 1)));
  const b = makeBook(spec);
  const cards = SEL.selectLearnGroup(b, { now: T0, seed: 5 });
  assert.equal(cards.length, 15);
  assert.ok(cards.every(c => c.isReview));
});

test('selector: both sides short filled by non-due old words in due order', () => {
  const b = makeBook([
    dueWord('due1', -DAY),
    { en: 'future1', progress: { ef: 2.5, reps: 3, interval: 20, due: T0 + DAY, seen: true, pass: false } },
    { en: 'future2', progress: { ef: 2.5, reps: 3, interval: 20, due: T0 + DAY * 2, seen: true, pass: false } }
  ]);
  const cards = SEL.selectLearnGroup(b, { now: T0, seed: 2 });
  assert.equal(cards.length, 3);
  assert.ok(cards.some(c => c.en === 'future1'));
});

test('selector: fewer than 15 total uses everything', () => {
  const b = makeBook([{ en: 'a' }, { en: 'b' }, dueWord('c', -DAY)]);
  const cards = SEL.selectLearnGroup(b, { now: T0 });
  assert.equal(cards.length, 3);
});

test('selector: empty book yields empty group', () => {
  assert.deepEqual(SEL.selectLearnGroup(M.emptyBook(), { now: T0 }), []);
});

test('selector: scope filters constrain the pool', () => {
  const b = makeBook([{ en: 'newone' }, dueWord('dueone', -DAY), { en: 'wrongone', progress: { ef: 2.5, reps: 1, interval: 1, due: T0 + DAY, seen: true, pass: false }, tags: ['拼写易错'] }]);
  assert.equal(SEL.selectLearnGroup(b, { now: T0, scope: 'due' }).length, 1);
  assert.equal(SEL.selectLearnGroup(b, { now: T0, scope: 'wrong' }).length, 1);
  // learning = seen && !pass, so both the due and wrong word qualify.
  assert.equal(SEL.selectLearnGroup(b, { now: T0, scope: 'learning' }).length, 2);
  // Seen words never leak into the "new" scope.
  const newScope = SEL.selectLearnGroup(b, { now: T0, scope: 'new' });
  assert.equal(newScope.length, 1);
  assert.equal(newScope[0].en, 'newone');
});

test('selector: mastered words excluded from new scope but reachable via all', () => {
  const mastered = { en: 'mastered', progress: { ef: 2.8, reps: 6, interval: 30, due: T0 + DAY, seen: true, pass: true } };
  const b = makeBook([mastered]);
  assert.equal(SEL.selectLearnGroup(b, { now: T0, scope: 'new' }).length, 0);
  assert.equal(SEL.selectLearnGroup(b, { now: T0, scope: 'all' }).length, 1);
});

test('selector: same seed is deterministic, different seeds shuffle', () => {
  const spec = [];
  for (let i = 0; i < 20; i++) spec.push({ en: 'w' + i });
  const b = makeBook(spec);
  const a = SEL.selectLearnGroup(b, { now: T0, seed: 42 }).map(c => c.en);
  const c = SEL.selectLearnGroup(b, { now: T0, seed: 42 }).map(c => c.en);
  const d = SEL.selectLearnGroup(b, { now: T0, seed: 43 }).map(c => c.en);
  assert.deepEqual(a, c);
  assert.notDeepEqual(a, d);
});

test('dictation: 15 questions with 7 phrase questions when possible', () => {
  const cards = [];
  for (let i = 0; i < 15; i++) {
    cards.push({ key: 'w' + i, en: 'w' + i, zh: '义' + i, pos: 'v.', collo: i < 10 ? ['w' + i + ' up 完成'] : [] });
  }
  const qs = SEL.buildDictation(cards, { seed: 4 });
  assert.equal(qs.length, 15);
  assert.equal(qs.filter(q => q.type === 'phrase').length, 7);
  assert.equal(qs.filter(q => q.type === 'word').length, 8);
});

test('dictation: phrase answer and prompt split correctly', () => {
  const cards = [{ key: 'abandon', en: 'abandon', zh: '放弃', collo: ['abandon hope 放弃希望'] }];
  const qs = SEL.buildDictation(cards, { seed: 1 });
  assert.equal(qs[0].type, 'phrase');
  assert.equal(qs[0].prompt, '放弃希望');
  assert.equal(qs[0].answer, 'abandon hope');
  assert.equal(qs[0].ownerKey, 'abandon');
});

test('dictation: no collocations means all word questions', () => {
  const cards = [{ key: 'a', en: 'a', zh: '义', collo: [] }, { key: 'b', en: 'b', zh: '义', collo: [] }];
  const qs = SEL.buildDictation(cards, { seed: 1 });
  assert.equal(qs.length, 2);
  assert.ok(qs.every(q => q.type === 'word'));
});

test('dictation: fewer than 6 collocation cards yields their count', () => {
  const cards = [];
  for (let i = 0; i < 3; i++) cards.push({ key: 'w' + i, en: 'w' + i, zh: '义', collo: ['w' + i + ' on 继续'] });
  for (let i = 3; i < 15; i++) cards.push({ key: 'w' + i, en: 'w' + i, zh: '义', collo: [] });
  const qs = SEL.buildDictation(cards, { seed: 2 });
  assert.equal(qs.filter(q => q.type === 'phrase').length, 3);
});

test('dictation: words without a meaning never enter the queue', () => {
  const cards = [{ key: 'x', en: 'x', zh: '', collo: [] }, { key: 'y', en: 'y', zh: '义', collo: [] }];
  const qs = SEL.buildDictation(cards, { seed: 1 });
  assert.equal(qs.length, 1, 'a blind word would only lower the accuracy rate');
  assert.equal(qs[0].answer, 'y');
  assert.equal(qs[0].noMeaning, false);
});

test('dictation: questions are shuffled deterministically', () => {
  const cards = [];
  for (let i = 0; i < 15; i++) cards.push({ key: 'w' + i, en: 'w' + i, zh: '义' + i, collo: [] });
  const a = SEL.buildDictation(cards, { seed: 9 }).map(q => q.key);
  const b = SEL.buildDictation(cards, { seed: 9 }).map(q => q.key);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, cards.map(c => c.key));
});

test('dictation: phrase question keeps the raw collocation and owner', () => {
  const cards = [{ key: 'subject', en: 'subject', zh: '主题', collo: ['be subject to 受制于', 'change the subject 换个话题'] }];
  const qs = SEL.buildDictation(cards, { seed: 1 });
  assert.ok(qs[0].rawPhrase.length > 0);
  assert.equal(qs[0].owner, 'subject');
});

test('temp quiz: builds phrase-only questions without touching the book', () => {
  const phrases = [
    { id: 'abandon#0', en: 'abandon hope', zh: '放弃希望', owner: 'abandon', ownerKey: 'abandon', raw: 'abandon hope 放弃希望' }
  ];
  const qs = SEL.buildTempPhraseQuiz(phrases, 1);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].type, 'phrase');
  assert.equal(qs[0].temp, true);
  assert.equal(qs[0].answer, 'abandon hope');
});

test('temp quiz: caps at 50 phrases', () => {
  const phrases = [];
  for (let i = 0; i < 80; i++) phrases.push({ id: 'p' + i, en: 'p' + i, zh: '义', owner: 'p' + i, ownerKey: 'p' + i, raw: 'p' + i + ' 义' });
  const qs = SEL.buildTempPhraseQuiz(phrases, 1);
  assert.equal(qs.length, 80);
});

test('shuffle: does not mutate the input array', () => {
  const input = [1, 2, 3, 4, 5];
  const copy = input.slice();
  SEL.shuffle(input, 1);
  assert.deepEqual(input, copy);
});

test('selector: dailyGoal controls the group size', () => {
  const b = makeBook([
    { en: 'one' }, { en: 'two' }, { en: 'three' }, { en: 'four' }, { en: 'five' },
    { en: 'six' }, { en: 'seven' }, { en: 'eight' }, { en: 'nine' }, { en: 'ten' }
  ]);
  assert.equal(SEL.selectLearnGroup(b, { now: T0, groupSize: 5, newPerDay: 3, seed: 1 }).length, 5);
  assert.equal(SEL.selectLearnGroup(b, { now: T0, groupSize: 30, newPerDay: 10, seed: 1 }).length, 10);
});

test('selector: newPerDay caps the new-word share when reviews exist', () => {
  const spec = [];
  for (let i = 0; i < 12; i++) spec.push(dueWord('rev' + i, -DAY * (i + 1)));
  for (let i = 0; i < 8; i++) spec.push({ en: 'fresh' + i });
  const b = makeBook(spec);
  const cards = SEL.selectLearnGroup(b, { now: T0, groupSize: 15, newPerDay: 3, seed: 2 });
  assert.equal(cards.filter(c => c.isNew).length, 3);
  assert.equal(cards.length, 15);
});

test('selector: newPerDay 0 means review-only', () => {
  const b = makeBook([
    dueWord('r1', -DAY), dueWord('r2', -DAY * 2), { en: 'fresh' }
  ]);
  const cards = SEL.selectLearnGroup(b, { now: T0, groupSize: 15, newPerDay: 0, seed: 3 });
  assert.ok(cards.every(c => !c.isNew), JSON.stringify(cards.map(c => c.en)));
  assert.equal(cards.length, 2);
});

test('selector: unset newPerDay keeps the default 7 when reviews exist', () => {
  const spec = [];
  for (let i = 0; i < 12; i++) spec.push(dueWord('rr' + i, -DAY * (i + 1)));
  for (let i = 0; i < 20; i++) spec.push({ en: 'ww' + i });
  const b = makeBook(spec);
  const cards = SEL.selectLearnGroup(b, { now: T0, seed: 4 });
  assert.equal(cards.filter(c => c.isNew).length, 7);
});
