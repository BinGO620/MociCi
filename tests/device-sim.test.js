'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers/bridge-harness');

/** Boots the real modules against a simulated Android bridge. */
function boot(opts) {
  const sim = H.createBridge(opts);
  const Moci = H.loadModules(sim.bridge);
  const store = Moci.store.create(Moci.storage.pick(), {});
  return { sim, Moci, store };
}

test('device-sim: the native adapter is selected when a bridge exists', () => {
  const { store } = boot();
  assert.equal(store.adapter.id, 'native');
});

test('device-sim: importing a word actually persists to native storage', () => {
  const { sim, Moci, store } = boot();
  const parsed = Moci.parser.parse('abandon /əˈbændən/ v. 放弃\n- abandon hope 放弃希望');
  const plan = Moci.merger.buildPlan(store.loadBook(), parsed, { now: Date.now() });
  const res = store.commitPlan(plan, {}, { now: Date.now() });
  assert.equal(res.ok, true, 'commit must succeed: ' + (res.error || ''));
  assert.ok(sim.files['wordbook.json'], 'wordbook.json must exist on the simulated device');
  const onDisk = JSON.parse(sim.files['wordbook.json']);
  assert.equal(Object.keys(onDisk.words).length, 1);
  assert.equal(onDisk.words.abandon.zh, '放弃');
});

test('device-sim: data survives an app restart (fresh store, same disk)', () => {
  const sim = H.createBridge();
  const Moci = H.loadModules(sim.bridge);
  const s1 = Moci.store.create(Moci.storage.pick(), {});
  const parsed = Moci.parser.parse('abandon v. 放弃');
  s1.commitPlan(Moci.merger.buildPlan(s1.loadBook(), parsed, { now: Date.now() }), {}, { now: Date.now() });

  // Simulate process death: new store instance, same underlying files.
  const s2 = Moci.store.create(Moci.storage.pick(), {});
  const book = s2.loadBook();
  assert.equal(Object.keys(book.words).length, 1, 'words must reload from disk');
  assert.equal(book.words.abandon.zh, '放弃');
});

test('device-sim: settings persist through the native pref store claim', () => {
  const { store } = boot();
  const s = store.loadSettings();
  s.theme = 'dark';
  s.dailyGoal = 30;
  const r = store.saveSettings(s);
  assert.ok(!r || r.ok !== false, 'settings write must not fail');
  const again = store.loadSettings();
  assert.equal(again.theme, 'dark');
  assert.equal(again.dailyGoal, 30);
});

test('device-sim: stats and deleted files are written too, not just the book', () => {
  const { sim, Moci, store } = boot();
  const parsed = Moci.parser.parse('abandon v. 放弃');
  store.commitPlan(Moci.merger.buildPlan(store.loadBook(), parsed, { now: Date.now() }), {}, { now: Date.now() });
  store.saveStats(Moci.stats.recordSession(store.loadStats(), { type: 'learn', total: 1, correct: 1 }, Date.now()));
  store.deleteWord('abandon', Date.now());
  assert.ok(sim.files['stats.json'], 'stats.json missing');
  assert.ok(sim.files['deleted.json'], 'deleted.json missing');
});

test('device-sim: every storage method is invoked with its declared arity', () => {
  const { sim, Moci, store } = boot();
  const parsed = Moci.parser.parse('abandon v. 放弃');
  store.commitPlan(Moci.merger.buildPlan(store.loadBook(), parsed, { now: Date.now() }), {}, { now: Date.now() });
  store.listBackups();
  store.selfCheck();
  const bad = sim.calls.filter(c => H.ARITY[c.name] !== undefined && c.argc !== H.ARITY[c.name]);
  assert.deepEqual(bad, [], 'arity mismatches would throw Method not found on device: ' +
    bad.map(b => b.name + '(' + b.argc + ')').join(', '));
});

test('device-sim: a failing write surfaces an error instead of a false success', () => {
  const { sim, Moci, store } = boot({ failWrites: true });
  const parsed = Moci.parser.parse('abandon v. 放弃');
  const plan = Moci.merger.buildPlan(store.loadBook(), parsed, { now: Date.now() });
  const res = store.commitPlan(plan, {}, { now: Date.now() });
  assert.equal(res.ok, false, 'a failed write must not be reported as success');
  assert.ok(res.error, 'an error message is required');
  assert.equal(sim.files['wordbook.json'], undefined, 'nothing may be written on failure');
});

test('device-sim: self-check probe reports write failure honestly', () => {
  const bad = boot({ failWrites: true });
  const r1 = bad.store.adapter.selfTest();
  assert.equal(r1.writeText, false);
  assert.ok(r1.firstError, 'probe must expose why it failed');

  const good = boot();
  const r2 = good.store.adapter.selfTest();
  assert.equal(r2.writeText, true);
  assert.equal(r2.readText, true);
  assert.equal(r2.delete, true);
});

test('device-sim: self-check leaves no probe file behind', () => {
  const { sim, store } = boot();
  store.adapter.selfTest();
  assert.equal(sim.files['probe.json'], undefined, 'probe file must be deleted');
});

test('device-sim: tts speak reaches the bridge and reports the real outcome', () => {
  const { sim, Moci } = boot();
  const adapter = Moci.storage.pick();
  assert.equal(adapter.id, 'native');
  // The app-level speak path uses MociNative.ttsSpeak via nativejson parsing.
  const raw = sim.bridge.ttsSpeak('abandon', 0.8);
  const parsed = Moci.nativejson.parse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.spoken, true);
});

test('device-sim: tts unavailable is reported, not silently swallowed', () => {
  const { sim, Moci } = boot({ tts: false });
  const parsed = Moci.nativejson.parse(sim.bridge.ttsSpeak('abandon', 0.8));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.spoken, false, 'the UI needs this false to warn the user');
});

test('device-sim: export writes through the native path', () => {
  const { sim, Moci, store } = boot();
  const parsed = Moci.parser.parse('abandon v. 放弃');
  store.commitPlan(Moci.merger.buildPlan(store.loadBook(), parsed, { now: Date.now() }), {}, { now: Date.now() });
  const csv = store.exportAll('csv');
  const w = store.adapter.write('export/test.csv', csv.text);
  assert.ok(!w || w.ok !== false, 'export write failed');
  assert.ok(sim.files['export/test.csv'], 'export file missing on disk');
  assert.ok(sim.files['export/test.csv'].indexOf('abandon') >= 0);
});

test('device-sim: backup listing works against real dir() semantics', () => {
  const { sim, Moci, store } = boot();
  const parsed = Moci.parser.parse('abandon v. 放弃');
  store.commitPlan(Moci.merger.buildPlan(store.loadBook(), parsed, { now: Date.now() }), {}, { now: Date.now() });
  const r = store.dailyBackup(Date.now());
  assert.equal(r.ok, true);
  const names = store.listBackups().map(b => b.name);
  assert.ok(names.indexOf(r.name) >= 0, 'daily backup must be listed: ' + JSON.stringify(names));
  assert.ok(sim.files['backup/' + r.name], 'daily backup must exist on disk');
});

test('device-sim: restoring from a backup round-trips through the bridge', () => {
  const { Moci, store } = boot();
  const p1 = Moci.parser.parse('abandon v. 放弃');
  store.commitPlan(Moci.merger.buildPlan(store.loadBook(), p1, { now: Date.now() }), {}, { now: Date.now() });
  const daily = store.dailyBackup(Date.now());
  const p2 = Moci.parser.parse('ability n. 能力');
  store.commitPlan(Moci.merger.buildPlan(store.loadBook(), p2, { now: Date.now() + 1000 }), {}, { now: Date.now() + 1000 });
  assert.ok(store.loadBook().words.ability);
  const res = store.restoreBackup(daily.name);
  assert.equal(res.ok, true, res.error || '');
  assert.ok(!store.loadBook().words.ability, 'restore must roll back the later word');
  assert.ok(store.loadBook().words.abandon);
});

test('device-sim: path traversal is rejected by the real sandbox rules', () => {
  const { store } = boot();
  const r = store.adapter.write('../escape.json', 'x');
  assert.equal(r.ok, false, 'traversal must be refused');
  assert.ok(/illegal/i.test(r.error || ''), r.error);
});

test('device-sim: harness arity table equals the real Java signatures', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.resolve(__dirname, '../app/src/main/java/com/moci/cet6/NativeBridge.java'), 'utf8');
  const java = {};
  // Method names may contain digits (writeBase64), so the class is [A-Za-z0-9_].
  const re = /public\s+(?:String|void)\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    java[m[1]] = m[2].trim() === '' ? 0 : m[2].split(',').length;
  }
  const diffs = [];
  Object.keys(H.ARITY).forEach(fn => {
    if (java[fn] === undefined) diffs.push(fn + ': not in Java');
    else if (java[fn] !== H.ARITY[fn]) diffs.push(fn + ': simulator=' + H.ARITY[fn] + ' java=' + java[fn]);
  });
  assert.deepEqual(diffs, [], 'simulator would not catch real arity bugs: ' + diffs.join('; '));
});

test('device-sim: an arity bug in the adapter is caught by the harness', () => {
  // Guard the guard: prove the harness really rejects a 3-arg call to a 2-arg
  // method, otherwise every passing test above is meaningless.
  const sim = H.createBridge();
  assert.throws(() => sim.bridge.writeText('a.json', 'x', 'extra'), /Method not found/);
  assert.throws(() => sim.bridge.storageInfo('spurious'), /Method not found/);
  assert.throws(() => sim.bridge.noSuchMethod(), /not a function/);
});
