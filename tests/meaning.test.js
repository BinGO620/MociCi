'use strict';
const test = require('node:test');
const assert = require('node:assert');
const MEANING = require('../app/src/main/assets/js/meaning.js');

const countItems = (r) => {
  const POS = /(^|[\s；;])(v|vt|vi|n|adj|adv|prep|conj|pron|num|art|int|aux|abbr|phr)\.\s*/gi;
  return (r.zh.replace(POS, '$1').match(/[^；;\s]+/g) || []).length;
};

test('meaning: same POS capped at 2 items', () => {
  const r = MEANING.trim('放弃；抛弃；遗弃', 'v.');
  assert.equal(r.zh, '放弃；抛弃');
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].text, '遗弃');
});

test('meaning: dropped items are described for the summary', () => {
  const r = MEANING.trim('放弃；抛弃；遗弃；丢弃', 'v.');
  assert.deepEqual(r.dropped.map(d => d.text), ['遗弃', '丢弃']);
  assert.equal(MEANING.describeDropped(r.dropped), '遗弃、丢弃');
});

test('meaning: cross-POS keeps one each within total 4', () => {
  const r = MEANING.trim('主题；科目 adj. 受影响的', 'n.');
  assert.equal(r.zh, '主题；科目 adj. 受影响的');
  assert.equal(r.dropped.length, 0);
});

test('meaning: two POS with 2 items each stays at total 4', () => {
  const r = MEANING.trim('主题；科目 adj. 受影响的；服从的', 'n.');
  assert.equal(r.zh, '主题；科目 adj. 受影响的；服从的');
  assert.equal(r.dropped.length, 0);
});

test('meaning: total cap 4 still keeps every POS represented', () => {
  const r = MEANING.trim('主题；科目 adj. 受影响的；服从的 adv. 偶然地', 'n.');
  assert.equal(countItems(r), 4);
  assert.ok(r.zh.indexOf('主题') >= 0, r.zh);
  assert.ok(r.zh.indexOf('受影响的') >= 0, r.zh);
  assert.ok(r.zh.indexOf('偶然地') >= 0, r.zh);
});

test('meaning: every POS keeps one item before a second item is added', () => {
  const r = MEANING.trim('甲；乙；丙 adj. 丁', 'n.');
  // n gets 甲 (first pass) and adj gets 丁, then n may take 乙 with the 4th slot.
  assert.ok(r.zh.indexOf('adj. 丁') >= 0, r.zh);
  assert.ok(r.zh.indexOf('甲') >= 0, r.zh);
  assert.ok(countItems(r) <= 4, r.zh);
});

test('meaning: English semicolons split identically to Chinese ones', () => {
  const a = MEANING.trim('放弃;抛弃;遗弃', 'v.');
  const b = MEANING.trim('放弃；抛弃；遗弃', 'v.');
  assert.equal(a.zh, b.zh);
  assert.equal(a.zh, '放弃；抛弃');
});

test('meaning: mixed semicolons are all split', () => {
  const r = MEANING.trim('放弃；抛弃;遗弃', 'v.');
  assert.equal(r.zh, '放弃；抛弃');
  assert.equal(r.dropped.length, 1);
});

test('meaning: empty meaning stays empty with nothing dropped', () => {
  const r = MEANING.trim('', 'v.');
  assert.equal(r.zh, '');
  assert.equal(r.dropped.length, 0);
});

test('meaning: whitespace-only meaning normalizes to empty', () => {
  const r = MEANING.trim('   ；  ', 'v.');
  assert.equal(r.zh, '');
  assert.equal(r.dropped.length, 0);
});

test('meaning: duplicate items within the cap are preserved as written', () => {
  const r = MEANING.trim('放弃；放弃', 'v.');
  assert.equal(r.zh, '放弃；放弃');
});

test('meaning: POS marker inherited from the entry line is not repeated', () => {
  const r = MEANING.trim('主题；科目', 'n.');
  assert.equal(r.zh, '主题；科目');
});

test('meaning: explicit POS marker not in base pos is kept', () => {
  const r = MEANING.trim('adj. 受影响的', 'n.');
  assert.equal(r.zh, 'adj. 受影响的');
});

test('meaning: vt/vi markers are recognised as POS', () => {
  const r = MEANING.trim('放弃；抛弃；遗弃', 'vt.');
  assert.equal(r.zh, '放弃；抛弃');
});

test('meaning: segments preserve source order for frequency sorting', () => {
  const groups = MEANING.parseSegments('一；二 adj. 三', 'n.');
  assert.equal(groups.length, 2);
  assert.equal(groups[0].items.join('|'), '一|二');
  assert.equal(groups[1].items.join('|'), '三');
});

test('meaning: custom caps are honoured', () => {
  const r = MEANING.trim('a；b；c', 'v.', { maxPerPos: 1, maxTotal: 1 });
  assert.equal(r.zh, 'a');
  assert.equal(r.dropped.length, 2);
});

test('meaning: long meanings keep the first items and drop the rest', () => {
  const many = ['一', '二', '三', '四', '五', '六', '七'].join('；');
  const r = MEANING.trim(many, 'v.');
  assert.equal(r.zh, '一；二');
  assert.equal(r.dropped.length, 5);
});

test('meaning: trailing punctuation is stripped before comparing', () => {
  const r = MEANING.trim('; 放弃；抛弃；', 'v.');
  assert.equal(r.zh, '放弃；抛弃');
});

test('meaning: trimming is idempotent', () => {
  const once = MEANING.trim('放弃；抛弃；遗弃', 'v.').zh;
  const twice = MEANING.trim(once, 'v.').zh;
  assert.equal(once, twice);
});

test('meaning: POS substring must not cause false matches (conj. contains n)', () => {
  const r = MEANING.trim('n. 连词', 'conj.');
  assert.equal(r.zh, 'n. 连词', 'n. is a different POS from conj. and must survive');
});

test('meaning: adv. must not swallow a v. marker', () => {
  const r = MEANING.trim('v. 跑', 'adv.');
  assert.equal(r.zh, 'v. 跑');
});

test('meaning: adj. must not swallow a d. look-alike boundary', () => {
  const r = MEANING.trim('adv. 快速地', 'adj.');
  assert.equal(r.zh, 'adv. 快速地');
});

test('meaning: identical POS marker still collapses', () => {
  const r = MEANING.trim('n. 主题', 'n.');
  assert.equal(r.zh, '主题');
});

test('meaning: multi-POS base keeps its marker on the entry, not the text', () => {
  const r = MEANING.trim('n. 主题', 'n. adj.');
  // "n. adj." belongs to the entry-line pos; the meaning text must not repeat it.
  assert.equal(r.zh, '主题');
  const leadRepeats = MEANING.trim('n. adj. 主题；受影响的', 'n. adj.');
  assert.equal(leadRepeats.zh, '主题；受影响的');
});

test('meaning: vt. base does not match a bare t. token', () => {
  const r = MEANING.trim('vi. 不及物', 'vt.');
  assert.equal(r.zh, 'vi. 不及物');
});
