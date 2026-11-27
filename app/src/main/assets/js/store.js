(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'), require('./merger.js'), require('./stats.js'), require('./sm2.js'));
  else {
    root.Moci = root.Moci || {};
    root.Moci.store = factory(root.Moci.util, root.Moci.merger, root.Moci.stats, root.Moci.sm2);
  }
})(typeof self !== 'undefined' ? self : this, function (util, merger, statsMod, sm2) {
  'use strict';

  var BOOK = 'wordbook.json';
  var STATS = 'stats.json';
  var DELETED = 'deleted.json';
  var SETTINGS = 'settings.json';
  var BACKUP_DIR = 'backup';
  var MAX_BACKUPS = 7;
  var MAX_BACKUP_BYTES = 50 * 1024 * 1024;
  var MAX_DELETED = 50;

  function emptyDeleted() { return { version: 1, updatedAt: util.nowIso(), items: [] }; }
  function emptySettings() {
    return {
      version: 2, updatedAt: util.nowIso(), dark: false, theme: 'auto',
      dailyGoal: 15,      // cards per session (5 / 15 / 30)
      newPerDay: 7        // new words introduced per session (3 / 5 / 7 / 10)
    };
  }

  function safeParse(text, fallback) {
    if (!text) return fallback;
    try { return JSON.parse(text); } catch (e) { return fallback; }
  }

  function Store(adapter, opts) {
    opts = opts || {};
    this.adapter = adapter;
    this.now = opts.now || function () { return Date.now(); };
    this.onError = opts.onError || function () { };
    this._book = null;
    this._stats = null;
    this._deleted = null;
    this._settings = null;
    this._backups = null;
  }

  Store.prototype._read = function (rel, fallback, onCorrupt) {
    var text = null;
    try {
      text = this.adapter.read(rel);
    } catch (e) {
      this.onError('read ' + rel + ': ' + e.message);
      return fallback;
    }
    if (text == null) return fallback;
    try {
      return JSON.parse(text);
    } catch (e) {
      if (onCorrupt) onCorrupt(text, e);
      this.onError('corrupt ' + rel + ': ' + e.message);
      return fallback;
    }
  };

  Store.prototype._write = function (rel, value) {
    var text = typeof value === 'string' ? value : JSON.stringify(value);
    var r;
    try {
      r = this.adapter.write(rel, text);
    } catch (e) {
      this.onError('write ' + rel + ': ' + e.message);
      return { ok: false, error: e.message };
    }
    if (!r || r.ok === false) this.onError('write ' + rel + ': ' + (r && r.error ? r.error : 'unknown'));
    return r || { ok: true };
  };

  Store.prototype.loadBook = function () {
    if (this._book) return this._book;
    var self = this;
    var raw = this._read(BOOK, null, function (text, err) {
      // Preserve the damaged file before starting fresh so nothing is lost.
      try { self.adapter.write(BOOK + '.corrupt-' + Date.now(), text); } catch (e) { }
    });
    this._book = merger.migrate(raw);
    if (raw == null) this._book.updatedAt = new Date(this.now()).toISOString();
    return this._book;
  };

  Store.prototype.saveBook = function (book, at) {
    book.updatedAt = new Date(at == null ? this.now() : at).toISOString();
    this._book = book;
    return this._write(BOOK, book);
  };

  Store.prototype.loadStats = function () {
    if (this._stats) return this._stats;
    this._stats = statsMod.migrate(this._read(STATS, null, function (text) {
      try { this.adapter.write(STATS + '.corrupt-' + Date.now(), text); } catch (e) { }
    }.bind(this)));
    return this._stats;
  };

  Store.prototype.saveStats = function (s) {
    this._stats = s;
    return this._write(STATS, s);
  };

  Store.prototype.loadDeleted = function () {
    if (this._deleted) return this._deleted;
    var raw = this._read(DELETED, null);
    this._deleted = raw && Array.isArray(raw.items) ? raw : emptyDeleted();
    return this._deleted;
  };

  Store.prototype.saveDeleted = function (d) {
    this._deleted = d;
    return this._write(DELETED, d);
  };

  Store.prototype.loadSettings = function () {
    if (this._settings) return this._settings;
    var raw = this._read(SETTINGS, null);
    this._settings = Object.assign(emptySettings(), raw || {});
    return this._settings;
  };

  Store.prototype.saveSettings = function (s) {
    s.updatedAt = new Date(this.now()).toISOString();
    this._settings = s;
    return this._write(SETTINGS, s);
  };

  /* ------------------------------------------------------------- backups */

  Store.prototype.listBackups = function () {
    var items = [];
    try {
      (this.adapter.list(BACKUP_DIR) || []).forEach(function (f) {
        if (f.dir) return;
        // Both manual/pre-import snapshots and the daily ones are restorable.
        if (!/^(wordbook|daily)-.*\.json$/.test(f.name)) return;
        items.push({ name: f.name, size: f.size || 0, mtime: f.mtime || 0 });
      });
    } catch (e) {
      this.onError('list backups: ' + e.message);
    }
    items.sort(function (a, b) { return (b.mtime - a.mtime) || b.name.localeCompare(a.name); });
    this._backups = items;
    return items;
  };

  /**
   * Snapshots the current book before a destructive write. Keeps the newest 7
   * files and a 50MB total budget, deleting the oldest first.
   */
  Store.prototype.backup = function (reason) {
    var book = this.loadBook();
    var count = Object.keys(book.words || {}).length;
    if (count === 0 && !(book.imports && book.imports.length)) return { ok: true, skipped: true };
    var stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    var name = 'wordbook-' + stamp + (reason ? '-' + reason : '') + '.json';
    var existing = this.listBackups();
    var suffix = 1;
    var baseName = name;
    while (existing.some(function (b) { return b.name === name; })) {
      name = baseName.replace(/\.json$/, '-' + (++suffix) + '.json');
    }
    var text = JSON.stringify(book);
    var r = this._write(BACKUP_DIR + '/' + name, text);
    if (!r || r.ok === false) return { ok: false };
    this.pruneBackups();
    return { ok: true, name: name, bytes: text.length };
  };

  Store.prototype.pruneBackups = function () {
    var all = this.listBackups();
    // Daily snapshots live under their own 7-day rule; the rotating cap and the
    // size budget only apply to import/pre-restore snapshots, otherwise a busy
    // week of imports would evict every daily backup.
    var dailies = all.filter(function (f) { return f.name.indexOf('daily-') === 0; });
    var items = all.filter(function (f) { return f.name.indexOf('daily-') !== 0; });
    var total = items.reduce(function (n, f) { return n + (f.size || 0); }, 0);
    var keep = items.slice();
    var removed = [];
    while (keep.length > MAX_BACKUPS || (total > MAX_BACKUP_BYTES && keep.length > 1)) {
      var victim = keep.pop();
      total -= victim.size || 0;
      removed.push(victim.name);
    }
    // Size budget still counts dailies, but they are only dropped past 7 days.
    var dailyBytes = dailies.reduce(function (n, f) { return n + (f.size || 0); }, 0);
    if (total + dailyBytes > MAX_BACKUP_BYTES) {
      this.onError('备份占用已达 ' + util.formatBytes(total + dailyBytes) + '，可在数据面板手动清理');
    }
    removed.forEach(function (n) {
      try { this.adapter.del(BACKUP_DIR + '/' + n); } catch (e) { this.onError('del backup: ' + e.message); }
    }, this);
    return removed;
  };

  Store.prototype.restoreBackup = function (name) {
    var safe = String(name || '').replace(/[^A-Za-z0-9._-]/g, '');
    if (!safe) return { ok: false, error: '非法备份名' };
    var text = this.adapter.read(BACKUP_DIR + '/' + safe);
    if (text == null) return { ok: false, error: '备份不存在' };
    var parsed;
    try { parsed = JSON.parse(text); } catch (e) { return { ok: false, error: '备份已损坏' }; }
    var restore = JSON.parse(JSON.stringify(parsed));
    if ((restore.words && Object.keys(restore.words).length) || (restore.imports && restore.imports.length)) {
      var pre = this.backup('pre-restore');
      if (!pre || pre.ok === false) return { ok: false, error: '恢复前快照失败，已取消' };
    }
    var book = merger.migrate(restore);
    var w = this.saveBook(book);
    if (!w || w.ok === false) return { ok: false, error: '写入失败' };
    return { ok: true, book: book };
  };

  /* ----------------------------------------------------------- operations */

  /** Commits a parsed import plan after a verified backup. */
  Store.prototype.commitPlan = function (plan, choices, opts) {
    opts = opts || {};
    var book = this.loadBook();
    var bk = this.backup('pre-import');
    if (!bk || bk.ok === false) return { ok: false, error: '导入前备份失败，未写入' };
    var next = merger.applyPlan(book, plan, choices, { now: this.now(), mode: opts.mode, source: opts.source });
    var w = this.saveBook(next);
    if (!w || w.ok === false) return { ok: false, error: '写入失败' };
    return { ok: true, book: next, backup: bk.name };
  };

  Store.prototype.commitReplace = function (parsed, opts) {
    opts = opts || {};
    var book = this.loadBook();
    var bk = this.backup('pre-replace');
    if (!bk || bk.ok === false) return { ok: false, error: '覆盖前备份失败，未写入' };
    var res = merger.applyReplace(book, parsed, { now: this.now(), mode: opts.mode, source: opts.source });
    var w = this.saveBook(res.book);
    if (!w || w.ok === false) return { ok: false, error: '写入失败' };
    return { ok: true, book: res.book, dropped: res.dropped, backup: bk.name };
  };

  Store.prototype.deleteWord = function (en, now) {
    now = now || this.now();
    var book = this.loadBook();
    var key = util.wordKey(en);
    var w = book.words[key];
    if (!w) return { ok: false, error: '词条不存在' };
    var d = this.loadDeleted();
    d.items.push({
      at: new Date(now).toISOString(),
      reason: 'delete',
      word: merger.entryView(w),
      createdAt: w.createdAt,
      src: w.src || '',
      srcs: (w.srcs || []).slice(),
      progress: util.deepClone(w.progress)
    });
    if (d.items.length > MAX_DELETED) d.items = d.items.slice(-MAX_DELETED);
    delete book.words[key];
    this.saveDeleted(d);
    var w2 = this.saveBook(book);
    return { ok: !(w2 && w2.ok === false), book: book };
  };

  Store.prototype.restoreDeleted = function (index) {
    var d = this.loadDeleted();
    var item = d.items[index];
    if (!item) return { ok: false, error: '记录不存在' };
    var book = this.loadBook();
    var key = util.wordKey(item.word.en);
    if (book.words[key]) return { ok: false, error: '该词已存在' };
    var w = merger.newWord(item.word.en, {
      phonetic: item.word.phonetic, pos: item.word.pos, zh: item.word.zh,
      collo: item.word.collo, tags: item.word.tags, createdAt: item.createdAt, src: item.src
    });
    w.srcs = (item.srcs || []).slice();
    w.progress = sm2.normalizeProgress(item.progress);
    book.words[key] = w;
    d.items.splice(index, 1);
    this.saveDeleted(d);
    var r = this.saveBook(book);
    return { ok: !(r && r.ok === false) };
  };

  /** Manual edit. Progress untouched; no import record is created. */
  Store.prototype.updateWord = function (en, patch, now) {
    now = now || this.now();
    var book = this.loadBook();
    var w = book.words[util.wordKey(en)];
    if (!w) return { ok: false, error: '词条不存在' };
    ['phonetic', 'pos', 'zh'].forEach(function (f) {
      if (patch && patch[f] != null) w[f] = String(patch[f]);
    });
    if (patch && Array.isArray(patch.collo)) {
      w.collo = patch.collo.map(function (c) { return util.collapseSpaces(String(c)); }).filter(Boolean);
    }
    if (patch && Array.isArray(patch.tags)) {
      var tags = [];
      patch.tags.forEach(function (t) { util.uniqPush(tags, String(t)); });
      w.tags = tags;
    }
    var r = this.saveBook(book, now);
    return { ok: !(r && r.ok === false), word: w };
  };

  Store.prototype.addWordManual = function (entry, now) {
    now = now || this.now();
    var book = this.loadBook();
    var en = String(entry.en || '').trim();
    if (!util.validWord(en)) return { ok: false, error: '单词格式不合法' };
    var key = util.wordKey(en);
    if (book.words[key]) return { ok: false, error: '该词已存在' };
    var w = merger.newWord(en, {
      phonetic: entry.phonetic, pos: entry.pos, zh: entry.zh,
      collo: entry.collo, tags: entry.tags, createdAt: now, src: 'manual'
    });
    w.srcs = ['manual'];
    book.words[key] = w;
    var r = this.saveBook(book);
    return { ok: !(r && r.ok === false), word: w };
  };

  Store.prototype.bulkDelete = function (keys, now) {
    var removed = 0;
    var self = this;
    (keys || []).forEach(function (k) {
      var r = self.deleteWord(k, now);
      if (r.ok) removed++;
    });
    return { ok: true, removed: removed };
  };

  /** Export payloads: full JSON, CSV, and dictionary-style text. */
  Store.prototype.exportAll = function (kind, now) {
    now = now || this.now();
    var book = this.loadBook();
    if (kind === 'csv') return { ok: true, text: toCsv(book), mime: 'text/csv', ext: 'csv' };
    if (kind === 'txt') return { ok: true, text: toDictText(book), mime: 'text/plain', ext: 'txt' };
    return {
      ok: true,
      text: JSON.stringify({ version: merger.SCHEMA_VERSION, updatedAt: new Date(now).toISOString(), words: book.words, imports: book.imports || [] }, null, 2),
      mime: 'application/json', ext: 'json'
    };
  };

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /** CSV exports use · as the multi-value joiner; a literal · inside a value is escaped. */
  function joinMultiCsv(list) {
    return (list || []).map(function (v) {
      return String(v).replace(/·/g, '／');
    }).join('·');
  }

  function toCsv(book) {
    var lines = ['en,phonetic,zh,collo,tags'];
    merger.sortedWords(book, 'added').forEach(function (w) {
      lines.push([
        csvCell(w.en), csvCell(w.phonetic || ''),
        csvCell(((w.pos || '') + ' ' + (w.zh || '')).trim()),
        csvCell(joinMultiCsv(w.collo)),
        csvCell(joinMultiCsv(w.tags))
      ].join(','));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  function toDictText(book) {
    var out = [];
    merger.sortedWords(book, 'added').forEach(function (w) {
      var line = w.en;
      if (w.phonetic) line += ' /' + w.phonetic + '/';
      var meaning = ((w.pos || '') + ' ' + (w.zh || '')).trim();
      if (meaning) line += ' ' + meaning;
      out.push(line);
      (w.collo || []).forEach(function (c) { out.push('- ' + c); });
      out.push('');
    });
    return out.join('\n').replace(/\n+$/, '\n');
  }

  /** Wipes book + stats + deleted; settings survive. Always backs up first. */
  Store.prototype.clearAll = function () {
    var bk = this.backup('pre-clear');
    if (!bk || bk.ok === false) return { ok: false, error: '清空前备份失败，已取消' };
    this._book = merger.emptyBook();
    this._stats = statsMod.empty();
    this._deleted = emptyDeleted();
    var a = this._write(BOOK, this._book);
    var b = this._write(STATS, this._stats);
    var c = this._write(DELETED, this._deleted);
    var ok = (!a || a.ok !== false) && (!b || b.ok !== false) && (!c || c.ok !== false);
    return { ok: ok, backup: bk.name };
  };

  /**
   * One snapshot per calendar day, independent of imports. Uninstalling wipes
   * app-private storage, so the only defence is having a recent copy ready to
   * export before the user removes the app.
   */
  Store.prototype.dailyBackup = function (now) {
    now = now == null ? this.now() : now;
    var book = this.loadBook();
    if (!Object.keys(book.words || {}).length) return { ok: true, skipped: 'empty' };
    var day = util.localDateKey(now);
    var name = 'daily-' + day + '.json';
    try {
      if (this.adapter.read(BACKUP_DIR + '/' + name) != null) return { ok: true, existing: name };
    } catch (e) { /* fall through and write */ }
    var text = JSON.stringify(book);
    var r = this._write(BACKUP_DIR + '/' + name, text);
    if (!r || r.ok === false) return { ok: false };
    this.pruneDaily(now);
    return { ok: true, name: name, bytes: text.length };
  };

  /** Daily snapshots keep only the newest 7 days. */
  Store.prototype.pruneDaily = function (now) {
    now = now == null ? this.now() : now;
    var cutoff = util.addDays(now, -7);
    var removed = [];
    try {
      (this.adapter.list(BACKUP_DIR) || []).forEach(function (f) {
        if (f.dir) return;
        var m = /^daily-(\d{4}-\d{2}-\d{2})\.json$/.exec(f.name);
        if (!m) return;
        var t = util.parseDateKey(m[1]).getTime();
        if (t < cutoff) {
          try { this.adapter.del(BACKUP_DIR + '/' + f.name); removed.push(f.name); } catch (e) { }
        }
      }, this);
    } catch (e) { this.onError('prune daily: ' + e.message); }
    return removed;
  };

  Store.prototype.selfCheck = function () {
    var book = this.loadBook();
    var s = this.loadStats();
    var d = this.loadDeleted();
    var backups = this.listBackups();
    var words = book.words || {};
    var keys = Object.keys(words);
    var progressCount = 0;
    var missingProgress = [];
    var wrong = 0;
    keys.forEach(function (k) {
      var w = words[k];
      if (w.progress && typeof w.progress === 'object') progressCount++;
      else missingProgress.push(k);
      if ((w.tags || []).indexOf('拼写易错') >= 0 || (w.tags || []).indexOf('词义混淆') >= 0) wrong++;
    });
    var sizes = {};
    [BOOK, STATS, DELETED, SETTINGS].forEach(function (rel) {
      try { sizes[rel] = this.adapter.stat(rel) || { exists: false, size: 0 }; }
      catch (e) { sizes[rel] = { exists: false, size: 0, error: e.message }; }
    }, this);
    var info = {};
    try { info = this.adapter.info ? this.adapter.info() : { freeBytes: -1 }; } catch (e) { info = { freeBytes: -1 }; }
    return {
      ok: missingProgress.length === 0,
      adapter: this.adapter.id,
      words: keys.length,
      progress: progressCount,
      missingProgress: missingProgress.slice(0, 20),
      wrong: wrong,
      wrongLimit: 30,
      imports: (book.imports || []).length,
      sessions: (s.sessions || []).length,
      days: Object.keys(s.days || {}).length,
      deleted: (d.items || []).length,
      backups: backups.length,
      backupBytes: backups.reduce(function (n, f) { return n + (f.size || 0); }, 0),
      sizes: sizes,
      freeBytes: info.freeBytes,
      audioFiles: 0,
      version: book.version || 0
    };
  };

  return {
    BOOK: BOOK,
    STATS: STATS,
    DELETED: DELETED,
    SETTINGS: SETTINGS,
    BACKUP_DIR: BACKUP_DIR,
    MAX_BACKUPS: MAX_BACKUPS,
    MAX_BACKUP_BYTES: MAX_BACKUP_BYTES,
    MAX_DELETED: MAX_DELETED,
    Store: Store,
    create: function (adapter, opts) { return new Store(adapter, opts); },
    emptyDeleted: emptyDeleted,
    emptySettings: emptySettings,
    toCsv: toCsv,
    toDictText: toDictText,
    csvCell: csvCell
  };
});
