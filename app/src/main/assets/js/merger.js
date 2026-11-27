(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'), require('./sm2.js'), require('./parser.js'), require('./meaning.js'));
  else {
    root.Moci = root.Moci || {};
    root.Moci.merger = factory(root.Moci.util, root.Moci.sm2, root.Moci.parser, root.Moci.meaning);
  }
})(typeof self !== 'undefined' ? self : this, function (util, sm2, parser, meaning) {
  'use strict';

  var SCHEMA_VERSION = 2;

  function emptyBook() {
    return { version: SCHEMA_VERSION, updatedAt: util.nowIso(), words: {}, imports: [] };
  }

  function newWord(en, opts) {
    opts = opts || {};
    return {
      en: en,
      phonetic: opts.phonetic || '',
      pos: opts.pos || '',
      zh: opts.zh || '',
      collo: (opts.collo || []).slice(),
      tags: (opts.tags || []).slice(),
      createdAt: opts.createdAt == null ? Date.now() : opts.createdAt,
      src: opts.src || '',
      srcs: opts.src ? [opts.src] : [],
      progress: sm2.defaults()
    };
  }

  /** Migrates v1 arrays, missing fields and legacy minute-based intervals. */
  function migrate(input) {
    var book;
    if (!input) return emptyBook();
    if (Array.isArray(input)) {
      book = emptyBook();
      for (var i = 0; i < input.length; i++) {
        var item = input[i];
        if (!item || typeof item !== 'object') continue;
        var en = String(item.en || item.word || '').trim();
        if (!util.validWord(en)) continue;
        var key = util.wordKey(en);
        if (book.words[key]) continue;
        book.words[key] = newWord(en, {
          phonetic: item.phonetic || '',
          pos: item.pos || '',
          zh: item.zh || item.meaning || '',
          collo: Array.isArray(item.collo) ? item.collo : [],
          tags: Array.isArray(item.tags) ? item.tags : [],
          createdAt: Number(item.createdAt) || (1000 + i),
          src: item.src || ''
        });
        book.words[key].progress = sm2.normalizeProgress(item.progress);
      }
      return book;
    }
    book = {
      version: SCHEMA_VERSION,
      updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : util.nowIso(),
      words: {},
      imports: Array.isArray(input.imports) ? input.imports.slice() : []
    };
    var src = input.words || {};
    Object.keys(src).forEach(function (k) {
      var item = src[k];
      if (!item || typeof item !== 'object') return;
      var en = String(item.en || k).trim();
      if (!util.validWord(en)) return;
      var key = util.wordKey(en);
      if (book.words[key]) return;
      var posSplit = item.pos && item.zh ? { pos: item.pos, zh: item.zh } : { pos: item.pos || '', zh: item.zh || '' };
      var w = newWord(en, {
        phonetic: item.phonetic || '',
        pos: posSplit.pos,
        zh: posSplit.zh,
        collo: Array.isArray(item.collo) ? item.collo : [],
        tags: Array.isArray(item.tags) ? item.tags : [],
        createdAt: Number(item.createdAt) || 0,
        src: item.src || ''
      });
      if (Array.isArray(item.srcs)) {
        item.srcs.forEach(function (s) { util.uniqPush(w.srcs, String(s)); });
      }
      if (w.src && w.srcs.indexOf(w.src) < 0) w.srcs.push(w.src);
      var p = item.progress;
      if (sm2.looksLikeLegacyMinuteInterval(p)) {
        p = Object.assign({}, p, { interval: 0 });
      }
      w.progress = sm2.normalizeProgress(p);
      book.words[key] = w;
    });
    return book;
  }

  function sortedWords(book, order) {
    var list = Object.keys(book.words || {}).map(function (k) { return book.words[k]; });
    if (order === 'alpha') {
      list.sort(function (a, b) { return a.en.toLowerCase().localeCompare(b.en.toLowerCase()); });
    } else {
      list.sort(function (a, b) { return (a.createdAt - b.createdAt) || a.en.localeCompare(b.en); });
    }
    return list;
  }

  function findWord(book, en) {
    var key = util.wordKey(en);
    return (book.words && book.words[key]) || null;
  }

  function searchWords(book, query, filters) {
    filters = filters || {};
    var q = util.collapseSpaces(query || '').toLowerCase();
    var out = [];
    sortedWords(book, filters.order || 'added').forEach(function (w) {
      if (filters.bucket && filters.bucket !== 'all') {
        var b = sm2.bucket(w.progress);
        if (filters.bucket === 'wrong') {
          if (!w.tags || w.tags.length === 0) return;
        } else if (filters.bucket === 'due') {
          if (!sm2.isDue(w.progress, filters.now || Date.now())) return;
        } else if (b !== filters.bucket) return;
      }
      if (filters.tag && (w.tags || []).indexOf(filters.tag) < 0) return;
      if (filters.src && (w.srcs || []).indexOf(filters.src) < 0 && w.src !== filters.src) return;
      if (q) {
        var hay = (w.en + ' ' + w.zh + ' ' + (w.collo || []).join(' ') + ' ' + (w.tags || []).join(' ')).toLowerCase();
        if (hay.indexOf(q) < 0) return;
      }
      out.push(w);
    });
    return out;
  }

  function collectPhrases(book) {
    var out = [];
    sortedWords(book, 'added').forEach(function (w) {
      (w.collo || []).forEach(function (c, idx) {
        var split = parser.splitPhraseBody(c);
        out.push({
          id: util.wordKey(w.en) + '#' + idx,
          en: split.en,
          zh: split.zh || '',
          owner: w.en,
          ownerKey: util.wordKey(w.en),
          raw: c
        });
      });
    });
    return out;
  }

  /* ------------------------------------------------------------- merge plan */

  function normalizeEntry(e) {
    return {
      en: String(e.en || '').trim(),
      phonetic: String(e.phonetic || '').trim(),
      pos: String(e.pos || '').trim(),
      zh: String(e.zh || '').trim(),
      dropped: Array.isArray(e.dropped) ? e.dropped.slice() : [],
      collo: Array.isArray(e.collo) ? e.collo.map(function (c) { return util.collapseSpaces(c); }).filter(Boolean) : [],
      tags: Array.isArray(e.tags) ? e.tags.map(function (t) { return util.collapseSpaces(t); }).filter(Boolean) : [],
      line: e.line || 0,
      raw: e.raw || ''
    };
  }

  /**
   * Builds the preview plan. Nothing is mutated here: every entry is classified
   * as added / updated / conflict / unchanged, and no-decision defaults are
   * attached so the UI can confirm in one tap.
   */
  function buildPlan(book, parsed, opts) {
    opts = opts || {};
    var now = opts.now == null ? Date.now() : opts.now;
    var src = opts.src || ('import-' + new Date(now).toISOString().slice(0, 10).replace(/-/g, '') + '-' + (book.imports.length + 1));
    var book0 = book && book.words ? book : emptyBook();

    var added = [];
    var updated = [];
    var trimmedWords = [];
    var unchanged = [];
    var noMeaning = [];
    var createdAt = now;

    var entries = (parsed && parsed.entries ? parsed.entries : []).map(normalizeEntry);

    entries.forEach(function (e) {
      var key = util.wordKey(e.en);
      if (!util.validWord(e.en)) return;
      var existing = book0.words[key];
      var colloAdds = [];
      var tagAdds = [];
      var needPhonetic = false;
      var needMeaning = false;

      if (!existing) {
        createdAt += 1;
        // The parser already applies the meaning policy; re-trim is a no-op that
        // keeps store.updateWord / legacy data safe. The parser's record of what
        // it dropped is what the summary shows.
        var trimmed = meaning.trim(e.zh, '');
        var dropped = (e.dropped && e.dropped.length) ? e.dropped : trimmed.dropped;
        var w = newWord(e.en, {
          phonetic: e.phonetic, pos: e.pos, zh: trimmed.zh, collo: e.collo, tags: e.tags,
          createdAt: createdAt, src: src
        });
        w.line = e.line;
        w.raw = e.raw;
        added.push(w);
        if (dropped.length) {
          trimmedWords.push({ en: e.en, key: key, dropped: dropped, kept: trimmed.zh });
        }
        if (!trimmed.zh) noMeaning.push({ en: e.en, key: key, line: e.line });
        return;
      }

      if (!existing.phonetic && e.phonetic) needPhonetic = true;

      // First import wins: an existing non-empty meaning is never replaced and
      // never reported as a conflict. Only an empty meaning may be filled, and
      // that fill is trimmed like a first import.
      var incomingTrimmed = null;
      if (!existing.zh && e.zh) {
        var fill = meaning.trim(e.zh, '');
        var fillDropped = (e.dropped && e.dropped.length) ? e.dropped : fill.dropped;
        incomingTrimmed = { zh: fill.zh, dropped: fillDropped };
        needMeaning = !!incomingTrimmed.zh;
        if (fillDropped.length) {
          trimmedWords.push({ en: existing.en, key: key, dropped: fillDropped, kept: incomingTrimmed.zh });
        }
      }

      e.collo.forEach(function (c) {
        if (!containsFolded(existing.collo || [], c)) colloAdds.push(c);
      });
      e.tags.forEach(function (t) {
        if (!containsFolded(existing.tags || [], t)) tagAdds.push(t);
      });

      var changes = needPhonetic || needMeaning || colloAdds.length > 0 || tagAdds.length > 0;
      // A differing meaning is ignored outright: not a conflict, not an update.
      // (Manual edits go through store.updateWord, which never trims.)
      if (!changes) {
        unchanged.push(entryView(existing));
        return;
      }
      updated.push({
        key: key,
        en: existing.en,
        incoming: e,
        incomingZh: incomingTrimmed ? incomingTrimmed.zh : '',
        incomingPos: e.pos || existing.pos,
        phonetic: needPhonetic,
        meaning: needMeaning,
        colloAdds: colloAdds,
        tagAdds: tagAdds,
        existing: entryView(existing)
      });
    });

    // Same-batch duplicates already merged by the parser; count upstream.
    var noMeaningSet = {};
    noMeaning.forEach(function (n) { noMeaningSet[n.key] = n; });
    entries.forEach(function (e) {
      var key = util.wordKey(e.en);
      if (!e.zh && !noMeaningSet[key]) noMeaningSet[key] = { en: e.en, key: key, line: e.line };
    });

    var deform = detectDeform(added, updated, book0, entries);

    return {
      version: SCHEMA_VERSION,
      src: src,
      at: new Date(now).toISOString(),
      added: added,
      updated: updated,
      trimmed: trimmedWords,
      unchanged: unchanged,
      noMeaning: Object.keys(noMeaningSet).map(function (k) { return noMeaningSet[k]; }),
      deform: deform,
      unparsed: parsed && parsed.unparsed ? parsed.unparsed : [],
      ignored: parsed && parsed.ignored ? parsed.ignored : [],
      warnings: parsed && parsed.warnings ? parsed.warnings : [],
      counts: {
        addable: added.length + updated.length,
        added: added.length,
        updated: updated.length,
        trimmed: trimmedWords.length,
        unchanged: unchanged.length,
        unparsed: parsed && parsed.unparsed ? parsed.unparsed.length : 0,
        noMeaning: Object.keys(noMeaningSet).length,
        duplicates: parsed && parsed.counts ? parsed.counts.duplicates : 0,
        phoneticFixes: updated.filter(function (u) { return u.phonetic; }).length,
        colloFixes: updated.filter(function (u) { return u.colloAdds.length > 0; }).length,
        tagFixes: updated.filter(function (u) { return u.tagAdds.length > 0; }).length,
        meaningFixes: updated.filter(function (u) { return u.meaning; }).length
      }
    };
  }

  function entryView(w) {
    return {
      en: w.en,
      phonetic: w.phonetic || '',
      pos: w.pos || '',
      zh: w.zh || '',
      collo: (w.collo || []).slice(),
      tags: (w.tags || []).slice()
    };
  }

  function containsFolded(list, value) {
    var v = util.collapseSpaces(value).toLowerCase();
    for (var i = 0; i < list.length; i++) {
      if (util.collapseSpaces(list[i]).toLowerCase() === v) return true;
    }
    return false;
  }

  /**
   * Suggests "inflected form -> base" pairs. Purely heuristic suffix stripping;
   * nothing is merged automatically. Both directions are considered, but a pair
   * is only emitted when the base actually exists in the book or this batch.
   */
  function detectDeform(added, updated, book, entries) {
    var known = {};
    Object.keys(book.words || {}).forEach(function (k) { known[k] = 'book'; });
    entries.forEach(function (e) { known[util.wordKey(e.en)] = 'batch'; });

    var incoming = {};
    added.forEach(function (w) { incoming[util.wordKey(w.en)] = w; });
    updated.forEach(function (u) { if (!known[u.key]) incoming[u.key] = u; });

    var seen = {};
    var out = [];
    function push(from, to, note) {
      var k = from + '>' + to;
      if (seen[k]) return;
      if (from === to) return;
      seen[k] = true;
      out.push({ from: from, to: to, note: note });
    }

    Object.keys(incoming).forEach(function (key) {
      var candidates = graderBaseCandidates(key);
      for (var i = 0; i < candidates.length; i++) {
        if (known[candidates[i]] && candidates[i] !== key) {
          push(key, candidates[i], '疑似 ' + candidates[i] + ' 的变形');
          break;
        }
      }
    });

    // Reverse direction: an existing inflected book word whose base is new.
    Object.keys(book.words || {}).forEach(function (key) {
      if (incoming[key]) return;
      var candidates = graderBaseCandidates(key);
      for (var i = 0; i < candidates.length; i++) {
        if (incoming[candidates[i]]) {
          push(key, candidates[i], '词本已有变形，新词是其原形');
          break;
        }
      }
    });

    return out.slice(0, 50);
  }

  /** Local suffix heuristics; kept dependency-free to avoid a circular import. */
  function graderBaseCandidates(word) {
    var w = String(word || '').toLowerCase();
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
   * Applies a plan. `choices` maps conflict keys to 'keep' | 'overwrite'.
   * Progress and createdAt of existing words are never touched.
   */
  function applyPlan(book, plan, choices, opts) {
    opts = opts || {};
    var out = migrate(book);
    out.imports = out.imports || [];
    var now = opts.now == null ? Date.now() : opts.now;

    plan.added.forEach(function (w) {
      var key = util.wordKey(w.en);
      if (out.words[key]) return;
      out.words[key] = w;
    });

    plan.updated.forEach(function (u) {
      var w = out.words[u.key];
      if (!w) return;
      if (u.phonetic && u.incoming.phonetic && !w.phonetic) w.phonetic = u.incoming.phonetic;
      // First import wins: only an empty meaning is filled, already trimmed.
      if (u.meaning && !w.zh && u.incomingZh) {
        w.zh = u.incomingZh;
        if (u.incomingPos && !w.pos) w.pos = u.incomingPos;
      }
      // Explicit user overwrite (manual edit / opt-in) still wins.
      if (choices && choices[u.key] === 'overwrite' && u.incoming.zh) {
        w.zh = meaning.trim(u.incoming.zh, u.incomingPos || w.pos).zh;
        if (u.incomingPos) w.pos = u.incomingPos;
      }
      (u.colloAdds || []).forEach(function (c) { util.uniqPush(w.collo, c); });
      (u.tagAdds || []).forEach(function (t) { util.uniqPush(w.tags, t); });
      util.uniqPush(w.srcs = w.srcs || [], plan.src);
      w.src = plan.src;
    });

    plan.added.forEach(function (w) {
      var cur = out.words[util.wordKey(w.en)];
      if (cur) { util.uniqPush(cur.srcs = cur.srcs || [], plan.src); cur.src = plan.src; }
    });

    out.imports.push({
      id: plan.src,
      at: new Date(now).toISOString(),
      mode: opts.mode || 'dict',
      source: opts.source || 'paste',
      added: plan.added.length,
      updated: plan.updated.length,
      trimmed: (plan.trimmed || []).length,
      errors: plan.unparsed ? plan.unparsed.length : 0
    });
    if (out.imports.length > 200) out.imports = out.imports.slice(-200);
    out.updatedAt = new Date(now).toISOString();
    return out;
  }

  /** Full replacement import: keeps progress/createdAt/tags for matching keys. */
  function applyReplace(book, parsed, opts) {
    opts = opts || {};
    var now = opts.now == null ? Date.now() : opts.now;
    var old = migrate(book);
    var next = emptyBook();
    var src = opts.src || ('replace-' + new Date(now).toISOString().slice(0, 10).replace(/-/g, '') + '-' + (old.imports.length + 1));
    var createdAt = now;
    var dropped = 0;

    (parsed.entries || []).forEach(function (e) {
      if (!util.validWord(e.en)) return;
      var key = util.wordKey(e.en);
      if (next.words[key]) return;
      var prior = old.words[key];
      createdAt += 1;
      var w = newWord(e.en, {
        phonetic: e.phonetic, pos: e.pos, zh: e.zh, collo: e.collo, tags: e.tags,
        createdAt: prior ? prior.createdAt : createdAt, src: src
      });
      if (prior) {
        w.progress = prior.progress;
        (prior.tags || []).forEach(function (t) { util.uniqPush(w.tags, t); });
        (prior.srcs || []).forEach(function (s) { util.uniqPush(w.srcs, s); });
        if (prior.src) util.uniqPush(w.srcs, prior.src);
      }
      next.words[key] = w;
    });

    Object.keys(old.words).forEach(function (k) {
      if (!next.words[k]) dropped++;
    });

    next.imports = old.imports.slice();
    next.imports.push({
      id: src, at: new Date(now).toISOString(), mode: opts.mode || 'dict',
      source: opts.source || 'paste', added: Object.keys(next.words).length,
      updated: 0, conflicts: 0, errors: parsed && parsed.unparsed ? parsed.unparsed.length : 0,
      replaced: true, dropped: dropped
    });
    if (next.imports.length > 200) next.imports = next.imports.slice(-200);
    next.updatedAt = new Date(now).toISOString();
    return { book: next, dropped: dropped };
  }

  function emptyChoices() { return {}; }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    emptyBook: emptyBook,
    newWord: newWord,
    migrate: migrate,
    sortedWords: sortedWords,
    findWord: findWord,
    searchWords: searchWords,
    collectPhrases: collectPhrases,
    buildPlan: buildPlan,
    applyPlan: applyPlan,
    applyReplace: applyReplace,
    containsFolded: containsFolded,
    detectDeform: detectDeform,
    normalizeEntry: normalizeEntry,
    entryView: entryView,
    emptyChoices: emptyChoices
  };
});
