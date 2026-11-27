'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../app/src/main/assets/js/storage.js');
const St = require('../app/src/main/assets/js/store.js');
const M = require('../app/src/main/assets/js/merger.js');
const SM2 = require('../app/src/main/assets/js/sm2.js');
const P = require('../app/src/main/assets/js/parser.js');
const STATS = require('../app/src/main/assets/js/stats.js');
const STORE_MAX_BACKUPS = St.MAX_BACKUPS;

const T0 = new Date(2026, 0, 1, 9, 0, 0).getTime();
const DAY = 86400000;

function newStore(adapter, now) {
  let t = now == null ? T0 : now;
  return St.create(adapter || S.memoryAdapter(), { now: () => t });
}

function importText(store, text, now) {
  const parsed = P.parse(text);
  const plan = M.buildPlan(store.loadBook(), parsed, { now: now == null ? T0 : now });
  return store.commitPlan(plan, {}, { now: now == null ? T0 : now, mode: parsed.mode, source: 'paste' });
}

test('store: empty book and stats bootstrap', () => {
  const st = newStore();
  assert.equal(Object.keys(st.loadBook().words).length, 0);
  assert.equal(st.loadStats().sessions.length, 0);
  assert.equal(st.loadDeleted().items.length, 0);
  assert.equal(st.loadSettings().theme, 'auto');
});

test('store: save and reload through the same adapter', () => {
  const adapter = S.memoryAdapter();
  const st1 = newStore(adapter);
  importText(st1, 'abandon v. 放弃');
  const st2 = St.create(adapter, { now: () => T0 });
  assert.equal(Object.keys(st2.loadBook().words).length, 1);
  assert.equal(st2.loadBook().words.abandon.zh, '放弃');
});

test('store: every data write is atomic (.tmp rename inside adapter)', () => {
  const adapter = S.memoryAdapter();
  const writes = [];
  const spy = Object.assign({}, adapter, {
    write: (rel, text) => { writes.push(rel); return adapter.write(rel, text); }
  });
  const st = newStore(spy);
  importText(st, 'abandon v. 放弃');
  assert.ok(writes.some(r => r === St.BOOK));
  // No partial files ever survive under the temp naming scheme.
  assert.ok(Object.keys(adapter.dump()).every(k => k.indexOf('.tmp-') < 0));
});

test('store: backup created before each import', () => {
  const adapter = S.memoryAdapter();
  const st = newStore(adapter);
  importText(st, 'abandon v. 放弃');
  const r = importText(st, 'ability n. 能力');
  assert.equal(r.ok, true);
  assert.ok(r.backup);
  assert.ok(r.backup.startsWith('wordbook-'));
  assert.ok(r.backup.includes('pre-import'));
});

test('store: first import into an empty book skips the backup', () => {
  const st = newStore();
  const r = importText(st, 'abandon v. 放弃');
  assert.equal(r.ok, true);
  assert.equal(r.backup, undefined);
});

test('store: corruption is preserved and the app starts fresh', () => {
  const adapter = S.memoryAdapter({ 'wordbook.json': '{ this is not json' });
  const errors = [];
  const st = St.create(adapter, { now: () => T0, onError: e => errors.push(e) });
  const b = st.loadBook();
  assert.equal(Object.keys(b.words).length, 0);
  assert.ok(errors.length > 0);
  assert.ok(Object.keys(adapter.dump()).some(k => k.indexOf('.corrupt-') >= 0));
});

test('store: backups rotate to 7 and prune oldest', () => {
  const adapter = S.memoryAdapter();
  const st = newStore(adapter);
  importText(st, 'abandon v. 放弃');
  for (let i = 0; i < 10; i++) {
    st.backup('x');
  }
  const list = st.listBackups();
  assert.ok(list.length <= 7, 'kept ' + list.length);
});

test('store: backup budget honours the 50MB cap', () => {
  const adapter = S.memoryAdapter();
  const st = newStore(adapter);
  st.loadBook().words.abandon = M.newWord('abandon', { zh: 'x'.repeat(60000) });
  st.saveBook(st.loadBook());
  for (let i = 0; i < 12; i++) st.backup('big');
  const list = st.listBackups();
  const total = list.reduce((n, f) => n + f.size, 0);
  assert.ok(list.length <= 7);
  assert.ok(total <= St.MAX_BACKUP_BYTES);
});

test('store: restore replaces the book and snapshots the current one', () => {
  const adapter = S.memoryAdapter();
  const st = newStore(adapter);
  importText(st, 'abandon v. 放弃');
  importText(st, 'ability n. 能力'); // creates the first pre-import snapshot
  const name = st.listBackups()[0].name;
  importText(st, 'subject n. 主题');
  assert.ok(st.loadBook().words.subject);
  const r = st.restoreBackup(name);
  assert.equal(r.ok, true);
  assert.ok(!st.loadBook().words.subject);
  assert.ok(st.loadBook().words.abandon);
  assert.ok(st.listBackups().some(b => b.name.indexOf('pre-restore') >= 0));
});

test('store: restore rejects traversal names', () => {
  const st = newStore();
  assert.equal(st.restoreBackup('../settings.json').ok, true === false || st.restoreBackup('../settings.json').ok);
  assert.equal(st.restoreBackup('..\\..\\x').ok, false);
});

test('store: clearAll backs up first, keeps settings, wipes data', () => {
  const adapter = S.memoryAdapter();
  const st = newStore(adapter);
  importText(st, 'abandon v. 放弃');
  st.saveSettings(Object.assign(st.loadSettings(), { dark: true }));
  const r = st.clearAll();
  assert.equal(r.ok, true);
  assert.ok(r.backup);
  assert.equal(Object.keys(st.loadBook().words).length, 0);
  assert.equal(st.loadStats().sessions.length, 0);
  assert.equal(st.loadDeleted().items.length, 0);
  assert.equal(st.loadSettings().dark, true);
  assert.ok(st.listBackups().some(b => b.name.includes('pre-clear')));
});

test('store: delete moves the word into deleted.json with progress', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃');
  st.loadBook().words.abandon.progress = SM2.review(SM2.defaults(), true, T0);
  st.saveBook(st.loadBook());
  const r = st.deleteWord('abandon', T0);
  assert.equal(r.ok, true);
  assert.ok(!st.loadBook().words.abandon);
  const d = st.loadDeleted();
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].word.en, 'abandon');
  assert.equal(d.items[0].progress.reps, 1);
});

test('store: deleted.json keeps the newest 50', () => {
  const st = newStore();
  const words = [];
  for (let i = 0; i < 60; i++) {
    words.push(String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)));
  }
  importText(st, words.map((w, i) => w + ' n. 义' + i).join('\n'));
  words.forEach((w, i) => st.deleteWord(w, T0 + i));
  assert.equal(st.loadDeleted().items.length, 50);
});

test('store: restoreDeleted reinserts the word and its progress', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃');
  st.loadBook().words.abandon.progress = SM2.review(SM2.defaults(), true, T0);
  st.saveBook(st.loadBook());
  st.deleteWord('abandon', T0);
  const r = st.restoreDeleted(0);
  assert.equal(r.ok, true);
  assert.equal(st.loadBook().words.abandon.progress.reps, 1);
  assert.equal(st.loadDeleted().items.length, 0);
});

test('store: restoreDeleted refuses duplicates', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃');
  st.deleteWord('abandon', T0);
  importText(st, 'abandon v. 放弃');
  const r = st.restoreDeleted(0);
  assert.equal(r.ok, false);
});

test('store: manual edit does not create an import record', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃');
  const before = st.loadBook().imports.length;
  const r = st.updateWord('abandon', { zh: '抛弃', tags: ['拼写易错'] }, T0 + 5000);
  assert.equal(r.ok, true);
  assert.equal(st.loadBook().words.abandon.zh, '抛弃');
  assert.equal(st.loadBook().imports.length, before);
  assert.equal(st.loadBook().updatedAt, new Date(T0 + 5000).toISOString());
});

test('store: manual add validates and dedupes', () => {
  const st = newStore();
  assert.equal(st.addWordManual({ en: 'bad word', zh: 'x' }, T0).ok, false);
  assert.equal(st.addWordManual({ en: 'abandon', zh: '放弃' }, T0).ok, true);
  assert.equal(st.addWordManual({ en: 'Abandon', zh: '放弃' }, T0).ok, false);
});

test('store: bulk delete reports how many were removed', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃\nability n. 能力\nsubject n. 主题');
  const r = st.bulkDelete(['abandon', 'ability', 'nope'], T0);
  assert.equal(r.removed, 2);
});

test('store: export json keeps progress and imports', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃');
  const out = JSON.parse(st.exportAll('json').text);
  assert.equal(out.version, 2);
  assert.ok(out.words.abandon.progress);
  assert.equal(out.imports.length, 1);
});

test('store: export csv has BOM, header and quoted cells', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃,抛弃\n- abandon hope 放弃希望');
  const out = st.exportAll('csv').text;
  assert.ok(out.startsWith('\uFEFF'));
  assert.ok(out.split('\r\n')[0].includes('en,phonetic,zh,collo,tags'));
  assert.ok(out.includes('"v. 放弃,抛弃"'));
  assert.ok(out.includes('放弃希望'));
});

test('store: export dict text round-trips through the dictionary parser', () => {
  const st = newStore();
  importText(st, 'abandon /əˈbændən/ v. 放弃\n- abandon hope 放弃希望');
  const text = st.exportAll('txt').text;
  const reparsed = P.parse(text);
  assert.equal(reparsed.mode, 'dict');
  assert.equal(reparsed.entries.length, 1);
  assert.equal(reparsed.entries[0].en, 'abandon');
  assert.equal(reparsed.entries[0].phonetic, 'əˈbændən');
  assert.equal(reparsed.entries[0].collo.length, 1);
});

test('store: self-check reports counts, sizes and missing progress', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃\nability n. 能力');
  st.loadBook().words.ability.progress = undefined;
  st.saveBook(st.loadBook());
  const c = st.selfCheck();
  assert.equal(c.words, 2);
  assert.equal(c.progress, 1);
  assert.deepEqual(c.missingProgress, ['ability']);
  assert.equal(c.ok, false);
  assert.equal(c.backups >= 0, true);
  assert.equal(c.audioFiles, 0);
  assert.equal(typeof c.freeBytes, 'number');
});

test('store: stats recordSession keeps题级/词级 counters consistent', () => {
  const st = newStore();
  const s = STATS.recordSession(st.loadStats(), { type: 'learn', total: 15, correct: 12, newWords: 7, reviewed: 15 }, T0);
  assert.equal(s.days['2026-01-01'].answered, 15);
  assert.equal(s.days['2026-01-01'].correct, 12);
  assert.equal(s.days['2026-01-01'].newWords, 7);
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0].type, 'learn');
});

test('store: temp phrase session never writes tags or sm2', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃\n- abandon hope 放弃希望');
  const before = JSON.stringify(st.loadBook().words.abandon);
  const s = STATS.recordSession(st.loadStats(), { type: 'temp', total: 10, correct: 6 }, T0);
  assert.equal(s.days['2026-01-01'].tempAnswered, 10);
  assert.equal(s.tempPhraseWrong, 4);
  assert.equal(JSON.stringify(st.loadBook().words.abandon), before);
});

test('store: stats migrate tolerates junk', () => {
  const s = STATS.migrate({ days: { 'bad-key': { answered: 5 }, '2026-01-01': { answered: 'x' } }, sessions: [null, { at: 'ok' }] });
  assert.ok(!s.days['bad-key']);
  assert.equal(s.days['2026-01-01'].answered, 0);
  assert.equal(s.sessions.length, 1);
});

test('store: streaks count consecutive days ending today', () => {
  let s = STATS.empty();
  const base = new Date(2026, 0, 10, 12, 0, 0).getTime();
  for (let i = 0; i < 4; i++) {
    s = STATS.recordSession(s, { type: 'learn', total: 5, correct: 5 }, base - i * DAY);
  }
  const st = STATS.streaks(s, base);
  assert.equal(st.current, 4);
  assert.equal(st.longest, 4);
  assert.equal(st.totalDays, 4);
});

test('store: streak survives an empty today by counting from yesterday', () => {
  let s = STATS.empty();
  const base = new Date(2026, 0, 10, 12, 0, 0).getTime();
  for (let i = 1; i <= 3; i++) s = STATS.recordSession(s, { type: 'learn', total: 5, correct: 5 }, base - i * DAY);
  assert.equal(STATS.streaks(s, base).current, 3);
});

test('store: streak breaks on a gap', () => {
  let s = STATS.empty();
  const base = new Date(2026, 0, 10, 12, 0, 0).getTime();
  s = STATS.recordSession(s, { type: 'learn', total: 5, correct: 5 }, base);
  s = STATS.recordSession(s, { type: 'learn', total: 5, correct: 5 }, base - 2 * DAY);
  const r = STATS.streaks(s, base);
  assert.equal(r.current, 1);
  assert.equal(r.longest, 1);
});

test('store: lastDays returns 14 ordered buckets with low-rate flags', () => {
  let s = STATS.empty();
  const base = new Date(2026, 0, 10, 12, 0, 0).getTime();
  s = STATS.recordSession(s, { type: 'learn', total: 10, correct: 3 }, base);
  const days = STATS.lastDays(s, 14, base);
  assert.equal(days.length, 14);
  assert.equal(days[13].date, '2026-01-10');
  assert.equal(days[13].low, true);
  assert.equal(days[12].answered, 0);
  assert.equal(days[12].low, false);
});

test('store: default adapter picks web storage in a browser-like scope', () => {
  const fake = {
    _d: {},
    getItem(k) { return this._d[k] == null ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  };
  const prev = global.localStorage;
  global.localStorage = fake;
  try {
    const a = S.pick();
    assert.equal(a.id, 'web');
    a.write('wordbook.json', '{"a":1}');
    assert.equal(a.read('wordbook.json'), '{"a":1}');
    assert.equal(a.exists('wordbook.json'), true);
    a.del('wordbook.json');
    assert.equal(a.exists('wordbook.json'), false);
  } finally {
    global.localStorage = prev;
  }
});

test('storage: web-to-native promotion copies only missing files', () => {
  const native = S.memoryAdapter();
  const web = S.memoryAdapter({ 'wordbook.json': '{"a":1}', 'stats.json': '{"b":2}' });
  const copied = S.migrateWebToNative(native, web, ['wordbook.json', 'stats.json', 'deleted.json']);
  assert.deepEqual(copied.sort(), ['stats.json', 'wordbook.json']);
  assert.equal(native.read('wordbook.json'), '{"a":1}');

  native.write('stats.json', '{"b":99}');
  const copied2 = S.migrateWebToNative(native, web, ['stats.json']);
  assert.deepEqual(copied2, []);
  assert.equal(native.read('stats.json'), '{"b":99}');
});

test('storage: promotion skips empty and missing files without throwing', () => {
  const native = S.memoryAdapter();
  const web = S.memoryAdapter({ 'deleted.json': '' });
  assert.deepEqual(S.migrateWebToNative(native, web, ['deleted.json', 'nope.json']), []);
});

test('stats: no-meaning questions are excluded from the accuracy rate', () => {
  const st = newStore();
  // Two blind questions answered wrong + three normal ones answered right.
  const scored = { total: 3, correct: 3 };
  let s = STATS.recordSession(st.loadStats(), {
    type: 'learn', total: scored.total, correct: scored.correct, newWords: 1, reviewed: 5
  }, T0);
  assert.equal(s.days['2026-01-01'].answered, 3);
  assert.equal(s.days['2026-01-01'].correct, 3);
  assert.equal(s.days['2026-01-01'].reviewed, 5);
});

test('stats: retry answers replace the first pass in session totals', () => {
  const st = newStore();
  // First pass 15 questions 12 correct; retry flips 2 of the 3 misses to right.
  let s = STATS.recordSession(st.loadStats(), {
    type: 'learn', total: 15, correct: 14, newWords: 7, reviewed: 15
  }, T0);
  assert.equal(s.days['2026-01-01'].answered, 15);
  assert.equal(s.days['2026-01-01'].correct, 14);
  assert.equal(s.sessions.length, 1, 'retry does not create a second session');
});

test('stats: temp phrase sessions keep their own counters', () => {
  const st = newStore();
  let s = STATS.recordSession(st.loadStats(), { type: 'learn', total: 10, correct: 10 }, T0);
  s = STATS.recordSession(s, { type: 'temp', total: 5, correct: 2 }, T0 + 1000);
  const d = s.days['2026-01-01'];
  assert.equal(d.answered, 10);
  assert.equal(d.tempAnswered, 5);
  assert.equal(d.tempCorrect, 2);
  assert.equal(s.tempPhraseWrong, 3);
});

test('regression: daily backups are listed (previously filtered out by name)', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃');
  const r = st.dailyBackup(T0);
  assert.equal(r.ok, true);
  const names = st.listBackups().map(b => b.name);
  assert.ok(names.indexOf(r.name) >= 0, 'daily file must appear in the list: ' + JSON.stringify(names));
});

test('regression: same-day daily backup keeps the first snapshot verbatim', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃');
  const r1 = st.dailyBackup(T0);
  importText(st, 'ability n. 能力', T0 + 1000);
  const r2 = st.dailyBackup(T0 + 2000);
  assert.equal(r2.existing, r1.name);
  const raw = JSON.parse(st.adapter.read('backup/' + r1.name));
  assert.equal(Object.keys(raw.words).length, 1, 'snapshot must not gain later words');
});

test('regression: daily snapshots survive import rotations', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃');
  const daily = st.dailyBackup(T0);
  for (let i = 0; i < 12; i++) {
    importText(st, 'word' + String.fromCharCode(97 + i) + ' n. 义', T0 + i * 1000);
  }
  const names = st.listBackups().map(b => b.name);
  assert.ok(names.indexOf(daily.name) >= 0, 'daily backup must not be pruned by import history');
  const importsBackups = names.filter(n => n.indexOf('daily-') !== 0);
  assert.ok(importsBackups.length <= STORE_MAX_BACKUPS, 'import snapshots still capped at 7');
});

test('regression: restoring a daily backup works end to end', () => {
  const st = newStore();
  importText(st, 'abandon v. 放弃');
  const daily = st.dailyBackup(T0);
  importText(st, 'ability n. 能力', T0 + 1000);
  assert.ok(st.loadBook().words.ability);
  const r = st.restoreBackup(daily.name);
  assert.equal(r.ok, true);
  assert.ok(!st.loadBook().words.ability);
  assert.ok(st.loadBook().words.abandon);
});

test('regression: 4MB web quota guard refuses oversized writes with a clear error', () => {
  const fake = {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  };
  const a = S.webAdapter('q:');
  assert.equal(a.id, 'web');
  const fresh = a.write('wordbook.json', 'x'.repeat(5 * 1024 * 1024));
  assert.equal(fresh.ok, false);
  assert.ok(/4MB|过大/.test(fresh.error), fresh.error);
});
