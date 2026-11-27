'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../app/src/main/assets/js/grader.js');

test('grader: exact match after trim and case fold', () => {
  assert.equal(G.judgeTyped('  Abandon ', 'abandon').correct, true);
});

test('grader: internal whitespace is collapsed, not removed', () => {
  assert.equal(G.judgeTyped('abandon   oneself    to', 'abandon oneself to').correct, true);
});

test('grader: in to must not equal into', () => {
  assert.equal(G.judgeTyped('in to', 'into').correct, false);
});

test('grader: a lot must not equal alot', () => {
  assert.equal(G.judgeTyped('a lot', 'alot').correct, false);
});

test('grader: some time must not equal sometime', () => {
  assert.equal(G.judgeTyped('some time', 'sometime').correct, false);
});

test('grader: glued words are a keyboard error', () => {
  assert.equal(G.judgeTyped('abandononeself', 'abandon oneself').correct, false);
});

test('grader: real spelling error fails', () => {
  assert.equal(G.judgeTyped('benifit', 'benefit').correct, false);
});

test('grader: preposition error fails', () => {
  assert.equal(G.judgeTyped('cope to', 'cope with').correct, false);
});

test('grader: curly apostrophes and dashes normalized', () => {
  assert.equal(G.judgeTyped('don\u2019t', "don't").correct, true);
  assert.equal(G.judgeTyped('well\u2013being', 'well-being').correct, true);
});

test('grader: fullwidth letters normalized via NFKC', () => {
  assert.equal(G.judgeTyped('ａｂａｎｄｏｎ', 'abandon').correct, true);
});

test('grader: non-breaking space behaves like a space', () => {
  assert.equal(G.judgeTyped('abandon\u00A0hope', 'abandon hope').correct, true);
});

test('grader: zero-width characters ignored', () => {
  assert.equal(G.judgeTyped('aban\u200Bdon', 'abandon').correct, true);
});

test('grader: empty input never counts as correct', () => {
  assert.equal(G.judgeTyped('   ', 'abandon').correct, false);
});

test('handwriting: missing spaces are exempted', () => {
  const r = G.applyHandwritingExemption('socialsecurity', 'social security', false);
  assert.equal(r.correct, true);
  assert.equal(r.exempted, true);
});

test('handwriting: apostrophe omission is exempted', () => {
  assert.equal(G.applyHandwritingExemption('dont', "don't", false).correct, true);
});

test('handwriting: real misspelling still fails', () => {
  assert.equal(G.applyHandwritingExemption('benifit', 'benefit', false).correct, false);
});

test('handwriting: wrong preposition still fails', () => {
  assert.equal(G.applyHandwritingExemption('cope with', 'cope to', false).correct, false);
});

test('handwriting: exemption never overrides a correct verdict', () => {
  const r = G.applyHandwritingExemption('benefit', 'benefit', true);
  assert.equal(r.correct, true);
  assert.equal(r.exempted, false);
});

test('handwriting: exemption applies per question to glued/spaced differences', () => {
  // "into" vs "into" is the same letters, so the answer itself is unaffected;
  // a glued spelling of a spaced answer is exempt, but a different word is not.
  assert.equal(G.applyHandwritingExemption('intotheroom', 'into the room', false).correct, true);
  assert.equal(G.applyHandwritingExemption('intotheroom', 'into the room', true).correct, true);
  assert.equal(G.applyHandwritingExemption('intotheroom', 'into the room', false).exempted, true);
});

test('classify: single-letter slip is a spelling error', () => {
  assert.equal(G.classifyError('benifit', 'benefit'), '拼写易错');
});

test('classify: transposition is a spelling error', () => {
  assert.equal(G.classifyError('recieve', 'receive'), '拼写易错');
});

test('classify: unrelated word is a meaning mix-up', () => {
  assert.equal(G.classifyError('refuse', 'abandon'), '词义混淆');
});

test('classify: empty answer is a meaning mix-up', () => {
  assert.equal(G.classifyError('', 'abandon'), '词义混淆');
});

test('phrase core word: owner wins when it appears in the phrase', () => {
  const known = new Set(['subject']);
  assert.equal(G.coreWordForPhrase('be subject to', 'subject', known), 'subject');
});

test('phrase core word: longest known content word chosen', () => {
  const known = new Set(['subject', 'change']);
  assert.equal(G.coreWordForPhrase('change the subject', 'subject', known), 'subject');
});

test('phrase core word: unknown content words fall back to owner', () => {
  const known = new Set(['subject']);
  assert.equal(G.coreWordForPhrase('in terms of', 'subject', known), 'subject');
});

test('phrase core word: stopwords never become the tag target', () => {
  const known = new Set(['take']);
  assert.equal(G.coreWordForPhrase('take it for granted', 'take', known), 'take');
});

test('inflection: ies, ed, ing candidates generated', () => {
  assert.ok(G.baseCandidates('studies').includes('study'));
  assert.ok(G.baseCandidates('studied').includes('study'));
  assert.ok(G.baseCandidates('studying').includes('study'));
  assert.ok(G.baseCandidates('making').includes('make'));
  assert.ok(G.baseCandidates('stopped').includes('stop'));
  assert.ok(G.baseCandidates('running').includes('run'));
  assert.ok(G.baseCandidates('boxes').includes('box'));
  assert.equal(G.baseCandidates('abandon').length, 0);
});

test('reconcile: model auto-correction of a misspelling is rejected', () => {
  const r = G.reconcileAiVerdict('benifit', 'benefit', true);
  assert.equal(r.correct, false);
  assert.equal(r.note, 'transcription-mismatch');
});

test('reconcile: glued handwriting is exempted to correct', () => {
  const r = G.reconcileAiVerdict('abandononeself', 'abandon oneself', false);
  assert.equal(r.correct, true);
  assert.equal(r.exempted, true);
});

test('reconcile: glued handwriting judged wrong by AI is still corrected', () => {
  assert.equal(G.reconcileAiVerdict('socialsecurity', 'social security', false).correct, true);
});

test('reconcile: wrong preposition stays wrong', () => {
  assert.equal(G.reconcileAiVerdict('cope to', 'cope with', false).correct, false);
  assert.equal(G.reconcileAiVerdict('cope to', 'cope with', true).correct, false);
});

test('reconcile: a text-equal answer is trusted over a wrong AI label', () => {
  const r = G.reconcileAiVerdict('cope with', 'cope with', false);
  assert.equal(r.correct, true);
  assert.equal(r.note, 'text-equal');
});

test('reconcile: keyboard strictness is untouched by the handwriting exemption', () => {
  assert.equal(G.judgeTyped('abandononeself', 'abandon oneself').correct, false);
  assert.equal(G.judgeTyped('in to', 'into').correct, false);
});

test('reconcile: hyphen loss is exempted (well-being vs wellbeing)', () => {
  const r = G.reconcileAiVerdict('wellbeing', 'well-being', false);
  assert.equal(r.correct, true);
  assert.equal(r.exempted, true);
});

test('reconcile: hyphen present in handwriting is a plain text match', () => {
  const r = G.reconcileAiVerdict('well-being', 'well-being', true);
  assert.equal(r.correct, true);
  assert.equal(r.note, 'text-equal');
});

test('reconcile: apostrophe loss is exempted (don\'t vs dont)', () => {
  const r = G.reconcileAiVerdict('dont', "don't", false);
  assert.equal(r.correct, true);
  assert.equal(r.exempted, true);
});

test('reconcile: digits survive normalization (covid-19 vs covid19)', () => {
  const r = G.reconcileAiVerdict('covid19', 'covid-19', false);
  assert.equal(r.correct, true);
  assert.equal(r.exempted, true);
});

test('reconcile: digits that actually differ still fail', () => {
  assert.equal(G.reconcileAiVerdict('covid20', 'covid-19', true).correct, false);
  assert.equal(G.reconcileAiVerdict('covid20', 'covid-19', false).correct, false);
});

test('reconcile: extra letters are never exempted', () => {
  assert.equal(G.reconcileAiVerdict('benifitt', 'benefit', true).correct, false);
  assert.equal(G.reconcileAiVerdict('abandonning', 'abandon', true).correct, false);
});

test('reconcile: missing letters are never exempted', () => {
  assert.equal(G.reconcileAiVerdict('benfit', 'benefit', true).correct, false);
});

test('reconcile: word order is enforced', () => {
  assert.equal(G.reconcileAiVerdict('oneself abandon', 'abandon oneself', true).correct, false);
});

test('reconcile: exemption semantics are consistent with lettersOnly', () => {
  // The exemption compares letters+digits only, matching lettersOnly exactly.
  const pairs = [['wellbeing', 'well-being'], ['dont', "don't"], ['covid19', 'covid-19'], ['socialsecurity', 'social security']];
  pairs.forEach(([wrote, answer]) => {
    assert.equal(G.lettersOnly(wrote), G.lettersOnly(answer), wrote + ' vs ' + answer);
    assert.equal(G.reconcileAiVerdict(wrote, answer, false).exempted, true, wrote);
  });
});

test('reconcile: spaces only difference between two real words is exempted by design', () => {
  // "in to" vs "into": hand-writing cannot reliably show the boundary, so the
  // photo path forgives it; the typed path (judgeTyped) never does.
  assert.equal(G.reconcileAiVerdict('in to', 'into', false).correct, true);
  assert.equal(G.judgeTyped('in to', 'into').correct, false);
});

test('reconcile: empty transcription is never correct', () => {
  assert.equal(G.reconcileAiVerdict('', 'abandon', true).correct, false);
  assert.equal(G.reconcileAiVerdict('   ', 'abandon', true).correct, false);
});
