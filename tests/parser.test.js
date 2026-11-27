'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../app/src/main/assets/js/parser.js');

const SAMPLE = `abandon /əˈbændən/ v. 放弃；抛弃；遗弃
  - abandon oneself to 沉溺于
  - abandon hope 放弃希望

ability /əˈbɪləti/ n. 能力；才能
  - have the ability to do sth 有能力做某事

subject /ˈsʌbdʒɪkt/ n. 主题；科目 adj. 受…影响的
  - be subject to 受制于
`;

test('dict: parses three entries with collocations', () => {
  const r = P.parse(SAMPLE);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'dict');
  assert.equal(r.entries.length, 3);
  assert.equal(r.entries[0].en, 'abandon');
  assert.equal(r.entries[0].phonetic, 'əˈbændən');
  assert.equal(r.entries[0].pos, 'v.');
  // Meaning policy: 2 items per POS on first import.
  assert.equal(r.entries[0].zh, '放弃；抛弃');
  assert.deepEqual(r.entries[0].collo, ['abandon oneself to 沉溺于', 'abandon hope 放弃希望']);
  assert.equal(r.entries[1].collo.length, 1);
  assert.equal(r.entries[2].collo.length, 1);
  assert.equal(r.unparsed.length, 0);
});

test('dict: multi-pos in one line is kept and restorable', () => {
  const r = P.parse('subject /ˈsʌbdʒɪkt/ n. 主题；科目 adj. 受…影响的');
  const e = r.entries[0];
  assert.equal(e.pos, 'n.');
  assert.equal(e.zh, '主题；科目 adj. 受…影响的');
  assert.ok((e.pos + ' ' + e.zh).includes('受…影响的'));
});

test('dict: leading pos chain before the meaning is captured', () => {
  const r = P.parse('subject n. adj. 主题；受影响的');
  const e = r.entries[0];
  assert.equal(e.pos, 'n. adj.');
  assert.equal(e.zh, '主题；受影响的');
});

test('dict: markdown bold, ordered list, code fence removed', () => {
  const text = '```\n1. **abandon** /əˈbændən/ v. 放弃\n2. **ability** /əˈbɪləti/ n. 能力\n```';
  const r = P.parse(text);
  assert.equal(r.fenced, true);
  assert.equal(r.mode, 'dict');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].en, 'abandon');
  assert.equal(r.entries[1].en, 'ability');
});

test('dict: only first fenced block is parsed and outside text is dropped', () => {
  const text = '我先说明一下：\n```\nabandon v. 放弃\n```\n\n```\nability n. 能力\n```\n请复制上面的内容';
  const r = P.parse(text);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].en, 'abandon');
  assert.equal(r.extraBlocks, 1);
  assert.equal(r.outsideIgnored, true);
  assert.equal(r.counts.unparsed, 0);
});

test('dict: fence language tag is ignored', () => {
  const r = P.parse('```text\nabandon v. 放弃\n```');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].en, 'abandon');
});

test('dict: unclosed fence reads to end of text', () => {
  const r = P.parse('```\nabandon v. 放弃\nability n. 能力');
  assert.equal(r.entries.length, 2);
});

test('dict: falls back to outside text when the first fence is empty', () => {
  const text = 'abandon v. 放弃\nability n. 能力\n```\n\n```';
  const r = P.parse(text);
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 2);
  assert.equal(r.fallbackUsed, true);
  assert.ok(r.warnings.some(w => w.code === 'fence-fallback'));
});

test('dict: fullwidth separators and colons normalized', () => {
  const r = P.parse('abandon：放弃；抛弃\nability｜/əˈbɪləti/｜n. 能力');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].en, 'abandon');
  assert.equal(r.entries[0].zh, '放弃；抛弃');
});

test('dict: tab aligned input works', () => {
  const r = P.parse('abandon\t/əˈbændən/\tv.\t放弃\nability\tn.\t能力');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].phonetic, 'əˈbændən');
  assert.equal(r.entries[0].pos, 'v.');
});

test('dict: word without meaning is accepted (allowed empty zh)', () => {
  const r = P.parse('abandon\nability n. 能力');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].zh, '');
});

test('dict: bracketed phonetic and 英/美 prefixes', () => {
  const r = P.parse('abandon [əˈbændən] v. 放弃\nability 英/əˈbɪləti/ n. 能力');
  assert.equal(r.entries[0].phonetic, 'əˈbændən');
  assert.equal(r.entries[1].phonetic, 'əˈbɪləti');
});

test('dict: unclosed phonetic with CJK does not crash', () => {
  const r = P.parse('abandon /əˈbændən v. 放弃');
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].en, 'abandon');
  assert.ok(r.entries[0].zh.includes('放弃'));
});

test('dict: indented entry line is an entry, not a collocation (P0-3)', () => {
  const text = 'abandon v. 放弃\n    ability n. 能力\n    - have the ability 有能力';
  const r = P.parse(text);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].collo.length, 0);
  assert.equal(r.entries[1].en, 'ability');
  assert.deepEqual(r.entries[1].collo, ['have the ability 有能力']);
});

test('dict: bulleted entry line with phonetic stays an entry', () => {
  const r = P.parse('- abandon /əˈbændən/ v. 放弃\n- ability /əˈbɪləti/ n. 能力');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].en, 'abandon');
});

test('dict: phrase without a parent becomes unparsed', () => {
  const r = P.parse('- abandon oneself to 沉溺于');
  assert.equal(r.entries.length, 0);
  assert.equal(r.unparsed.length, 1);
  assert.equal(r.unparsed[0].reason, 'phrase-without-parent');
});

test('dict: top-level phrase after an entry is attached with a warning', () => {
  const r = P.parse('abandon v. 放弃\nabandon hope 放弃希望');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].collo.length, 1);
  assert.ok(r.warnings.some(w => w.code === 'phrase-missing-marker'));
});

test('dict: duplicate collocations deduped', () => {
  const r = P.parse('abandon v. 放弃\n- abandon hope 放弃希望\n- abandon hope 放弃希望\n- ABANDON  HOPE 放弃希望');
  assert.equal(r.entries[0].collo.length, 1);
});

test('dict: same-batch duplicate words merged', () => {
  const r = P.parse('abandon v. 放弃\nabandon n. 放任\n- abandon hope 放弃希望');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].zh, '放弃');
  assert.equal(r.counts.duplicates, 1);
  assert.ok(r.warnings.some(w => w.code === 'same-batch-conflict'));
});

test('dict: hyphen and apostrophe allowed, spaces rejected', () => {
  const r = P.parse("well-being n. 幸福\ndon't v. 不要\nnot a word n. 错误");
  const keys = r.entries.map(e => e.en);
  assert.ok(keys.includes('well-being'));
  assert.ok(keys.includes("don't"));
});

test('dict: pure english line without CJK is a phrase candidate or ignore', () => {
  const r = P.parse('abandon v. 放弃\nsome random english sentence here\n- ok 好');
  assert.equal(r.entries.length, 1);
  assert.ok(r.entries[0].collo.length >= 1);
});

test('dict: heading lines ignored, not counted as unparsed', () => {
  const r = P.parse('# 六级核心词汇\nabandon v. 放弃\n## 分组二\nability n. 能力');
  assert.equal(r.entries.length, 2);
  assert.ok(r.ignored.length >= 2);
});

test('dict: BOM + CRLF handled', () => {
  const r = P.parse('\uFEFFabandon v. 放弃\r\nability n. 能力\r\n');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].en, 'abandon');
});

test('dict: example sentences inside meaning are preserved', () => {
  const r = P.parse('abandon v. 放弃。Example: He abandoned his car.');
  assert.equal(r.entries[0].en, 'abandon');
  assert.ok(r.entries[0].zh.includes('He abandoned'));
});

test('dict: trailing separators stripped from meaning', () => {
  const r = P.parse('abandon v.: 放弃');
  assert.equal(r.entries[0].pos, 'v.');
  assert.equal(r.entries[0].zh, '放弃');
});

test('table: pipe format with 4 columns', () => {
  const r = P.parse('abandon | /əˈbændən/ | v. 放弃；抛弃 | abandon oneself to 沉溺于 · abandon hope 放弃希望');
  assert.equal(r.mode, 'table');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].en, 'abandon');
  assert.equal(r.entries[0].pos, 'v.');
  assert.equal(r.entries[0].collo.length, 2);
});

test('table: csv with header and quoted comma', () => {
  const text = '单词,音标,释义,搭配,标签\nabandon,/əˈbændən/,"放弃；抛弃, 遗弃",abandon hope 放弃希望,拼写易错';
  const r = P.parse(text);
  assert.equal(r.mode, 'table');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].zh, '放弃；抛弃, 遗弃');
  assert.equal(r.entries[0].tags[0], '拼写易错');
});

test('table: two-column comma csv is detected', () => {
  const r = P.parse('abandon, 放弃\nability, 能力');
  assert.equal(r.mode, 'table');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].zh, '放弃');
});

test('table: tab separated beats dictionary mode', () => {
  const r = P.parse('abandon\t/əˈbændən/\tv. 放弃\nability\t/əˈbɪləti/\tn. 能力');
  assert.equal(r.mode, 'table');
  assert.equal(r.entries.length, 2);
});

test('table: quoted newline inside a cell', () => {
  const text = 'word,zh\nabandon,"放弃\n抛弃"';
  const r = P.parse(text);
  assert.equal(r.entries.length, 1);
  assert.ok(r.entries[0].zh.includes('抛弃'));
});

test('table: escaped double quotes', () => {
  const text = 'word,zh\nsay,"说""引用"""';
  const r = P.parse(text);
  assert.equal(r.entries[0].zh, '说"引用"');
});

test('table: ragged rows fill missing cells', () => {
  const text = 'word,phonetic,zh\nabandon,/əˈbændən/\nability';
  const r = P.parse(text);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].phonetic, 'əˈbændən');
});

test('table: missing word column row goes to unparsed', () => {
  const text = 'word,zh\n,放弃\nability,能力';
  const r = P.parse(text);
  assert.equal(r.entries.length, 1);
  assert.equal(r.unparsed.length, 1);
});

test('table: semicolon delimiter supported', () => {
  const r = P.parse('abandon;/əˈbændən/;v. 放弃\nability;n. 能力');
  assert.equal(r.mode, 'table');
  assert.equal(r.entries.length, 2);
});

test('table: fullwidth pipe delimiter', () => {
  const r = P.parse('abandon｜/əˈbændən/｜v. 放弃\nability｜n. 能力');
  assert.equal(r.mode, 'table');
  assert.equal(r.entries.length, 2);
});

test('table: header synonyms recognized', () => {
  const m = P.headerMapping(['word', 'ipa', 'meaning', 'collocation', 'tags']);
  assert.equal(m.word, 0);
  assert.equal(m.phonetic, 1);
  assert.equal(m.zh, 2);
  assert.equal(m.collo, 3);
  assert.equal(m.tags, 4);
  assert.equal(m.skipHeader, true);
});

test('table: manual mapping override reorders columns', () => {
  const text = '放弃,abandon\n能力,ability';
  const r = P.parse(text, { mode: 'table', mapping: { word: 1, zh: 0, phonetic: -1, pos: -1, collo: -1, tags: -1, skipHeader: false, confidence: 1 } });
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].en, 'abandon');
  assert.equal(r.entries[0].zh, '放弃');
});

test('table: low confidence exposed for UI to expand mapping', () => {
  const text = 'one two three four, five\nsix seven, eight nine';
  const r = P.parse(text, { mode: 'table' });
  assert.equal(r.ok, true);
  assert.ok(r.mappingConfidence <= 1);
});

test('json: bare array', () => {
  const text = JSON.stringify([{ en: 'abandon', phonetic: '/əˈbændən/', zh: 'v. 放弃', collo: ['abandon hope 放弃希望'] }]);
  const r = P.parse(text);
  assert.equal(r.mode, 'json');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].pos, 'v.');
  assert.equal(r.entries[0].collo.length, 1);
});

test('json: wrapped in words/data and prose', () => {
  const text = '好的，这是词表：\n{ "words": [{"word":"ability","meaning":"能力"}] }\n以上。';
  const r = P.parse(text);
  assert.equal(r.mode, 'json');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].en, 'ability');
});

test('json: invalid items collected, not fatal', () => {
  const text = JSON.stringify([{ en: 'abandon', zh: '放弃' }, 'oops', { en: 'bad word' }]);
  const r = P.parse(text);
  assert.equal(r.entries.length, 1);
  assert.equal(r.unparsed.length, 2);
});

test('json: fenced json block', () => {
  const r = P.parse('```json\n[{"en":"abandon","zh":"放弃"}]\n```');
  assert.equal(r.mode, 'json');
  assert.equal(r.entries.length, 1);
});

test('mode: invalid json falls through to dictionary', () => {
  const r = P.parse('[{ en: abandon, zh: 放弃 }]');
  assert.equal(r.mode, 'dict');
});

test('limits: oversized text rejected with error', () => {
  const r = P.parse('a'.repeat(10 * 1024 * 1024 + 1));
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('10MB'));
});

test('limits: large text flagged as warning only', () => {
  const big = 'abandon v. 放弃\n'.repeat(12000);
  const r = P.parse(big);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some(w => w.code === 'large-text') || r.warnings.some(w => w.code === 'many-lines'));
});

test('timing: elapsedMs present', () => {
  const r = P.parse(SAMPLE);
  assert.equal(typeof r.elapsedMs, 'number');
});
