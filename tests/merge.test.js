'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../app/src/main/assets/js/merger.js');
const SM2 = require('../app/src/main/assets/js/sm2.js');
const P = require('../app/src/main/assets/js/parser.js');
const S = require('../app/src/main/assets/js/storage.js');
const St = require('../app/src/main/assets/js/store.js');

const T0 = new Date(2026, 0, 1, 9, 0, 0).getTime();

function newStore(now) {
  const t = now == null ? T0 : now;
  return St.create(S.memoryAdapter(), { now: () => t });
}

function importText(store, text, now) {
  const at = now == null ? T0 : now;
  const parsed = P.parse(text);
  const plan = M.buildPlan(store.loadBook(), parsed, { now: at });
  return store.commitPlan(plan, {}, { now: at, mode: parsed.mode, source: 'paste' });
}

function bookFrom(text) {
  const parsed = P.parse(text);
  const plan = M.buildPlan(M.emptyBook(), parsed, { now: T0 });
  return M.applyPlan(M.emptyBook(), plan, {}, { now: T0 });
}

test('merge: empty book schema', () => {
  const b = M.emptyBook();
  assert.equal(b.version, 2);
  assert.deepEqual(b.words, {});
  assert.deepEqual(b.imports, []);
});

test('merge: new word gets defaults and import source', () => {
  const b = bookFrom('abandon /əˈbændən/ v. 放弃\n- abandon hope 放弃希望');
  const w = b.words.abandon;
  assert.equal(w.en, 'abandon');
  assert.deepEqual(w.collo, ['abandon hope 放弃希望']);
  assert.equal(w.progress.reps, 0);
  assert.equal(w.progress.seen, false);
  assert.ok(w.src.startsWith('import-'));
  assert.deepEqual(w.srcs, [w.src]);
  assert.equal(b.imports.length, 1);
  assert.equal(b.imports[0].added, 1);
});

test('merge: same-batch createdAt strictly increases', () => {
  const b = bookFrom('abandon v. 放弃\nability n. 能力\nsubject n. 主题');
  const times = Object.values(b.words).map(w => w.createdAt);
  const uniq = new Set(times);
  assert.equal(uniq.size, times.length);
  assert.ok(b.words.abandon.createdAt < b.words.ability.createdAt);
});

test('merge: preview counts added vs ignored meanings vs unchanged', () => {
  const first = bookFrom('abandon v. 放弃\nability n. 能力');
  const parsed = P.parse('abandon v. 放弃；抛弃\nability n. 能力\nsubject n. 主题');
  const plan = M.buildPlan(first, parsed, { now: T0 });
  assert.equal(plan.counts.added, 1, 'only subject is new');
  assert.equal(plan.counts.unchanged, 2, 'differing meaning is ignored, not updated');
  assert.equal(plan.counts.addable, 1);
  assert.equal(plan.updated.length, 0, 'no conflict group exists anymore');
});

test('merge: differing meaning on re-import never replaces the original', () => {
  const first = bookFrom('abandon v. 放弃');
  const parsed = P.parse('abandon v. 抛弃');
  const plan = M.buildPlan(first, parsed, { now: T0 });
  assert.equal(plan.updated.length, 0);
  const next = M.applyPlan(first, plan, {}, { now: T0 });
  assert.equal(next.words.abandon.zh, '放弃');
});

test('merge: progress never overwritten by imports', () => {
  let b = bookFrom('abandon v. 放弃');
  b.words.abandon.progress = SM2.review(SM2.defaults(), true, T0);
  const snapshot = JSON.stringify(b.words.abandon.progress);
  const parsed = P.parse('abandon v. 抛弃\n- abandon hope 放弃希望');
  const plan = M.buildPlan(b, parsed, { now: T0 });
  const next = M.applyPlan(b, plan, {}, { now: T0 });
  assert.equal(JSON.stringify(next.words.abandon.progress), snapshot);
});

test('merge: phonetic filled only when missing', () => {
  const b = bookFrom('abandon v. 放弃');
  const parsed = P.parse('abandon /əˈbændən/ v. 放弃');
  const plan = M.buildPlan(b, parsed, { now: T0 });
  assert.equal(plan.counts.phoneticFixes, 1);
  const next = M.applyPlan(b, plan, {}, { now: T0 });
  assert.equal(next.words.abandon.phonetic, 'əˈbændən');
});

test('merge: existing phonetic is not replaced', () => {
  const b = bookFrom('abandon /əˈbændən/ v. 放弃');
  const parsed = P.parse('abandon /ˈæbəndən/ v. 放弃');
  const plan = M.buildPlan(b, parsed, { now: T0 });
  assert.equal(plan.counts.phoneticFixes, 0);
  const next = M.applyPlan(b, plan, {}, { now: T0 });
  assert.equal(next.words.abandon.phonetic, 'əˈbændən');
});

test('merge: collocations union with folded dedupe', () => {
  const b = bookFrom('abandon v. 放弃\n- abandon hope 放弃希望');
  const parsed = P.parse('abandon v. 放弃\n- abandon hope 放弃希望\n- abandon oneself to 沉溺于');
  const plan = M.buildPlan(b, parsed, { now: T0 });
  assert.equal(plan.counts.colloFixes, 1);
  const next = M.applyPlan(b, plan, {}, { now: T0 });
  assert.equal(next.words.abandon.collo.length, 2);
});

test('merge: tags union', () => {
  const b = bookFrom('abandon v. 放弃\n- x 好');
  b.words.abandon.tags = ['拼写易错'];
  const parsed = P.parse('abandon v. 放弃');
  parsed.entries[0].tags = ['词义混淆'];
  const plan = M.buildPlan(b, parsed, { now: T0 });
  const next = M.applyPlan(b, plan, {}, { now: T0 });
  assert.deepEqual(next.words.abandon.tags, ['拼写易错', '词义混淆']);
});

test('merge: empty meaning in new import keeps existing', () => {
  const b = bookFrom('abandon v. 放弃');
  const parsed = P.parse('abandon');
  const plan = M.buildPlan(b, parsed, { now: T0 });
  assert.equal(plan.counts.updated, 0);
  const next = M.applyPlan(b, plan, {}, { now: T0 });
  assert.equal(next.words.abandon.zh, '放弃');
});

test('merge: srcs accumulate across imports', () => {
  const b1 = bookFrom('abandon v. 放弃');
  const src1 = b1.words.abandon.src;
  const parsed2 = P.parse('abandon v. 放弃\n- abandon hope 放弃希望');
  const plan2 = M.buildPlan(b1, parsed2, { now: T0 + 1000, src: 'import-2' });
  const b2 = M.applyPlan(b1, plan2, {}, { now: T0 + 1000 });
  assert.deepEqual(b2.words.abandon.srcs, [src1, 'import-2']);
  assert.equal(b2.words.abandon.src, 'import-2');
});

test('merge: filter by src matches any past batch', () => {
  const b1 = bookFrom('abandon v. 放弃');
  const src1 = b1.words.abandon.src;
  const plan2 = M.buildPlan(b1, P.parse('abandon v. 放弃\n- abandon hope 放弃希望'), { now: T0 + 1000, src: 'import-2' });
  const b2 = M.applyPlan(b1, plan2, {}, { now: T0 + 1000 });
  assert.equal(M.searchWords(b2, '', { src: src1 }).length, 1);
  assert.equal(M.searchWords(b2, '', { src: 'import-2' }).length, 1);
  assert.equal(M.searchWords(b2, '', { src: 'nope' }).length, 0);
});

test('merge: import record carries mode, source, errors', () => {
  const b = bookFrom('abandon v. 放弃');
  const parsed = P.parse('abandon v. 放弃\nnot a valid line here >>>');
  const plan = M.buildPlan(b, parsed, { now: T0 });
  const next = M.applyPlan(b, plan, {}, { now: T0, mode: 'dict', source: 'paste' });
  const rec = next.imports[next.imports.length - 1];
  assert.equal(rec.mode, 'dict');
  assert.equal(rec.source, 'paste');
  assert.equal(typeof rec.errors, 'number');
});

test('merge: no-meaning entries surfaced separately', () => {
  const b = M.emptyBook();
  const parsed = P.parse('abandon\nability n. 能力');
  const plan = M.buildPlan(b, parsed, { now: T0 });
  assert.equal(plan.counts.noMeaning, 1);
  assert.equal(plan.noMeaning[0].en, 'abandon');
});

test('merge: replace keeps progress of surviving words and reports dropped', () => {
  let b = bookFrom('abandon v. 放弃\nability n. 能力');
  b.words.abandon.progress = SM2.review(SM2.defaults(), true, T0);
  const snapshot = JSON.stringify(b.words.abandon.progress);
  const parsed = P.parse('abandon v. 抛弃\nsubject n. 主题');
  const res = M.applyReplace(b, parsed, { now: T0 + 1000 });
  assert.equal(res.dropped, 1);
  assert.ok(!res.book.words.ability);
  assert.equal(JSON.stringify(res.book.words.abandon.progress), snapshot);
  assert.equal(res.book.words.abandon.zh, '抛弃');
  assert.ok(res.book.words.subject);
});

test('merge: v1 array migrates into a v2 book', () => {
  const v1 = [
    { word: 'abandon', meaning: '放弃', phonetic: 'əˈbændən', collo: ['abandon hope 放弃希望'] },
    { word: 'ability', meaning: '能力', progress: { ef: 2.2, reps: 1, interval: 1, due: T0, seen: true } }
  ];
  const b = M.migrate(v1);
  assert.equal(b.version, 2);
  assert.equal(b.words.abandon.zh, '放弃');
  assert.equal(b.words.ability.progress.seen, true);
  assert.equal(b.words.ability.progress.wrongCount, 0);
  assert.ok(b.words.abandon.srcs.length === 0);
});

test('merge: migration repairs duplicate keys and keeps the first', () => {
  const raw = { version: 2, words: { abandon: { en: 'abandon', zh: '放弃' }, Abandon: { en: 'Abandon', zh: '抛弃' } } };
  const b = M.migrate(raw);
  assert.equal(Object.keys(b.words).length, 1);
  assert.equal(b.words.abandon.zh, '放弃');
});

test('merge: legacy 5-minute interval migrated to 0', () => {
  const raw = { words: { abandon: { en: 'abandon', zh: '放弃', progress: { ef: 2.2, reps: 0, interval: 5, due: T0 + 300000, last: T0, seen: true } } } };
  const b = M.migrate(raw);
  assert.equal(b.words.abandon.progress.interval, 0);
});

test('merge: search by word, meaning and collocation', () => {
  const b = bookFrom('abandon v. 放弃\n- abandon hope 放弃希望\nability n. 能力');
  assert.equal(M.searchWords(b, 'aban', {}).length, 1);
  assert.equal(M.searchWords(b, '能力', {}).length, 1);
  assert.equal(M.searchWords(b, '放弃希望', {}).length, 1);
  assert.equal(M.searchWords(b, 'zzz', {}).length, 0);
});

test('merge: search filters by bucket', () => {
  let b = bookFrom('abandon v. 放弃\nability n. 能力');
  b.words.abandon.progress = SM2.review(SM2.defaults(), true, T0);
  b.words.ability.tags = ['拼写易错'];
  assert.equal(M.searchWords(b, '', { bucket: 'new' }).length, 1);
  assert.equal(M.searchWords(b, '', { bucket: 'learning' }).length, 1);
  assert.equal(M.searchWords(b, '', { bucket: 'wrong' }).length, 1);
});

test('merge: phrases collected with owner keys', () => {
  const b = bookFrom('abandon v. 放弃\n- abandon hope 放弃希望');
  const ph = M.collectPhrases(b);
  assert.equal(ph.length, 1);
  assert.equal(ph[0].en, 'abandon hope');
  assert.equal(ph[0].zh, '放弃希望');
  assert.equal(ph[0].ownerKey, 'abandon');
});

test('merge: sortedWords added order follows createdAt', () => {
  const b = bookFrom('abandon v. 放弃\nability n. 能力\nsubject n. 主题');
  const order = M.sortedWords(b, 'added').map(w => w.en);
  assert.deepEqual(order, ['abandon', 'ability', 'subject']);
});

test('merge: import history capped at 200', () => {
  let b = M.emptyBook();
  b.imports = new Array(200).fill(0).map((_, i) => ({ id: 'x' + i }));
  const plan = M.buildPlan(b, P.parse('abandon v. 放弃'), { now: T0 });
  const next = M.applyPlan(b, plan, {}, { now: T0 });
  assert.equal(next.imports.length, 200);
  assert.equal(next.imports[next.imports.length - 1].added, 1);
});

test('meaning policy: first import trims to 2 items per POS', () => {
  const b = bookFrom('abandon v. 放弃；抛弃；遗弃');
  assert.equal(b.words.abandon.zh, '放弃；抛弃');
  assert.equal(b.words.abandon.pos, 'v.');
});

test('meaning policy: cross-POS keeps one each within 4', () => {
  const b = bookFrom('subject n. 主题；科目 adj. 受影响的');
  assert.equal(b.words.subject.zh, '主题；科目 adj. 受影响的');
});

test('meaning policy: second import ignores a different meaning entirely', () => {
  const first = bookFrom('abandon v. 放弃；抛弃');
  const parsed = P.parse('abandon v. 遗弃；丢弃');
  const plan = M.buildPlan(first, parsed, { now: T0 });
  assert.equal(plan.counts.updated, 0);
  assert.equal(plan.counts.unchanged, 1);
  const next = M.applyPlan(first, plan, {}, { now: T0 });
  assert.equal(next.words.abandon.zh, '放弃；抛弃');
});

test('meaning policy: empty existing meaning is filled and trimmed', () => {
  const first = bookFrom('abandon');
  assert.equal(first.words.abandon.zh, '');
  const parsed = P.parse('abandon v. 放弃；抛弃；遗弃');
  const plan = M.buildPlan(first, parsed, { now: T0 });
  assert.equal(plan.counts.updated, 1);
  assert.equal(plan.trimmed.length, 1, 'fill is trimmed too');
  const next = M.applyPlan(first, plan, {}, { now: T0 });
  assert.equal(next.words.abandon.zh, '放弃；抛弃');
});

test('meaning policy: overwrite choice cannot resurrect an ignored meaning', () => {
  const first = bookFrom('abandon v. 放弃');
  const parsed = P.parse('abandon v. 遗弃；丢弃；舍弃；放弃');
  const plan = M.buildPlan(first, parsed, { now: T0 });
  // The differing meaning is ignored at plan time, so even an explicit overwrite
  // request has nothing to apply from the import path.
  const next = M.applyPlan(first, plan, { abandon: 'overwrite' }, { now: T0 });
  assert.equal(next.words.abandon.zh, '放弃');
});

test('meaning policy: manual edit is not truncated by import path', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃；抛弃');
  const r = st.updateWord('abandon', { zh: '放弃；抛弃；遗弃；丢弃；舍弃' }, T0 + 1000);
  assert.equal(r.ok, true);
  assert.equal(st.loadBook().words.abandon.zh, '放弃；抛弃；遗弃；丢弃；舍弃');
});

test('meaning policy: summary records which items were truncated', () => {
  const first = M.emptyBook();
  const parsed = P.parse('abandon v. 放弃；抛弃；遗弃\nsubject n. 主题；科目 adj. 受影响的；服从的 adv. 偶然地');
  const plan = M.buildPlan(first, parsed, { now: T0 });
  assert.equal(plan.counts.trimmed, 2);
  const abandonRow = plan.trimmed.filter(function (t) { return t.en === 'abandon'; })[0];
  assert.equal(abandonRow.dropped[0].text, '遗弃');
  assert.equal(abandonRow.kept, '放弃；抛弃');
});

test('meaning policy: import record stores the trimmed count', () => {
  const st = newStore();
  const parsed = P.parse('abandon v. 放弃；抛弃；遗弃');
  const plan = M.buildPlan(st.loadBook(), parsed, { now: T0 });
  st.commitPlan(plan, {}, { now: T0, mode: 'dict', source: 'paste' });
  const rec = st.loadBook().imports[0];
  assert.equal(rec.trimmed, 1);
});

test('meaning policy: daily backup file is created once per day', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃');
  const r1 = st.dailyBackup(T0);
  assert.equal(r1.ok, true);
  assert.ok(r1.name && r1.name.indexOf('daily-') === 0, JSON.stringify(r1));
  const r2 = st.dailyBackup(T0 + 3600 * 1000);
  assert.equal(r2.existing, r1.name, 'same day does not create a second file');
  const r3 = st.dailyBackup(T0 + 2 * 86400000);
  assert.ok(r3.name !== r1.name, 'next day creates a new snapshot');
});

test('meaning policy: daily backups older than 7 days are pruned', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃');
  for (let d = 0; d < 10; d++) st.dailyBackup(T0 + d * 86400000);
  const dailies = st.listBackups().filter(b => b.name.indexOf('daily-') === 0);
  assert.ok(dailies.length <= 7, 'kept ' + dailies.length);
});

test('meaning policy: daily backup skips an empty book', () => {
  const st = newStore();
  const r = st.dailyBackup(T0);
  assert.equal(r.skipped, 'empty');
  assert.equal(st.listBackups().filter(b => b.name.indexOf('daily-') === 0).length, 0);
});

test('meaning policy: deleted word restores full progress after daily reload', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃');
  st.loadBook().words.abandon.progress = SM2.review(SM2.defaults(), true, T0);
  st.saveBook(st.loadBook());
  st.deleteWord('abandon', T0 + 1000);
  const d = st.loadDeleted();
  assert.equal(d.items[0].progress.reps, 1, 'deleted record stores progress');
  assert.equal(st.restoreDeleted(0).ok, true);
  const w = st.loadBook().words.abandon;
  assert.equal(w.progress.reps, 1);
  assert.ok(w.progress.due > 0);
});
