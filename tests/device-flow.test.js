'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/bridge-harness');

function boot(opts) {
  const sim = H.createBridge(opts);
  const Moci = H.loadModules(sim.bridge);
  const store = Moci.store.create(Moci.storage.pick(), {});
  return { sim, Moci, store };
}

/**
 * Replays the exact flow the user described: paste a 97-word list, confirm,
 * then restart. Any silent write failure shows up here.
 */
test('flow: 97-word import is fully persisted and reloadable', () => {
  const sim = H.createBridge();
  const Moci = H.loadModules(sim.bridge);
  const store = Moci.store.create(Moci.storage.pick(), {});

  const words = [];
  for (let i = 0; i < 97; i++) {
    const w = 'word' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26));
    words.push(w + ' /wɜːd/ v. 释义' + i);
    words.push('  - ' + w + ' up 搭配' + i);
  }
  const parsed = Moci.parser.parse(words.join('\n'));
  assert.equal(parsed.entries.length, 97, 'parser must yield 97 entries');

  const plan = Moci.merger.buildPlan(store.loadBook(), parsed, { now: Date.now() });
  assert.equal(plan.counts.added, 97);
  const res = store.commitPlan(plan, {}, { now: Date.now() });
  assert.equal(res.ok, true, res.error || '');

  const onDisk = JSON.parse(sim.files['wordbook.json']);
  assert.equal(Object.keys(onDisk.words).length, 97);
  assert.ok(onDisk.imports.length >= 1, 'import history must be recorded');

  const reloaded = Moci.store.create(Moci.storage.pick(), {}).loadBook();
  assert.equal(Object.keys(reloaded.words).length, 97, 'all words must survive restart');
});

test('flow: import reports failure when the disk is full, and writes nothing', () => {
  const sim = H.createBridge({ failWrites: true });
  const Moci = H.loadModules(sim.bridge);
  const store = Moci.store.create(Moci.storage.pick(), {});
  const parsed = Moci.parser.parse('abandon v. 放弃\nability n. 能力');
  const plan = Moci.merger.buildPlan(store.loadBook(), parsed, { now: Date.now() });
  const res = store.commitPlan(plan, {}, { now: Date.now() });
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('写入失败') || res.error.includes('备份'), res.error);
  assert.equal(sim.files['wordbook.json'], undefined);
});

test('flow: study session updates progress on disk', () => {
  const { sim, Moci, store } = boot();
  const parsed = Moci.parser.parse('abandon v. 放弃\nability n. 能力');
  store.commitPlan(Moci.merger.buildPlan(store.loadBook(), parsed, { now: Date.now() }), {}, { now: Date.now() });

  const book = store.loadBook();
  const cards = Moci.selector.selectLearnGroup(book, { now: Date.now(), seed: 1 });
  assert.ok(cards.length >= 2);
  const qs = Moci.selector.buildDictation(cards, { seed: 1 });
  assert.ok(qs.length >= 2);

  // Answer correctly through the real grader.
  qs.forEach(q => {
    const v = Moci.grader.judgeTyped(q.answer, q.answer);
    assert.equal(v.correct, true);
    book.words[q.ownerKey].progress = Moci.sm2.review(book.words[q.ownerKey].progress, true, Date.now());
  });
  store.saveBook(book);
  store.saveStats(Moci.stats.recordSession(store.loadStats(), {
    type: 'learn', total: qs.length, correct: qs.length, newWords: cards.length, reviewed: cards.length
  }, Date.now()));

  const reloaded = Moci.store.create(Moci.storage.pick(), {});
  const rb = reloaded.loadBook();
  Object.keys(rb.words).forEach(k => {
    assert.equal(rb.words[k].progress.seen, true, k + ' progress must persist');
    assert.ok(rb.words[k].progress.due > 0, k + ' due must be set');
    assert.ok(rb.words[k].progress.streak >= 1, k + ' streak must increment');
  });
  const stats = reloaded.loadStats();
  assert.equal(stats.sessions.length, 1);
});

test('flow: wrong answers land in the wrong book and survive restart', () => {
  const { sim, Moci, store } = boot();
  const parsed = Moci.parser.parse('abandon v. 放弃');
  store.commitPlan(Moci.merger.buildPlan(store.loadBook(), parsed, { now: Date.now() }), {}, { now: Date.now() });
  const book = store.loadBook();
  Moci.wrongbook.markWrong(book, 'abandon', 'abandn', 'abandon', null, Date.now());
  store.saveBook(book);
  const rb = Moci.store.create(Moci.storage.pick(), {}).loadBook();
  assert.ok(rb.words.abandon.tags.indexOf('拼写易错') >= 0, JSON.stringify(rb.words.abandon.tags));
});

test('flow: delete then restore keeps progress through the bridge', () => {
  const { Moci, store } = boot();
  const parsed = Moci.parser.parse('abandon v. 放弃');
  store.commitPlan(Moci.merger.buildPlan(store.loadBook(), parsed, { now: Date.now() }), {}, { now: Date.now() });
  const book = store.loadBook();
  book.words.abandon.progress = Moci.sm2.review(Moci.sm2.defaults(), true, Date.now());
  store.saveBook(book);
  const expectedReps = store.loadBook().words.abandon.progress.reps;

  assert.equal(store.deleteWord('abandon', Date.now()).ok, true);
  assert.equal(store.loadBook().words.abandon, undefined);
  assert.equal(store.restoreDeleted(0).ok, true);
  assert.equal(store.loadBook().words.abandon.progress.reps, expectedReps);
});

test('flow: manual add and edit persist content (the textarea bug)', () => {
  const { sim, Moci, store } = boot();
  const r = store.addWordManual({
    en: 'zebra', phonetic: 'ˈziːbrə', pos: 'n.', zh: '斑马',
    collo: ['zebra crossing 斑马线'], tags: []
  }, Date.now());
  assert.equal(r.ok, true, r.error || '');
  const onDisk = JSON.parse(sim.files['wordbook.json']);
  assert.equal(onDisk.words.zebra.zh, '斑马');
  assert.deepEqual(onDisk.words.zebra.collo, ['zebra crossing 斑马线'], 'collocations must persist');

  const e = store.updateWord('zebra', { zh: '斑马；条纹', collo: ['zebra crossing 斑马线', 'zebra fish 斑马鱼'] }, Date.now());
  assert.equal(e.ok, true);
  const after = JSON.parse(sim.files['wordbook.json']);
  assert.equal(after.words.zebra.zh, '斑马；条纹');
  assert.equal(after.words.zebra.collo.length, 2);
});

test('flow: export writes a file the app can read back and re-import', () => {
  const { sim, Moci, store } = boot();
  const parsed = Moci.parser.parse('abandon v. 放弃\n- abandon hope 放弃希望');
  store.commitPlan(Moci.merger.buildPlan(store.loadBook(), parsed, { now: Date.now() }), {}, { now: Date.now() });

  ['json', 'csv', 'txt'].forEach(kind => {
    const out = store.exportAll(kind);
    const rel = 'export/moci.' + out.ext;
    const w = store.adapter.write(rel, out.text);
    assert.ok(!w || w.ok !== false, kind + ' export write failed');
    assert.ok(sim.files[rel], kind + ' export missing on disk');
  });

  // Round-trip the JSON backup into a fresh book.
  const json = JSON.parse(sim.files['export/moci.json']);
  const restored = Moci.merger.migrate(json);
  assert.equal(Object.keys(restored.words).length, 1);
});

test('flow: clear-all backs up first, then empties storage', () => {
  const { sim, Moci, store } = boot();
  const parsed = Moci.parser.parse('abandon v. 放弃');
  store.commitPlan(Moci.merger.buildPlan(store.loadBook(), parsed, { now: Date.now() }), {}, { now: Date.now() });
  const res = store.clearAll();
  assert.equal(res.ok, true, res.error || '');
  assert.equal(Object.keys(store.loadBook().words).length, 0);
  const backups = Object.keys(sim.files).filter(k => k.startsWith('backup/'));
  assert.ok(backups.length >= 1, 'a pre-clear backup must exist on disk');
});

test('flow: daily backup and import backups coexist without evicting', () => {
  const { sim, Moci, store } = boot();
  let t = Date.now();
  const p0 = Moci.parser.parse('abandon v. 放弃');
  store.commitPlan(Moci.merger.buildPlan(store.loadBook(), p0, { now: t }), {}, { now: t });
  const daily = store.dailyBackup(t);
  assert.equal(daily.ok, true);

  for (let i = 0; i < 10; i++) {
    t += 1000;
    const text = 'word' + String.fromCharCode(97 + i) + i + ' n. 义';
    const p = Moci.parser.parse(text);
    store.commitPlan(Moci.merger.buildPlan(store.loadBook(), p, { now: t }), {}, { now: t });
  }
  const names = store.listBackups().map(b => b.name);
  assert.ok(names.indexOf(daily.name) >= 0, 'daily backup evicted by imports: ' + JSON.stringify(names));
  assert.ok(Object.keys(sim.files)['backup/' + daily.name] !== undefined || sim.files['backup/' + daily.name],
    'daily backup file missing on disk');
});

test('flow: a corrupt wordbook file does not crash the app', () => {
  const sim = H.createBridge();
  sim.raw.writeText('wordbook.json', '{ broken json');
  const Moci = H.loadModules(sim.bridge);
  const store = Moci.store.create(Moci.storage.pick(), {});
  const book = store.loadBook();
  assert.equal(Object.keys(book.words).length, 0, 'must fall back to an empty book');
  const recovered = Object.keys(sim.files).filter(k => k.indexOf('.corrupt-') >= 0);
  assert.ok(recovered.length >= 1, 'the damaged file must be preserved for recovery');
});
