(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'), require('./meaning.js'));
  else { root.Moci = root.Moci || {}; root.Moci.parser = factory(root.Moci.util, root.Moci.meaning); }
})(typeof self !== 'undefined' ? self : this, function (util, meaning) {
  'use strict';

  var MAX_TEXT = 10 * 1024 * 1024;
  var MAX_LINES = 100000;
  var WARN_TEXT = 200 * 1024;
  var WARN_LINES = 5000;

  var HEADER_LABELS = {
    word: ['单词', '词', 'word', 'words', 'en', 'english', 'spelling'],
    phonetic: ['音标', 'phonetic', 'ipa', 'pronunciation'],
    zh: ['释义', '中文', '意思', '翻译', 'meaning', 'definition', 'zh', 'chinese', 'translation', 'trans'],
    pos: ['词性', 'pos', 'part of speech'],
    collo: ['搭配', '短语', 'collocation', 'collocations', 'phrase', 'phrases'],
    tags: ['标签', 'tag', 'tags', '类别', '分类', 'category']
  };

  /* ---------------------------------------------------------------- fences */

  /**
   * If the text contains a fenced code block, only the first block is parsed.
   * Everything outside is dropped without being counted as unparsable, but is
   * kept so parse() can fall back when the block turns out to be empty.
   */
  function extractFence(text) {
    var lines = String(text == null ? '' : text).split('\n');
    var blocks = [];
    var outside = [];
    var i = 0;
    while (i < lines.length) {
      var m = /^\s*(```+|~~~+)(.*)$/.exec(lines[i]);
      if (!m) { outside.push(lines[i]); i++; continue; }
      var marker = m[1];
      var startLine = i;
      i++;
      var body = [];
      var closed = false;
      while (i < lines.length) {
        var probe = lines[i].trim();
        if (probe.indexOf(marker) === 0) { closed = true; i++; break; }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ body: body, startLine: startLine, closed: closed });
    }
    if (!blocks.length) {
      return { fenced: false, text: String(text == null ? '' : text), blocks: 0, outside: '', outsideLines: [] };
    }
    return {
      fenced: true,
      text: blocks[0].body.join('\n'),
      blocks: blocks.length,
      closed: blocks[0].closed,
      outside: outside.join('\n'),
      outsideLines: outside
    };
  }

  /* ------------------------------------------------------------ entry lines */

  function stripListMarker(line) {
    var s = line;
    s = s.replace(/^\s*#{1,6}\s+/, '');
    s = s.replace(/^\s{0,3}>\s?/, '');
    s = s.replace(/^\s*(?:[-*+•·–—])\s+/, '');
    s = s.replace(/^\s*\d{1,4}\s*[.)、]\s*/, '');
    s = s.replace(/^\s*[（(]\s*\d{1,4}\s*[）)]\s*/, '');
    s = s.replace(/^\s*第\s*\d{1,4}\s*[条项个]?\s*[、.．:：]?\s*/, '');
    s = s.replace(/^\s*\d{1,4}\s*[、]\s*/, '');
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/__([^_]+)__/g, '$1');
    s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1$2');
    s = s.replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1$2');
    s = s.replace(/`([^`]+)`/g, '$1');
    s = s.trim();
    return s;
  }

  function hasExplicitBullet(line) {
    return /^\s*(?:[-*+•·–—])\s+/.test(line);
  }

  function indentWidth(line) {
    var m = /^(\s*)/.exec(line);
    var ws = m ? m[1] : '';
    var w = 0;
    for (var i = 0; i < ws.length; i++) w += ws.charAt(i) === '\t' ? 4 : 1;
    return w;
  }

  /** Reads a leading /.../ or [...] phonetic token. */
  function takePhonetic(s) {
    var t = s.replace(/^[\s:：=.,，\-—|]+/, '');
    if (!t) return null;
    var m = /^([/[])([^/\]]{1,80})([/\]])\s*$/.exec(t);
    if (m && m[1] === '/' && m[3] === '/') return null; // pure token handled by caller
    var open = t.charAt(0);
    if (open !== '/' && open !== '[') return null;
    var close = open === '/' ? '/' : ']';
    var end = t.indexOf(close, 1);
    if (end < 0) return null;
    var body = t.slice(1, end).trim();
    if (!body) return null;
    return { value: body, rest: t.slice(end + 1) };
  }

  /** Consumes a phonetic token at the start of `s`, allowing 英/美 prefixes. */
  function splitPhonetic(s) {
    var t = s.replace(/^[\s:：=.,，\-—|]+/, '');
    if (!t) return null;
    var prefix = '';
    var m0 = /^([英美])\s*[/[]/.exec(t);
    if (m0) { prefix = m0[1]; t = t.slice(prefix.length).trim(); }
    if (t.charAt(0) !== '/' && t.charAt(0) !== '[') return null;
    var close = t.charAt(0) === '/' ? '/' : ']';
    var end = t.indexOf(close, 1);
    if (end < 0) return { value: '', prefix: prefix, rest: s, unclosed: true };
    return { value: t.slice(1, end).trim(), prefix: prefix, rest: t.slice(end + 1) };
  }

  function takePos(s) {
    var m = /^([A-Za-z][A-Za-z. ]{0,9}?\.)\s*/.exec(s);
    if (!m) return null;
    var tok = m[1].trim();
    if (!util.isPosToken(tok)) return null;
    return { value: tok, rest: s.slice(m[0].length) };
  }

  function stripSeparator(s) {
    return s.replace(/^[\s:：=,，\-—|]+/, '');
  }

  function firstCjk(s) { return util.firstCJKIndex(s); }

  /**
   * Classifies one non-empty, de-bulleted line.
   * Returns:
   *   {kind:'entry', en, phonetic, pos, zh}
   *   {kind:'phrase', en, zh}
   *   {kind:'ignore'}
   *   {kind:'unparsed', reason}
   *
   * Rule: a phonetic token or a leading POS marker is a strong signal of a word
   * entry; without either, a second English word before the first CJK char
   * means the line is a phrase.
   */
  function analyzeLine(line) {
    var s = util.cleanLine(line).trim();
    if (!s) return { kind: 'ignore' };
    if (/^[-=_*]{3,}$/.test(s)) return { kind: 'ignore' };
    if (/^#{1,6}\s+/.test(s)) return { kind: 'ignore' };

    var body = stripListMarker(s);
    if (!body) return { kind: 'ignore' };

    var wm = /^([A-Za-z][A-Za-z'\-]*)/.exec(body);
    if (!wm) {
      if (util.hasCJK(body)) return { kind: 'ignore' };
      return { kind: 'unparsed', reason: 'no-english', raw: line };
    }

    var en = wm[1];
    var rest = body.slice(wm[0].length);
    var phonetic = '';
    var pos = '';
    var strong = false;
    var warns = [];

    var ph = splitPhonetic(rest);
    if (ph && ph.unclosed) {
      // A missing closing slash must not turn a word entry into a phrase.
      var body2 = rest.replace(/^[\s:：=.,，\-—|]+/, '');
      var inner = body2.slice(1);
      var ws = inner.search(/\s/);
      var candidate = (ws < 0 ? inner : inner.slice(0, ws)).trim();
      if (candidate && !util.hasCJK(candidate) && candidate.length <= 60 && !/\.$/.test(candidate)) {
        phonetic = candidate;
        rest = ws < 0 ? '' : inner.slice(ws);
        warns.push('phonetic-unclosed');
      }
      strong = true;
    } else if (ph) {
      phonetic = ph.value;
      rest = ph.rest;
      strong = true;
    }

    var guard = 0;
    while (guard++ < 6) {
      var p = takePos(stripSeparator(rest));
      if (!p) break;
      pos = pos ? pos + ' ' + p.value : p.value;
      rest = p.rest;
      strong = true;
    }

    rest = stripSeparator(rest);
    var cjkAt = firstCjk(rest);
    var beforeCjk = cjkAt >= 0 ? rest.slice(0, cjkAt) : rest;
    if (!strong && hasExtraEnglish(beforeCjk)) {
      var split = splitPhraseBody(body);
      if (!split.en) return { kind: 'unparsed', reason: 'no-english', raw: line };
      return { kind: 'phrase', en: split.en, zh: split.zh, raw: line };
    }

    var posSplit = splitPosFromMeaning(pos, util.collapseSpaces(rest).replace(/^[\s:：=,，\-—|]+/, ''));
    // posSplit.zh is already free of the entry-line markers, so trimming gets an
    // empty basePos: a genuine "adj. ..." inside the text stays in the text.
    var trimmed = meaning ? meaning.trim(posSplit.zh, '') : { zh: posSplit.zh, dropped: [] };
    if (trimmed.dropped && trimmed.dropped.length) warns = warns.concat(['meaning-trimmed']);
    return {
      kind: 'entry', en: en, phonetic: phonetic, pos: posSplit.pos, zh: trimmed.zh,
      dropped: trimmed.dropped || [], warns: warns, raw: line
    };
  }

  function hasExtraEnglish(s) {
    if (!s) return false;
    var tokens = s.match(/[A-Za-z][A-Za-z'\-]*/g);
    if (!tokens) return false;
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i].length >= 2) return true;
    }
    return false;
  }

  /** Splits "abandon oneself to 沉溺于" into en/zh at the first CJK char. */
  function splitPhraseBody(body) {
    var clean = util.cleanLine(body).trim();
    var idx = firstCjk(clean);
    if (idx < 0) {
      return { en: util.collapseSpaces(clean), zh: '', noZh: true };
    }
    return {
      en: util.collapseSpaces(clean.slice(0, idx)),
      zh: util.collapseSpaces(clean.slice(idx))
    };
  }

  /* -------------------------------------------------------------- dict mode */

  function parseDict(text) {
    var lines = String(text == null ? '' : text).split('\n');
    var entries = [];
    var unparsed = [];
    var ignored = [];
    var warnings = [];
    var current = null;

    function openEntry(a) {
      return {
        en: a.en,
        phonetic: a.phonetic || '',
        pos: a.pos || '',
        zh: a.zh || '',
        // Carried through so the import summary can report what the meaning
        // policy dropped; the analyzer already trimmed zh.
        dropped: (a.dropped || []).slice(),
        collo: [],
        tags: [],
        raw: a.raw || ''
      };
    }

    function commit() {
      if (!current) return;
      if (!util.validWord(current.en)) {
        unparsed.push({ line: current.line, raw: current.raw, reason: 'bad-word' });
        current = null;
        return;
      }
      entries.push(current);
      current = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var rawLine = lines[i];
      var trimmed = util.cleanLine(rawLine).trim();
      if (!trimmed) { commit(); continue; }
      if (/^[-=_*]{3,}$/.test(trimmed)) { commit(); continue; }
      if (/^#{1,6}\s+/.test(trimmed)) { commit(); ignored.push({ line: i, raw: rawLine }); continue; }

      var indent = indentWidth(rawLine);
      var bullet = hasExplicitBullet(rawLine);
      var body = stripListMarker(trimmed);

      if (bullet || indent >= 2) {
        // A bulleted/indented line may still be a word entry (P0-3 fix).
        var inner = analyzeLine(body);
        if (inner.kind === 'entry' && (inner.phonetic || inner.pos || !inner.zh)) {
          commit();
          current = openEntry(inner);
          current.line = i;
          continue;
        }
        if (!current) {
          var orphan = splitPhraseBody(body);
          if (!orphan.en) unparsed.push({ line: i, raw: rawLine, reason: 'no-english' });
          else unparsed.push({ line: i, raw: rawLine, reason: 'phrase-without-parent' });
          continue;
        }
        var split = splitPhraseBody(body);
        if (!split.en) { unparsed.push({ line: i, raw: rawLine, reason: 'no-english' }); continue; }
        if (!split.zh) warnings.push({ line: i, code: 'phrase-no-zh', raw: rawLine });
        util.uniqPush(current.collo, split.zh ? split.en + ' ' + split.zh : split.en);
        continue;
      }

      var a = analyzeLine(trimmed);
      if (a.kind === 'ignore') { ignored.push({ line: i, raw: rawLine }); continue; }
      if (a.kind === 'unparsed') { unparsed.push({ line: i, raw: rawLine, reason: a.reason }); continue; }
      if (a.kind === 'phrase') {
        if (current) {
          if (!a.zh) warnings.push({ line: i, code: 'phrase-no-zh', raw: rawLine });
          util.uniqPush(current.collo, a.zh ? a.en + ' ' + a.zh : a.en);
          warnings.push({ line: i, code: 'phrase-missing-marker', raw: rawLine });
        } else {
          unparsed.push({ line: i, raw: rawLine, reason: 'phrase-without-parent' });
        }
        continue;
      }
      commit();
      current = openEntry(a);
      current.line = i;
    }
    commit();

    return { entries: entries, unparsed: unparsed, ignored: ignored, warnings: warnings };
  }

  /* ------------------------------------------------------------- csv / table */

  function parseDelimited(text, delim) {
    var s = String(text == null ? '' : text);
    var rows = [];
    var i = 0, line = 1, rowLine = 1;
    var cell = '', row = [], inQ = false;
    while (i < s.length) {
      var ch = s.charAt(i);
      if (inQ) {
        if (ch === '"') {
          if (s.charAt(i + 1) === '"') { cell += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        if (ch === '\n') line++;
        cell += ch; i++; continue;
      }
      if (ch === '"' && cell === '') { inQ = true; i++; continue; }
      if (ch === delim) { row.push(cell); cell = ''; i++; continue; }
      if (ch === '\n') {
        row.push(cell);
        rows.push({ cells: row, line: rowLine });
        row = []; cell = ''; line++; rowLine = line; i++; continue;
      }
      if (ch === '\r') { i++; continue; }
      cell += ch; i++;
    }
    if (cell !== '' || row.length) {
      row.push(cell);
      rows.push({ cells: row, line: rowLine });
    }
    return rows;
  }

  function nonEmptyRows(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].cells;
      var any = false;
      for (var j = 0; j < cells.length; j++) if (String(cells[j]).trim()) { any = true; break; }
      if (any) out.push({ cells: cells, line: rows[i].line, index: i });
    }
    return out;
  }

  function looksLikeHeaderRow(cells) {
    var matched = {};
    var hits = 0;
    for (var i = 0; i < cells.length; i++) {
      var c = String(cells[i] == null ? '' : cells[i]).trim().toLowerCase()
        .replace(/[\s_\-]/g, '').replace(/[*`]/g, '');
      if (!c) continue;
      for (var key in HEADER_LABELS) {
        if (matched[key]) continue;
        var labels = HEADER_LABELS[key];
        for (var k = 0; k < labels.length; k++) {
          if (c === labels[k]) { matched[key] = true; hits++; break; }
        }
      }
    }
    return hits >= 2;
  }

  function headerMapping(cells) {
    var map = { word: -1, phonetic: -1, zh: -1, pos: -1, collo: -1, tags: -1, skipHeader: true, confidence: 0 };
    for (var i = 0; i < cells.length; i++) {
      var c = String(cells[i] || '').trim().toLowerCase().replace(/[\s_\-]/g, '');
      for (var key in HEADER_LABELS) {
        if (map[key] >= 0) continue;
        var labels = HEADER_LABELS[key];
        for (var k = 0; k < labels.length; k++) {
          if (c === labels[k]) { map[key] = i; break; }
        }
      }
    }
    if (map.word < 0) map.word = 0;
    // Confidence reflects what the header actually told us: an explicit word
    // column plus at least one meaning column is trustworthy; a guessed word
    // column alone is not.
    var conf = 0.4;
    if (map.phonetic >= 0 || map.pos >= 0) conf += 0.15;
    if (map.zh >= 0) conf += 0.3;
    if (map.collo >= 0 || map.tags >= 0) conf += 0.15;
    map.confidence = Math.min(0.98, conf);
    return map;
  }

  function columnStats(rows) {
    var width = 0;
    rows.forEach(function (r) { width = Math.max(width, r.cells.length); });
    var stats = [];
    for (var c = 0; c < width; c++) {
      var total = 0, words = 0, phonetic = 0, cjk = 0, collo = 0, pos = 0, nonEmpty = 0;
      rows.forEach(function (r) {
        var v = String(r.cells[c] == null ? '' : r.cells[c]).trim();
        total++;
        if (!v) return;
        nonEmpty++;
        if (util.validWord(v)) words++;
        if (/^[/[]/.test(v)) phonetic++;
        if (util.hasCJK(v)) cjk++;
        if (util.hasCJK(v) && /[·;•]/.test(v) && /[A-Za-z]{2,}/.test(v)) collo++;
        if (/^(v|n|adj|adv|prep|conj|pron|num|vt|vi|abbr|phr)\./i.test(v)) pos++;
      });
      stats.push({
        col: c,
        rows: total,
        nonEmpty: nonEmpty,
        wordScore: total ? words / total : 0,
        phoneticScore: total ? phonetic / total : 0,
        cjkScore: total ? cjk / total : 0,
        colloScore: total ? collo / total : 0,
        posScore: total ? pos / total : 0
      });
    }
    return stats;
  }

  function inferMapping(rows) {
    if (!rows.length) {
      return { word: 0, phonetic: -1, zh: -1, pos: -1, collo: -1, tags: -1, skipHeader: false, confidence: 0, width: 0 };
    }
    if (looksLikeHeaderRow(rows[0].cells)) {
      var hm = headerMapping(rows[0].cells);
      hm.width = rows.reduce(function (n, r) { return Math.max(n, r.cells.length); }, 0);
      return hm;
    }

    var stats = columnStats(rows);
    var map = { word: 0, phonetic: -1, zh: -1, pos: -1, collo: -1, tags: -1, skipHeader: false, confidence: 0, width: stats.length };

    // 1) word column = highest valid-word ratio, leftmost on ties
    var wordScore = 0;
    stats.forEach(function (s) {
      if (s.wordScore > wordScore) { wordScore = s.wordScore; map.word = s.col; }
    });
    if (wordScore === 0) map.word = 0;

    var rest = stats.filter(function (s) { return s.col !== map.word; });

    // 2) phonetic column = mostly /.../ or [...]
    var ph = null;
    rest.forEach(function (s) {
      if (s.phoneticScore >= 0.5 && (!ph || s.phoneticScore > ph.phoneticScore)) ph = s;
    });
    if (ph) map.phonetic = ph.col;

    // 3) pos column = pure part-of-speech tokens (no CJK)
    var posCol = null;
    rest.forEach(function (s) {
      if (s.col === map.phonetic) return;
      if (s.posScore >= 0.6 && s.cjkScore < 0.4 && s.nonEmpty === s.rows) posCol = s;
    });
    if (posCol) map.pos = posCol.col;

    // 4) zh column = strongest CJK column without collocation markers
    var cjkCols = rest.filter(function (s) {
      return s.cjkScore >= 0.4 && s.col !== map.phonetic && s.col !== map.pos;
    });
    var zhPick = null;
    cjkCols.forEach(function (s) {
      if (s.colloScore >= 0.3) return;
      if (!zhPick || s.cjkScore > zhPick.cjkScore) zhPick = s;
    });
    if (!zhPick && cjkCols.length) {
      zhPick = cjkCols.reduce(function (a, b) { return b.cjkScore > a.cjkScore ? b : a; });
    }
    if (zhPick) map.zh = zhPick.col;

    // 5) collo / tags = remaining CJK columns, left to right
    cjkCols.forEach(function (s) {
      if (s.col === map.zh) return;
      if (map.collo < 0) map.collo = s.col;
      else if (map.tags < 0) map.tags = s.col;
    });

    var conf = wordScore;
    if (map.zh >= 0) conf = Math.min(1, conf + 0.1);
    if (map.phonetic >= 0 || map.pos >= 0 || map.collo >= 0) conf = Math.min(1, conf + 0.05);
    map.confidence = wordScore >= 0.85 && map.zh >= 0 ? Math.max(conf, 0.85) : conf * 0.7;
    return map;
  }

  /**
   * Picks the most stable delimiter. With `loose`, any delimiter yielding at
   * least two columns is acceptable — used when the user forced table mode and
   * supplied a column mapping, so detection only needs to split lines.
   */
  function detectDelimiter(text, loose) {
    var candidates = [',', ';', '\t', '|', '\uFF5C'];
    var best = null;
    for (var i = 0; i < candidates.length; i++) {
      var delim = candidates[i];
      var rows = nonEmptyRows(parseDelimited(text, delim));
      if (!rows.length) continue;
      var counts = rows.map(function (r) { return r.cells.length; });
      var max = Math.max.apply(null, counts);
      if (max < 2) continue;

      if (loose) {
        var scoreLoose = Math.min(max, 8) * 10 + rows.length;
        if (best === null || scoreLoose > best.score) {
          best = { delimiter: delim, rows: rows, score: scoreLoose, columns: max, stability: 1, header: false };
        }
        continue;
      }

      var freq = {}, mode = 0, modeCount = 0;
      counts.forEach(function (c) {
        freq[c] = (freq[c] || 0) + 1;
        if (freq[c] > modeCount) { modeCount = freq[c]; mode = c; }
      });
      var share = modeCount / rows.length;
      var minCols = Math.min.apply(null, counts);
      var maxCols = Math.max.apply(null, counts);

      var header = looksLikeHeaderRow(rows[0].cells);
      var body = header ? rows.slice(1) : rows;

      // First column must look like words for 2-column tables; this keeps
      // dictionary lines such as "abandon v. 放弃；抛弃" out of table mode.
      var col0Words = rows.filter(function (r) {
        return util.validWord(String(r.cells[0] == null ? '' : r.cells[0]).trim());
      }).length / rows.length;
      var anyCjk = rows.some(function (r) {
        return r.cells.some(function (c) { return util.hasCJK(String(c)); });
      });

      var twoCol = body.length > 0 && body.every(function (r) {
        var a = String(r.cells[0] == null ? '' : r.cells[0]).trim();
        var b = String(r.cells[1] == null ? '' : r.cells[1]).trim();
        return (util.validWord(a) && util.hasCJK(b)) || (util.validWord(b) && util.hasCJK(a));
      });

      var qualifies = false;
      if (header && maxCols >= 2) qualifies = true;
      else if (maxCols >= 3 && share >= 0.6) qualifies = true;
      else if (minCols >= 2 && col0Words >= 0.9 && anyCjk && delim !== ',') qualifies = true;
      else if (delim === ',' && minCols >= 3 && col0Words >= 0.9 && anyCjk) qualifies = true;
      else if (twoCol) qualifies = true;
      if (!qualifies) continue;

      // Prefer an explicit header, then column-count * stability.
      var score = (header ? 100 : 0) + Math.min(mode, 8) * share * 10 + (twoCol ? 5 : 0);
      if (best === null || score > best.score) {
        best = {
          delimiter: delim, rows: rows, score: score, columns: mode,
          stability: share, header: header
        };
      }
    }
    return best;
  }

  function looksLikeTable(text, opts) {
    var name = (opts && opts.filename ? String(opts.filename) : '').toLowerCase();
    if (/\.(csv|tsv)$/.test(name)) return true;
    var probe = detectDelimiter(text);
    return !!probe;
  }

  function splitMulti(value, seps) {
    var re = new RegExp('[' + seps + ']');
    return String(value || '').split(re).map(function (s) { return util.collapseSpaces(s); })
      .filter(function (s) { return !!s; });
  }

  function parseTable(text, mappingOverride) {
    var probe = detectDelimiter(text, !!mappingOverride);
    var entries = [];
    var unparsed = [];
    var ignored = [];
    var warnings = [];
    if (!probe) {
      return { entries: entries, unparsed: unparsed, ignored: ignored, warnings: warnings, mapping: null, delimiter: null };
    }
    var rows = probe.rows;
    var mapping = mappingOverride || inferMapping(rows);
    var start = mapping.skipHeader ? 1 : 0;
    for (var i = start; i < rows.length; i++) {
      var cells = rows[i].cells;
      var raw = cells.join(probe.delimiter === '\t' ? '\t' : probe.delimiter);
      var word = String(cells[mapping.word] == null ? '' : cells[mapping.word]).trim();
      if (!word) { unparsed.push({ line: rows[i].line, raw: raw, reason: 'empty-word' }); continue; }
      if (!util.validWord(word)) {
        unparsed.push({ line: rows[i].line, raw: raw, reason: 'bad-word' });
        continue;
      }
      var phonetic = mapping.phonetic >= 0 ? String(cells[mapping.phonetic] || '').trim() : '';
      phonetic = phonetic.replace(/^[/[]+/, '').replace(/[/\]]+$/, '').trim();
      var pos = mapping.pos >= 0 ? String(cells[mapping.pos] || '').trim() : '';
      var zh = mapping.zh >= 0 ? String(cells[mapping.zh] || '').trim() : '';
      var posSplit = splitPosFromMeaning(pos, zh);
      pos = posSplit.pos;
      zh = posSplit.zh;
      var collo = mapping.collo >= 0 ? splitMulti(cells[mapping.collo], '·•;；\\n') : [];
      var tags = mapping.tags >= 0 ? splitMulti(cells[mapping.tags], '·•;；,，') : [];
      entries.push({
        en: word, phonetic: phonetic, pos: pos, zh: zh,
        collo: collo, tags: tags, raw: raw, line: rows[i].line
      });
    }
    return {
      entries: entries, unparsed: unparsed, ignored: ignored, warnings: warnings,
      mapping: mapping, delimiter: probe.delimiter,
      mappingWidth: probe.columns || (rows.length ? rows[0].cells.length : 0),
      tableRows: rows.slice(0, 40).map(function (r) { return { line: r.line, cells: r.cells.slice(0, 10) }; }),
      mappingConfidence: mappingOverride ? 1 : (mapping.confidence == null ? 0 : mapping.confidence)
    };
  }

  /* ------------------------------------------------------------------- json */

  /** Extracts the first JSON array/object from prose-wrapped text. */
  function tryExtractJson(text) {
    var src = String(text == null ? '' : text).trim();
    if (!src) return null;
    var starts = ['[', '{'];
    for (var s = 0; s < starts.length; s++) {
      var open = starts[s];
      var close = open === '[' ? ']' : '}';
      var a = src.indexOf(open);
      if (a < 0) continue;
      var b = src.lastIndexOf(close);
      if (b <= a) continue;
      var slice = src.slice(a, b + 1);
      try {
        var d = JSON.parse(slice);
        if (Array.isArray(d) || (d && typeof d === 'object')) return d;
      } catch (e) { /* try next bracket kind */ }
    }
    return null;
  }

  /** Moves a leading POS chain out of a meaning string. */
  function splitPosFromMeaning(pos, zh) {
    var leftover = String(zh == null ? '' : zh).trim();
    var parsed = String(pos == null ? '' : pos).trim();
    if (!leftover) return { pos: parsed, zh: leftover };
    var guard = 0;
    while (guard++ < 6) {
      var p = takePos(leftover);
      if (!p) break;
      parsed = parsed ? parsed + ' ' + p.value : p.value;
      leftover = stripSeparator(p.rest);
    }
    return { pos: parsed, zh: leftover };
  }

  function parseJson(text) {
    var data = tryExtractJson(text);
    if (data == null) return null;
    var list = null;
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.words)) list = data.words;
    else if (data && Array.isArray(data.data)) list = data.data;
    if (!list) return null;

    var entries = [];
    var unparsed = [];
    var warnings = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        unparsed.push({ line: i + 1, raw: JSON.stringify(item), reason: 'not-object' });
        continue;
      }
      var en = String(item.en != null ? item.en : (item.word != null ? item.word : '')).trim();
      if (!util.validWord(en)) {
        unparsed.push({ line: i + 1, raw: JSON.stringify(item), reason: 'bad-word' });
        continue;
      }
      var colloRaw = item.collo != null ? item.collo : (item.collocations != null ? item.collocations : item.phrases);
      var collo = [];
      if (Array.isArray(colloRaw)) {
        colloRaw.forEach(function (c) { util.uniqPush(collo, util.collapseSpaces(String(c))); });
      } else if (typeof colloRaw === 'string') {
        collo = splitMulti(colloRaw, '·•;；\\n');
      }
      var tagsRaw = item.tags;
      var tags = [];
      if (Array.isArray(tagsRaw)) tagsRaw.forEach(function (t) { util.uniqPush(tags, String(t)); });
      else if (typeof tagsRaw === 'string') tags = splitMulti(tagsRaw, '·•;；,，');

      var zh = item.zh != null ? item.zh : (item.meaning != null ? item.meaning : (item.definition != null ? item.definition : (item.trans != null ? item.trans : '')));
      var posSplit = splitPosFromMeaning(item.pos, zh);
      entries.push({
        en: en,
        phonetic: String(item.phonetic != null ? item.phonetic : (item.ipa || '')).replace(/^[/[]+/, '').replace(/[/\]]+$/, '').trim(),
        pos: posSplit.pos,
        zh: posSplit.zh,
        collo: collo,
        tags: tags,
        raw: JSON.stringify(item),
        line: i + 1
      });
    }
    return { entries: entries, unparsed: unparsed, ignored: [], warnings: warnings };
  }

  /* ------------------------------------------------------------------- main */

  function dedupe(entries, warnings) {
    var byKey = new Map();
    var merged = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var key = util.wordKey(e.en);
      if (!key) continue;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key: key, en: e.en, phonetic: e.phonetic || '', pos: e.pos || '',
          zh: e.zh || '', dropped: (e.dropped || []).slice(),
          collo: (e.collo || []).slice(), tags: (e.tags || []).slice(),
          raw: e.raw || '', line: e.line || 0
        });
        continue;
      }
      merged++;
      var cur = byKey.get(key);
      if (!cur.phonetic && e.phonetic) cur.phonetic = e.phonetic;
      if (!cur.pos && e.pos) cur.pos = e.pos;
      if (!cur.zh && e.zh) cur.zh = e.zh;
      else if (cur.zh && e.zh && cur.zh !== e.zh) {
        warnings.push({ line: e.line || 0, code: 'same-batch-conflict', raw: e.raw || '', detail: cur.zh + ' / ' + e.zh });
      }
      (e.dropped || []).forEach(function (d) { cur.dropped.push(d); });
      (e.collo || []).forEach(function (c) { util.uniqPush(cur.collo, c); });
      (e.tags || []).forEach(function (t) { util.uniqPush(cur.tags, t); });
    }
    return { entries: Array.from(byKey.values()), merged: merged };
  }

  function parse(text, opts) {
    opts = opts || {};
    var started = Date.now();
    var raw = String(text == null ? '' : text);
    if (raw.length > MAX_TEXT) {
      return failure('文本过大（上限 10MB），请分批导入');
    }
    var lineCount = raw.split('\n').length;
    if (lineCount > MAX_LINES) {
      return failure('行数过多（上限 10 万行），请分批导入');
    }

    var warnings = [];
    if (raw.length > WARN_TEXT) warnings.push({ code: 'large-text', detail: raw.length });
    if (lineCount > WARN_LINES) warnings.push({ code: 'many-lines', detail: lineCount });

    var fence = extractFence(raw);
    var bodyText = fence.text;
    var fenced = fence.fenced;
    var extraBlocks = fenced ? Math.max(0, fence.blocks - 1) : 0;

    var forced = opts.mode && opts.mode !== 'auto' ? opts.mode : null;
    var mode = forced;
    if (!mode) {
      if (parseJsonProbe(bodyText)) mode = 'json';
      else if (looksLikeTable(bodyText, opts)) mode = 'table';
      else mode = 'dict';
    }

    var bodyResult = runMode(mode, bodyText, opts);
    var fallbackUsed = false;
    var outside = fence.fenced ? fence.outside : '';

    if (fenced && bodyResult.entries.length === 0 && outside.trim()) {
      var outsideMode = forced || detectMode(outside, opts);
      var retry = runMode(outsideMode, outside, opts);
      if (retry.entries.length > 0) {
        bodyResult = retry;
        mode = outsideMode;
        fallbackUsed = true;
        warnings.push({ code: 'fence-fallback' });
      }
    }

    var deduped = dedupe(bodyResult.entries, warnings);
    var allWarnings = warnings.concat(bodyResult.warnings || []);

    var counts = {
      added: deduped.entries.length,
      unparsed: bodyResult.unparsed.length,
      ignored: bodyResult.ignored.length,
      duplicates: deduped.merged,
      extraBlocks: extraBlocks,
      lines: lineCount
    };

    return {
      ok: true,
      mode: mode,
      fenced: fenced,
      extraBlocks: extraBlocks,
      fallbackUsed: fallbackUsed,
      outsideIgnored: fenced && outside.trim() && !fallbackUsed,
      delimiter: bodyResult.delimiter || null,
      mapping: bodyResult.mapping || null,
      mappingWidth: bodyResult.mappingWidth || (bodyResult.mapping && bodyResult.mapping.width) || 0,
      tableRows: bodyResult.tableRows || [],
      mappingConfidence: bodyResult.mappingConfidence == null ? (mode === 'table' ? (bodyResult.mapping ? bodyResult.mapping.confidence : 0) : 1) : bodyResult.mappingConfidence,
      entries: deduped.entries,
      unparsed: bodyResult.unparsed,
      ignored: bodyResult.ignored,
      warnings: allWarnings,
      counts: counts,
      elapsedMs: Date.now() - started
    };
  }

  function parseJsonProbe(text) {
    var t = String(text || '').trim();
    if (!t) return false;
    if (t.indexOf('[') < 0 && t.indexOf('{') < 0) return false;
    var d = tryExtractJson(t);
    if (!d) return false;
    if (Array.isArray(d)) return true;
    return !!(d && (Array.isArray(d.words) || Array.isArray(d.data)));
  }

  function detectMode(text, opts) {
    if (parseJsonProbe(text)) return 'json';
    if (looksLikeTable(text, opts)) return 'table';
    return 'dict';
  }

  function runMode(mode, text, opts) {
    if (mode === 'json') {
      var j = parseJson(text);
      if (j) return j;
      return { entries: [], unparsed: [{ line: 1, raw: text.slice(0, 200), reason: 'json-invalid' }], ignored: [], warnings: [] };
    }
    if (mode === 'table') {
      var t = parseTable(text, opts && opts.mapping);
      if (!t.mapping) {
        return { entries: [], unparsed: [{ line: 1, raw: text.slice(0, 200), reason: 'no-table' }], ignored: [], warnings: [] };
      }
      return t;
    }
    return parseDict(text);
  }

  function failure(message) {
    return {
      ok: false, error: message, mode: 'dict', entries: [], unparsed: [], ignored: [],
      warnings: [], counts: { added: 0, unparsed: 0, ignored: 0, duplicates: 0, extraBlocks: 0, lines: 0 },
      elapsedMs: 0
    };
  }

  return {
    extractFence: extractFence,
    analyzeLine: analyzeLine,
    splitPhraseBody: splitPhraseBody,
    parseDict: parseDict,
    parseDelimited: parseDelimited,
    detectDelimiter: detectDelimiter,
    looksLikeTable: looksLikeTable,
    inferMapping: inferMapping,
    headerMapping: headerMapping,
    looksLikeHeaderRow: looksLikeHeaderRow,
    columnStats: columnStats,
    parseTable: parseTable,
    parseJson: parseJson,
    parseJsonProbe: parseJsonProbe,
    detectMode: detectMode,
    dedupe: dedupe,
    parse: parse
  };
});
