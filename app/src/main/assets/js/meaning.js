(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'));
  else { root.Moci = root.Moci || {}; root.Moci.meaning = factory(root.Moci.util); }
})(typeof self !== 'undefined' ? self : this, function (util) {
  'use strict';

  var DEFAULT_MAX_PER_POS = 2;
  var DEFAULT_MAX_TOTAL = 4;

  var POS_MARK_RE = /(^|[\s;；])((?:v|vt|vi|n|adj|adv|prep|conj|pron|num|art|int|interj|aux|abbr|phr)\.)\s*/gi;

  /**
   * Splits a meaning string into POS groups, preserving source order.
   * POS markers may appear anywhere (start, after a semicolon, or mid-segment
   * such as "科目 adj. 受影响的"), so the scan is global rather than per-segment.
   * Items before the first marker inherit `basePos`.
   */
  function parseSegments(zh, basePos) {
    var raw = util.collapseSpaces(String(zh == null ? '' : zh)).trim();
    if (!raw) return [];

    // A leading run like "n. adj." belongs to the entry-line pos, not to the
    // meaning text: strip it before scanning, otherwise "adj." becomes an item.
    // Only markers already covered by basePos are dropped; a genuinely different
    // leading POS (base "conj." with text "n. 连词") must survive.
    var leadRe = /^\s*(v|vt|vi|n|adj|adv|prep|conj|pron|num|art|int|interj|aux|abbr|phr)\.\s*/i;
    var stripped = raw;
    var guard = 0;
    while (guard++ < 6) {
      var lm = leadRe.exec(stripped);
      if (!lm) break;
      if (!basePosContains(basePos, lm[1] + '.')) break;
      stripped = stripped.slice(lm[0].length);
    }
    raw = stripped.trim();
    if (!raw) return [];

    var marks = [];
    POS_MARK_RE.lastIndex = 0;
    var m;
    while ((m = POS_MARK_RE.exec(raw)) !== null) {
      var start = m.index + m[1].length;
      marks.push({
        at: start,
        end: start + m[2].length,
        pos: m[2].replace(/\.$/, '').toLowerCase() + '.'
      });
      if (m.index === POS_MARK_RE.lastIndex) POS_MARK_RE.lastIndex++;
    }

    var chunks = [];
    if (!marks.length) {
      chunks.push({ pos: basePos ? String(basePos).trim() : '', text: raw });
    } else {
      var pre = raw.slice(0, marks[0].at).trim();
      if (pre) chunks.push({ pos: basePos ? String(basePos).trim() : '', text: pre });
      for (var i = 0; i < marks.length; i++) {
        var end = i + 1 < marks.length ? marks[i + 1].at : raw.length;
        var text = raw.slice(marks[i].end, end).trim();
        if (text) chunks.push({ pos: marks[i].pos, text: text });
      }
    }

    var groups = [];
    var byPos = {};
    chunks.forEach(function (c) {
      var items = c.text.split(/[;；]/).map(function (s) {
        return util.collapseSpaces(s).replace(/^[\s:：=,，\-—|]+/, '').replace(/[\s:：=,，\-—|]+$/, '').trim();
      }).filter(Boolean);
      if (!items.length) return;
      var key = c.pos || '';
      if (byPos[key]) {
        byPos[key].items = byPos[key].items.concat(items);
        return;
      }
      var g = { pos: c.pos, items: items };
      byPos[key] = g;
      groups.push(g);
    });
    return groups;
  }

  /**
   * True when the entry-line pos already covers this group's pos. Compared as
   * whole tokens: `basePosContains('conj.', 'n.')` must be false, because a
   * substring test would drop a genuine `n.` marker and lose a meaning slot.
   */
  /** True when basePos already declares this pos (token-wise, multi-POS aware). */
  function basePosContains(basePos, pos) {
    var targets = String(pos || '').toLowerCase().match(/[a-z]+/g) || [];
    if (!targets.length) return false;
    var tokens = String(basePos || '').toLowerCase().match(/[a-z]+/g) || [];
    for (var i = 0; i < targets.length; i++) {
      if (tokens.indexOf(targets[i]) < 0) return false;
    }
    return true;
  }

  /** Rebuilds the meaning string, keeping the first group's marker only when needed. */
  /**
   * Rebuilds the meaning string. A group marker is only re-emitted when the
   * group genuinely has a POS of its own; markers inherited from the entry line
   * stay on the entry (so "n. adj." + bare text does not grow a phantom marker).
   */
  function rebuild(groups, basePos) {
    if (!groups.length) return '';
    var out = groups[0].text;
    if (groups[0].pos && groups[0].promote) out = groups[0].pos + ' ' + out;
    for (var i = 1; i < groups.length; i++) {
      out += ' ' + groups[i].pos + ' ' + groups[i].text;
    }
    return out;
  }

  /**
   * Trims meanings to "at most N per POS, at least one per POS, at most M total".
   * Priority is source order (the prompt asks for frequency order), with a first
   * pass guaranteeing every POS group contributes one item — so a 3-POS word
   * under a total cap of 4 yields 1+1+1 plus one more, never 2+2.
   */
  function trim(zh, basePos, opts) {
    opts = opts || {};
    var maxPerPos = opts.maxPerPos == null ? DEFAULT_MAX_PER_POS : opts.maxPerPos;
    var maxTotal = opts.maxTotal == null ? DEFAULT_MAX_TOTAL : opts.maxTotal;

    var groups = parseSegments(zh, basePos);
    if (!groups.length) return { zh: '', dropped: [], groups: [] };

    var keep = groups.map(function () { return []; });
    var total = 0;

    // Pass 1: one item per POS group, in source order.
    for (var i = 0; i < groups.length && total < maxTotal; i++) {
      if (groups[i].items.length) { keep[i].push(groups[i].items[0]); total++; }
    }
    // Passes 2..N: extra items only while every group already has its first AND
    // the per-POS cap is not exceeded.
    var covered = groups.every(function (g, gi) { return !g.items.length || keep[gi].length > 0; });
    if (covered) {
      for (var round = 1; round < maxPerPos && total < maxTotal; round++) {
        for (var k = 0; k < groups.length && total < maxTotal; k++) {
          if (groups[k].items.length > round) { keep[k].push(groups[k].items[round]); total++; }
        }
      }
    }

    var dropped = [];
    groups.forEach(function (g, gi) {
      for (var d = keep[gi].length; d < g.items.length; d++) {
        dropped.push({ pos: g.pos, text: g.items[d] });
      }
    });

    var outGroups = [];
    groups.forEach(function (g, gi) {
      if (!keep[gi].length) return;
      outGroups.push({
        pos: g.pos,
        text: keep[gi].join('；'),
        promote: !!(g.pos && !basePosContains(basePos, g.pos))
      });
    });

    return { zh: rebuild(outGroups, basePos), dropped: dropped, groups: outGroups };
  }

  /** Stable, human-readable description of what a trim removed. */
  function describeDropped(dropped) {
    return (dropped || []).map(function (d) { return d.text; }).join('、');
  }

  return {
    DEFAULT_MAX_PER_POS: DEFAULT_MAX_PER_POS,
    DEFAULT_MAX_TOTAL: DEFAULT_MAX_TOTAL,
    parseSegments: parseSegments,
    trim: trim,
    rebuild: rebuild,
    describeDropped: describeDropped
  };
});
