(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'));
  else { root.Moci = root.Moci || {}; root.Moci.appmeta = factory(root.Moci.util); }
})(typeof self !== 'undefined' ? self : this, function (util) {
  'use strict';

  /** The exact prompt shown in-app, copyable in one tap. Never bundled with words. */
  var TEMPLATE = [
    '请按下面的固定格式输出词汇表，不要输出任何解释、标题、编号或代码块围栏。',
    '',
    '格式要求：',
    '1. 每个单词一行，格式为：单词 音标 词性 中文释义',
    '2. 单词必须用原形（动词原形、名词单数、形容词原级），且不含空格',
    '3. 音标用斜杠包裹，如 /əˈbændən/',
    '4. 词性用缩写：v. / n. / adj. / adv. / prep. / conj.',
    '5. 释义按词性分组，每个词性最多 2 个义项，用中文分号「；」分隔；',
    '   按常用程度从高到低排序，多词性单词每个词性至少给 1 个义项',
    '6. 每个单词后面跟 1-3 条常用搭配，每条单独一行，以「- 」开头',
    '7. 搭配格式：英文短语 + 空格 + 中文，可用 sb / sth 作占位符',
    '8. 词与词之间空一行',
    '9. 不要输出重复单词，短语只放在搭配行而不作为独立词条',
    '10. 不要使用全角英文字母，释义不超过 20 字',
    '',
    '示例：',
    'abandon /əˈbændən/ v. 放弃；抛弃',
    '- abandon oneself to 沉溺于',
    '- abandon hope 放弃希望',
    '',
    'ability /əˈbɪləti/ n. 能力；才能',
    '- have the ability to do sth 有能力做某事',
    '',
    'subject /ˈsʌbdʒɪkt/ n. 主题；科目 adj. 受影响的',
    '- be subject to 受制于',
    '',
    '请输出以下内容（把下面三行替换成你的需求）：',
    '六级真题高频动词 100 个，按考频从高到低',
    '（也可以写：考研英语核心词 300 个 / 我收藏的文章里的生词，按出现顺序）',
    '',
    '请把最终词表放在一个 ``` 代码块里输出，代码块内不要有任何解释文字、标题或序号。'
  ].join('\n');

  var GRADING_TEMPLATE = [
    '图片是学生手写的英语听写作业。题目共 {N} 题，按顺序为：',
    '{ITEMS}',
    '',
    '第一步：逐字符忠实转写每一题的书写内容。禁止自动纠正拼写，禁止"顺手改对"。',
    '学生写的是 benifit 就转写 benifit，不要写成 benefit。看不清的字母用 ? 保留。',
    '',
    '判错规则：',
    '1. 手写时单词间空格不可靠（socialsecurity 视为 social security），空格缺失、大小写差异一律不判错',
    '2. 真正的拼写错误（benifit、supress）和介词/搭配用错（cope to）必须判错',
    '3. 识别短语时先对照题目切分手写内容，再逐词判断',
    '',
    '第二步：用转写结果与题目原答案逐词比较后判分。',
    '输出前自查：每题的 wrote/wrote 是否与图片中看到的字母完全一致（包括错误拼写）？',
    '',
    '每题必须带 index（从 1 开始）与题目原答案 en。只输出 JSON：',
    '{"results":[{"index":1,"en":"题目原答案","correct":true,"wrote":"逐字符转写内容","note":"简短点评"}],"score":正确数}'
  ].join('\n');

  function buildGradingPrompt(items) {
    var lines = items.map(function (it, i) {
      return (i + 1) + '. [' + it.type + '] ' + it.answer + (it.prompt ? ' （中文提示：' + it.prompt + '）' : '');
    });
    return GRADING_TEMPLATE.replace('{N}', String(items.length)).replace('{ITEMS}', lines.join('\n'));
  }

  return { TEMPLATE: TEMPLATE, GRADING_TEMPLATE: GRADING_TEMPLATE, buildGradingPrompt: buildGradingPrompt };
});
