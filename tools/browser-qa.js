#!/usr/bin/env node
/**
 * Browser QA harness: connects to headless Chrome over the DevTools protocol
 * using only Node built-ins (no puppeteer), exercises the real UI, and saves
 * screenshots. Usage: node tools/browser-qa.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.QA_BASE || 'http://127.0.0.1:8098';
const OUT = path.resolve(__dirname, '../build/shots');
const PORT = 9222;

fs.mkdirSync(OUT, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    return cdp;
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); }
      }, 30000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error('eval failed: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}


async function goHome(cdp) {
  // Full-screen flows expose different escape labels; try them in order.
  const labels = ['回首页', '回词本', '返回修改', '取消', '返回'];
  for (const label of labels) {
    const hit = await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true;})()`);
    await sleep(250);
    if (!hit) continue;
    const hasTabs = await cdp.eval(`document.querySelectorAll('.tabs button').length`);
    if (hasTabs) break;
  }
  await cdp.eval(`(()=>{const t=document.querySelectorAll('.tabs button');if(t[0])t[0].click();})()`);
  await sleep(300);
}

let qaStep = '';
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  -> ' + detail : ''));
}

(async () => {
  const userDir = path.resolve(__dirname, '../build/chrome-qa-profile');
  fs.rmSync(userDir, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir,
    '--window-size=420,900', '--hide-scrollbars',
    'about:blank'
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await getJson('http://127.0.0.1:' + PORT + '/json/list'); break; }
    catch (e) { await sleep(250); }
  }
  if (!targets) { console.error('could not reach chrome'); process.exit(1); }
  const page = targets.find(t => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });

  await cdp.send('Page.navigate', { url: BASE + '/index.html' });
  await sleep(1200);

  // 0. empty state
  const emptyText = await cdp.eval('document.body.innerText');
  check('空态给出明确的下一步', emptyText.includes('粘贴词表导入'));
  check('空态提供引导出口', emptyText.includes('不知道怎么准备词表'));
  check('空态说明三步', emptyText.includes('复制提示词'));
  check('空态无内置词', !/abandon/.test(emptyText));
  await cdp.shot('01-empty');

  // 1. template sheet
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('不知道怎么准备词表')).click()`);
  await sleep(400);
  // The template is now an editable textarea so users can customise it.
  const tpl = await cdp.eval("document.querySelector('#sheet textarea') ? document.querySelector('#sheet textarea').value : ''");
  check('提示词模板可打开', tpl.includes('请按下面的固定格式输出词汇表'));
  check('模板含代码块硬要求', tpl.includes('请把最终词表放在一个'));
  check('模板可按类别选择需求', tpl.includes('【六级】') && tpl.includes('【雅思】'));
  check('模板不再混入考研示例', !tpl.includes('考研'));
  check('模板可编辑并提供保存', (await cdp.eval("[...document.querySelectorAll('#sheet button')].some(b=>b.textContent.indexOf('保存为我的模板')>=0)")));
  await cdp.shot('02-template');
  await cdp.eval(`document.querySelector('#sheet').remove()`);

  // 2. import with two fenced blocks + dirty data
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='粘贴词表导入').click()`);
  await sleep(300);
  const dirty = [
    '我先说一句。',
    '```text',
    '1. **abandon** /əˈbændən/ v. 放弃；抛弃；遗弃',
    '  - abandon oneself to 沉溺于',
    '  - abandon hope 放弃希望',
    '',
    'ability /əˈbɪləti/ n. 能力；才能',
    '  - have the ability to do sth 有能力做某事',
    '',
    'subject /ˈsʌbdʒɪkt/ n. 主题；科目 adj. 受…影响的',
    '  - be subject to 受制于',
    '',
    'benefit v. 利益；好处',
    '  - for the benefit of 为了…的利益',
    '```',
    '```',
    'study n. 学习',
    '```',
    '请复制上面的代码块。'
  ].join('\n');
  await cdp.eval(`(()=>{const t=document.querySelector('#import-text');t.value=${JSON.stringify(dirty)};})()`);

  const clicked = await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='导入');if(!b)return 'NOBTN';b.click();return 'CLICKED'+(window.MociApp.state.import?'/state-import':'');})()`);
  console.log('  [debug] import click ->', clicked);
  const errText = await cdp.eval("(()=>{const e=document.querySelector('#errbar');return e&&e.className.indexOf('show')>=0?e.innerText.slice(0,200):'NO ERROR';})()");
  console.log('  [debug] errbar ->', errText);
  const taVal = await cdp.eval("(()=>{const t=document.querySelector('#import-text');return t?t.value.length+' chars':'NO TA';})()");
  console.log('  [debug] textarea ->', taVal);
  for (let w = 0; w < 20; w++) {
    const onSummary = await cdp.eval("!!(window.MociApp.state.import) && document.body.innerText.indexOf('本次导入') >= 0");
    if (onSummary) break;
    await sleep(150);
  }
  const sum = await cdp.eval('document.body.innerText');
  check('摘要显示可导入数', /可导入\s*4\s*个词/.test(sum), sum.split('\n').slice(0, 6).join(' | '));
  check('摘要按钮带数字', /确认导入 4 词/.test(sum));
  check('只解析首个代码块', sum.includes('已忽略其余 1 个代码块'));
  await cdp.shot('03-summary');

  // 3. details folding
  await cdp.eval(`document.querySelector('details.fold summary').click()`);
  await sleep(300);
  const det = await cdp.eval('document.body.innerText');
  check('详情显示解析模式', det.includes('词典式'));
  await cdp.shot('04-details');

  // 4. confirm import
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('确认导入')).click()`);
  await sleep(500);
  const done = await cdp.eval('document.body.innerText');
  check('导入完成页', done.includes('导入完成') && done.includes('新增 4'));
  check('完成页说明发音准备方式', done.includes('真人发音') && done.includes('自动补齐'));
  await cdp.shot('05-import-done');

  // 5. home with words (the completion page's "回词本" goes to the book tab,
  // so switch to home explicitly afterwards)
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='回词本');if(b)b.click();})()`);
  await sleep(300);
  await cdp.eval(`document.querySelectorAll('.tabs button')[0].click()`);
  await sleep(350);
  const home = await cdp.eval('document.body.innerText');
  check('首页显示已掌握 X / Y', /已掌握\s*0\s*\/\s*4\s*词/.test(home), home.split('\n')[0]);
  check('首页显示今日到期', home.includes('今日到期'));
  await cdp.shot('06-home');

  // 6. study
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='开始学习');if(b)b.click();})()`);
  await sleep(500);
  const study = await cdp.eval('document.body.innerText');
  check('学习卡出现', /1 \/ 4/.test(study), study.split('\n').slice(0, 6).join(' | '));
  await cdp.shot('07-study-front');
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('翻面看释义')).click()`);
  await sleep(300);
  const flipped = await cdp.eval('document.body.innerText');
  check('翻面显示释义', flipped.includes('放弃') || flipped.includes('能力') || flipped.includes('主题') || flipped.includes('利益') || flipped.includes('学习'));
  await cdp.shot('08-study-back');

  // advance through all cards, stopping when study hands over to dictation
  for (let i = 0; i < 20; i++) {
    const label = await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>['下一张','进入听写'].includes(x.textContent)||x.textContent.includes('翻面看释义'));return b?b.textContent:'';})()`);
    if (!label) break;
    await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>['下一张','进入听写'].includes(x.textContent)||x.textContent.includes('翻面看释义'));b.click();})()`);
    await sleep(220);
    if (label === '进入听写') break;
  }
  await sleep(300);

  // 7. dictation type mode
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('键入听写')).click()`);
  await sleep(400);
  const q1 = await cdp.eval('document.body.innerText');
  check('听写进入选择题面', /第 1 \/ \d+ 题/.test(q1), q1.split('\n').find(l => l.includes('题')) || '');
  await cdp.shot('09-dictate-1');

  // answer the first three questions: one deliberately wrong
  for (let i = 0; i < 3; i++) {
    const info = await cdp.eval(`(()=>{const inp=document.querySelector('#answer');return inp?{has:true}:{has:false};})()`);
    if (!info.has) break;
    const answer = await cdp.eval(`(()=>{const app=window.MociApp;const s=app.state.session;const q=s.questions[s.qIndex];return q.answer;})()`);
    const wrong = i === 1;
    await cdp.eval(`(()=>{const t=document.querySelector('#answer');t.value=${JSON.stringify('zzz')};})()` .replace('"zzz"', JSON.stringify(wrong ? 'zzz' : answer)));
    await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='判分').click()`);
    await sleep(250);
    if (i === 0) {
      const judged = await cdp.eval('document.body.innerText');
      check('判分显示正确', judged.includes('✅ 正确'));
      await cdp.shot('10-dictate-correct');
    }
    if (wrong) {
      const jw = await cdp.eval('document.body.innerText');
      check('判分显示错误与正确答案', jw.includes('❌ 错误') && jw.includes('正确答案'));
      await cdp.shot('11-dictate-wrong');
    }
    await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='下一题'||b.textContent==='查看结果').click()`);
    await sleep(250);
  }

  // Finish the first-pass questions, then answer the in-session retry round
  // (a wrong answer is re-asked immediately instead of waiting five minutes).
  for (let i = 0; i < 40; i++) {
    const has = await cdp.eval(`!!document.querySelector('#answer')`);
    if (!has) {
      const doneBtn = await cdp.eval(`[...document.querySelectorAll('button')].some(b=>b.textContent==='查看结果')`);
      if (doneBtn) {
        await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='查看结果').click()`);
        await sleep(400);
      }
      break;
    }
    const retryNow = await cdp.eval(`window.MociApp.state.session.retryPass === true`);
    const answer = await cdp.eval(`(()=>{const s=window.MociApp.state.session;const q=s.retryPass?s.retryQuestions[s.retryIndex]:s.questions[s.qIndex];return q.answer;})()`);
    // On the retry round answer wrong on purpose: that is what keeps the word in
    // the wrong book, and it proves retry answers override the first pass.
    await cdp.eval(`(()=>{document.querySelector('#answer').value=${JSON.stringify(retryNow ? 'zzz' : answer)};})()`);
    await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='判分').click()`);
    await sleep(160);
    await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='下一题'||b.textContent==='查看结果'||b.textContent==='完成重练').click()`);
    await sleep(200);
  }
  await sleep(400);
  const result = await cdp.eval('document.body.innerText');
  check('结果页出现正确率', /正确率\s*\d+%/.test(result), result.split('\n').slice(0, 4).join(' | '));
  await cdp.shot('12-result');

  // 8. wrong book should have the deliberately wrong word
  const bookState = await cdp.eval(`(()=>{const b=window.MociApp.store.loadBook();const ws=Object.values(b.words);return {words:ws.length,wrong:ws.filter(w=>w.tags.length).map(w=>w.en+':'+w.tags.join('/')),seen:ws.filter(w=>w.progress.seen).length,reps:ws.map(w=>w.progress.reps)};})()`);
  check('有词写入错词本', bookState.wrong.length >= 1, JSON.stringify(bookState.wrong));
  check('已学习词进度已更新', bookState.seen >= 1, 'seen=' + bookState.seen);

  // 9. book tab (result page is full-screen; return home first)
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='回首页');if(b)b.click();})()`);
  await sleep(350);
  await goHome(cdp);
  await cdp.eval(`document.querySelectorAll('.tabs button')[1].click()`);
  await sleep(400);
  const bookText = await cdp.eval('document.body.innerText');
  check('词本页列出所有词', bookText.includes('abandon') && bookText.includes('ability'));
  check('词本页显示错词徽标', bookText.includes('拼写易错') || bookText.includes('词义混淆'));
  await cdp.shot('13-book');

  // search
  await cdp.eval(`(()=>{const i=document.querySelector('.screen input.input');i.value='abil';i.dispatchEvent(new Event('input'));})()`);
  await sleep(400);
  const searched = await cdp.eval('document.body.innerText');
  check('词本搜索过滤', searched.includes('ability') && !searched.includes('abandon'));
  await cdp.shot('14-book-search');

  // word detail edit
  await cdp.eval(`(()=>{const i=document.querySelector('.screen input.input');i.value='';i.dispatchEvent(new Event('input'));})()`);
  await sleep(350);
  await cdp.eval(`(()=>{const r=[...document.querySelectorAll('.rowcard')].find(x=>x.innerText.indexOf('abandon')>=0);if(r)r.click();})()`);
  await sleep(400);
  const detail = await cdp.eval('document.body.innerText');
  check('词条详情打开', detail.includes('音标') && detail.includes('释义'));
  await cdp.shot('15-word-detail');
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='返回');if(b)b.click();})()`);
  await sleep(300);

  // 10. phrases view + temp quiz
  await cdp.eval(`document.querySelectorAll('.tabs button')[0].click()`);
  await sleep(300);
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='短语视图').click()`);
  await sleep(400);
  const phraseText = await cdp.eval('document.body.innerText');
  check('短语视图列出搭配', phraseText.includes('abandon hope') || phraseText.includes('abandon oneself to'));
  await cdp.shot('16-phrases');
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='选择');if(b)b.click();})()`);
  await sleep(300);
  const picked = await cdp.eval('document.body.innerText');
  check('短语可勾选', picked.includes('临时听写（已选 1）'));
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('临时听写（已选'));if(b)b.click();})()`);
  await sleep(400);
  const tempText = await cdp.eval('document.body.innerText');
  check('临时听写进入题面', /第 1 \/ 1 题/.test(tempText));
  await cdp.shot('17-temp-quiz');
  const beforeTemp = await cdp.eval(`(()=>{const b=window.MociApp.store.loadBook();return JSON.stringify(Object.values(b.words).map(w=>w.tags));})()`);
  const answer = await cdp.eval(`(()=>{const s=window.MociApp.state.session;return s&&s.questions&&s.questions[0]?s.questions[0].answer:'';})()`);
  const typed = await cdp.eval(`(()=>{const t=document.querySelector('#answer');if(!t)return false;t.value='totally wrong';return true;})()`);
  check('临时听写有作答框', typed);
  if (typed) {
    await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='判分');if(b)b.click();})()`);
    await sleep(250);
    await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='查看结果'||x.textContent==='下一题');if(b)b.click();})()`);
    await sleep(400);
  }
  const afterTemp = await cdp.eval(`(()=>{const b=window.MociApp.store.loadBook();const s=window.MociApp.store.loadStats();return {tags:JSON.stringify(Object.values(b.words).map(w=>w.tags)),temp:s.tempPhraseWrong,tempAnswered:(s.days[Object.keys(s.days)[0]]||{}).tempAnswered};})()`);
  check('临时听写不写错词标签', beforeTemp === afterTemp.tags, 'before=' + beforeTemp + ' after=' + afterTemp.tags);
  check('临时听写只记统计', afterTemp.tempAnswered >= 1, JSON.stringify(afterTemp));
  await cdp.shot('18-temp-result');

  // the temp result page is full-screen: return home before touching tabs
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='回首页');if(b)b.click();})()`);
  await sleep(350);

  // 11b. append a second import so a pre-import backup exists (first import
  // into an empty book intentionally skips the backup).
  await cdp.eval(`document.querySelectorAll('.tabs button')[0].click()`);
  await sleep(350);
  const onHome = await cdp.eval(`(()=>{const s=document.querySelector('.screen');return s?(s.innerText||s.textContent||''):'NO SCREEN';})()`);
  check('追加前回到首页', /导入|开始学习/.test(onHome), onHome.replace(/\n/g, ' | ').slice(0, 120));
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.indexOf('导入 / 追加')>=0);if(b)b.click();})()`);
  await sleep(450);
  const appendPage = await cdp.eval(`(()=>{const t=document.querySelector('#import-text');return t?'HAS TEXTAREA':'NO TEXTAREA';})()`);
  check('打开追加导入页', appendPage === 'HAS TEXTAREA', appendPage);
  await cdp.eval("(()=>{const t=document.querySelector('#import-text');t.value='cope v. 应对；处理\\n- cope with 应对';})()");
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='导入');if(b)b.click();})()`);
  await sleep(450);
  const appendSummary = await cdp.eval('document.body.innerText');
  check('追加导入识别新词', /可导入\s*1\s*个词/.test(appendSummary), appendSummary.split('\n').slice(0, 5).join(' | '));
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.indexOf('确认导入')>=0);if(b)b.click();})()`);
  await sleep(450);
  const appendDone = await cdp.eval('document.body.innerText');
  check('追加完成页', appendDone.indexOf('导入完成') >= 0 && appendDone.indexOf('新增 1') >= 0, appendDone.split('\n').slice(0, 4).join(' | '));
  await cdp.shot('20b-append-done');

  // 11. data panel + self check
  await goHome(cdp);
  await cdp.eval(`document.querySelectorAll('.tabs button')[2].click()`);
  await sleep(400);
  const dataText = await cdp.eval('document.body.innerText');
  check('数据面板显示打卡与柱图', dataText.includes('连续打卡') && dataText.includes('近 14 天做题量'));
  await cdp.shot('19-data');
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('数据自检')).click()`);
  await sleep(400);
  const selfText = await cdp.eval('document.body.innerText');
  check('自检显示词条数与进度', /词条数/.test(selfText) && /进度条数/.test(selfText) && /音频/.test(selfText));
  await cdp.shot('20-selfcheck');
  await goHome(cdp);
  await cdp.eval(`document.querySelectorAll('.tabs button')[2].click()`);
  await sleep(350);

  // 12. backups + export + deleted
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.indexOf('备份与恢复')>=0);if(b)b.click();})()`);
  await sleep(500);
  const bkText = await cdp.eval('document.body.innerText');
  const bkNames = await cdp.eval(`(()=>{const s=document.querySelector('#sheet');return s?s.innerText.slice(0,400):'NO SHEET';})()`);
  check('备份列表有 pre-import 记录', bkText.indexOf('pre-import') >= 0, bkNames.replace(/\n/g, ' | ').slice(0, 240));
  await cdp.shot('21-backups');
  await cdp.eval(`(()=>{const s=document.querySelector('#sheet');if(s)s.remove();})()`);

  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='导出').click()`);
  await sleep(300);
  const expText = await cdp.eval('document.body.innerText');
  check('导出提供三种格式', expText.includes('JSON 备份') && expText.includes('CSV') && expText.includes('词典式文本'));
  await cdp.shot('22-export');
  await cdp.eval(`document.querySelector('#sheet').remove()`);

  const exported = await cdp.eval(`(()=>{const s=window.MociApp.store.exportAll('csv');return {bom:s.text.charCodeAt(0),head:s.text.split('\\r\\n')[0]};})()`);
  check('CSV 导出带 BOM 和表头', exported.bom === 0xFEFF && exported.head.includes('en,phonetic,zh,collo,tags'), JSON.stringify(exported));

  const dictRoundTrip = await cdp.eval(`(()=>{const txt=window.MociApp.store.exportAll('txt').text;const p=window.Moci.parser.parse(txt);const n=Object.keys(window.MociApp.store.loadBook().words).length;return {mode:p.mode,n:p.entries.length,book:n};})()`);
  check('文本导出可完整还原词本', dictRoundTrip.mode === 'dict' && dictRoundTrip.n === dictRoundTrip.book, JSON.stringify(dictRoundTrip));

  // 13. settings
  await goHome(cdp);
  await cdp.eval(`document.querySelectorAll('.tabs button')[3].click()`);
  await sleep(400);
  const setText = await cdp.eval('document.body.innerText');
  check('设置页有 AI 配置与发音', setText.includes('BASE_URL') && setText.includes('API Key') && setText.includes('发音'));
  check('设置页提示未配置 Key 时的状态', setText.includes('拍照批改（唯一 AI 用途）'));
  await cdp.shot('23-settings');
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('允许 HTTP') ? 1 : 0)`);

  // theme toggle
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='深色').click()`);
  await sleep(400);
  const theme = await cdp.eval(`document.documentElement.getAttribute('data-theme')`);
  check('深色主题生效', theme === 'dark', String(theme));
  await cdp.shot('24-settings-dark');
  await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='跟随系统').click()`);
  await sleep(300);

  // 14. raw localStorage sanity: single #app, no uncaught errors
  const health = await cdp.eval(`(()=>{const errs=window.__qaErrors||[];return {apps:document.querySelectorAll('#app').length,errs:errs,errbar:document.querySelector('#errbar').className};})()`);
  check('页面只有一个 #app', health.apps === 1, String(health.apps));
  check('无未捕获脚本错误', health.errs.length === 0, JSON.stringify(health.errs));

  // 15. column mapping panel: force table mode on a messy pipe list and adjust
  qaStep = 'mapping';
  await goHome(cdp);
  await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.indexOf('导入 / 追加')>=0);if(b)b.click();})()`);
  await sleep(400);
  await cdp.eval("(()=>{const t=document.querySelector('#import-text');if(t)t.value='abandon|əˈbændən|v. 放弃|abandon hope 放弃希望\\nability|əˈbɪləti|n. 能力|';})()");
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='导入');if(b)b.click();})()");
  await sleep(400);
  const tbl = await cdp.eval('document.body.innerText');
  // These same words were imported earlier in this run, so first-import-wins
  // means they all come back as "unchanged" rather than addable.
  check('竖线表格被识别（重复词按首次为准）', /无变化\s*2/.test(tbl), tbl.split('\n').slice(0, 5).join(' | '));

  await cdp.eval("(()=>{const s=document.querySelector('details.fold');if(s&&!s.hasAttribute('open'))s.querySelector('summary').click();})()");
  await sleep(400);
  const mapText = await cdp.eval('document.body.innerText');
  check('详情展示列映射', mapText.indexOf('列映射') >= 0, mapText.split('\n').filter(l => l.indexOf('列') >= 0).slice(0, 3).join(' | '));
  check('详情展示解析模式切换', mapText.indexOf('自动') >= 0 && mapText.indexOf('词典式') >= 0);
  await cdp.shot('25-mapping');

  // switch to dict mode: pipe lines fall back to unparsable but the app must not crash
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='词典式');if(b)b.click();})()");
  await sleep(400);
  const dictMode = await cdp.eval('document.body.innerText');
  check('手动切换解析模式不崩溃', dictMode.indexOf('本次导入') >= 0, dictMode.split('\n').slice(0, 3).join(' | '));
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='表格');if(b)b.click();})()");
  await sleep(350);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='取消');if(b)b.click();})()");
  await sleep(350);

  // 16. manual add / edit / delete + recently deleted restore
  qaStep = 'manual-add';
  await goHome(cdp);
  await cdp.eval("document.querySelectorAll('.tabs button')[1].click()");
  await sleep(400);
  const beforeManual = await cdp.eval("Object.keys(window.MociApp.store.loadBook().words).length");
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='手动新增');if(b)b.click();})()");
  await sleep(350);
  const filled = await cdp.eval(`(()=>{const i=[...document.querySelectorAll('#sheet input.input')];if(i.length<4)return 'inputs='+i.length;i[0].value='zebra';i[1].value='ˈziːbrə';i[2].value='n.';i[3].value='斑马';const t=document.querySelector('#sheet textarea');if(t)t.value='zebra crossing 斑马线';return 'ok';})()`);
  check('手动新增表单完整', filled === 'ok', filled);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('#sheet button')].find(x=>x.textContent.trim()==='添加');if(b)b.click();})()");
  await sleep(450);
  const afterManual = await cdp.eval("Object.keys(window.MociApp.store.loadBook().words).length");
  check('手动新增词条生效', afterManual === beforeManual + 1, beforeManual + ' -> ' + afterManual);

  await cdp.eval("(()=>{const r=[...document.querySelectorAll('.rowcard')].find(x=>x.innerText.indexOf('zebra')>=0);if(r)r.click();})()");
  await sleep(400);
  await cdp.eval("(()=>{const i=[...document.querySelectorAll('.screen input.input')];const zh=i.find(x=>x.value.indexOf('斑马')>=0);if(zh){zh.value='斑马；条纹';}})()");
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='保存修改');if(b)b.click();})()");
  await sleep(450);
  const edited = await cdp.eval("window.MociApp.store.loadBook().words.zebra.zh");
  check('手动编辑释义生效', edited === '斑马；条纹', String(edited));

  await cdp.eval("(()=>{const r=[...document.querySelectorAll('.rowcard')].find(x=>x.innerText.indexOf('zebra')>=0);if(r)r.click();})()");
  await sleep(350);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='删除词条');if(b)b.click();})()");
  await sleep(350);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('#sheet button')].find(x=>x.textContent.trim()==='删除');if(b)b.click();})()");
  await sleep(400);
  const deletedNow = await cdp.eval("({words:Object.keys(window.MociApp.store.loadBook().words).length, del:window.MociApp.store.loadDeleted().items.length})");
  check('删除词条并写入最近删除', deletedNow.words === afterManual - 1 && deletedNow.del >= 1, JSON.stringify(deletedNow));

  await goHome(cdp);
  await cdp.eval("document.querySelectorAll('.tabs button')[2].click()");
  await sleep(350);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.indexOf('最近删除')>=0);if(b)b.click();})()");
  await sleep(350);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('#sheet button')].find(x=>x.textContent.trim()==='恢复');if(b)b.click();})()");
  await sleep(450);
  const restored = await cdp.eval("window.MociApp.store.loadBook().words.zebra ? window.MociApp.store.loadBook().words.zebra.zh : null");
  check('最近删除可恢复且保留内容', restored === '斑马；条纹', String(restored));
  await cdp.shot('26-restored');

  // 17. clear-all confirmation flow (must not wipe without confirmation)
  await cdp.eval("document.querySelectorAll('.tabs button')[3].click()");
  await sleep(350);
  const wordsBeforeClear = await cdp.eval("Object.keys(window.MociApp.store.loadBook().words).length");
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.indexOf('清空全部数据')>=0);if(b)b.click();})()");
  await sleep(350);
  const confirmShown = await cdp.eval("document.body.innerText");
  check('清空前出现二次确认', confirmShown.indexOf('清空全部数据？') >= 0 && confirmShown.indexOf('确认清空') >= 0);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('#sheet button')].find(x=>x.textContent.trim()==='取消');if(b)b.click();})()");
  await sleep(300);
  const wordsAfterCancel = await cdp.eval("Object.keys(window.MociApp.store.loadBook().words).length");
  check('取消清空后数据完好', wordsAfterCancel === wordsBeforeClear, wordsBeforeClear + ' vs ' + wordsAfterCancel);

  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.indexOf('清空全部数据')>=0);if(b)b.click();})()");
  await sleep(300);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('#sheet button')].find(x=>x.textContent.trim()==='确认清空');if(b)b.click();})()");
  await sleep(450);
  const cleared = await cdp.eval("({words:Object.keys(window.MociApp.store.loadBook().words).length, backups:window.MociApp.store.listBackups().length, theme:window.MociApp.store.loadSettings().theme})");
  check('清空后词本归零且有备份', cleared.words === 0 && cleared.backups >= 1, JSON.stringify(cleared));
  await cdp.shot('27-cleared');

  // 18. empty state returns after clear
  await cdp.eval("document.querySelectorAll('.tabs button')[0].click()");
  await sleep(350);
  const emptyAgain = await cdp.eval('document.body.innerText');
  check('清空后回到空态引导', emptyAgain.indexOf('先放入你的第一个词表') >= 0);


  // 19. back-key confirmation flows (window.__mociBack is what MainActivity calls)
  await goHome(cdp);
  // the previous case cleared the book, so seed a word first and use whichever
  // import entry the empty/loaded home state offers.
  await cdp.eval("(()=>{const st=window.MociApp.store;const p=window.Moci.parser.parse('seedone v. 种子');const plan=window.Moci.merger.buildPlan(st.loadBook(),p,{now:Date.now()});st.commitPlan(plan,{},{now:Date.now()});window.MociApp.render();})()");
  await sleep(350);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.indexOf('导入 / 追加')>=0||x.textContent.trim()==='导入词本');if(b)b.click();})()");
  await sleep(400);
  await cdp.eval("(()=>{const t=document.querySelector('#import-text');if(t)t.value='backcheck v. 回退检验';})()");
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='导入');if(b)b.click();})()");
  await sleep(450);
  const back1 = await cdp.eval("window.__mociBack()");
  await sleep(300);
  const backSheet = await cdp.eval("(()=>{const s=document.querySelector('#sheet');return s?s.innerText.slice(0,60):'NO SHEET';})()");
  check('摘要页返回键弹出放弃确认', back1 === true && backSheet.indexOf('放弃本次导入') >= 0, backSheet);
  check('摘要页返回键没有直接丢弃数据', await cdp.eval("!!window.MociApp.state.import") === true);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('#sheet button')].find(x=>x.textContent.trim()==='继续导入');if(b)b.click();})()");
  await sleep(300);
  const stillThere = await cdp.eval("!!(window.MociApp.state.import && window.MociApp.state.import.parsed)");
  check('取消放弃后导入状态仍在', stillThere === true);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('#sheet button')].find(x=>x.textContent.trim()==='取消');if(b)b.click();})()");
  await sleep(300);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='返回');if(b)b.click();})()");
  await sleep(300);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='取消');if(b)b.click();})()");
  await sleep(350);

  // back inside a live study session must ask first, not silently drop it
  await goHome(cdp);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='开始学习');if(b)b.click();})()");
  await sleep(500);
  const inStudy = await cdp.eval("window.MociApp.state.screen");
  check('已进入学习页', inStudy === 'study', String(inStudy));
  const back2 = await cdp.eval("window.__mociBack()");
  await sleep(300);
  const studyBackSheet = await cdp.eval("(()=>{const s=document.querySelector('#sheet');return s?s.innerText.slice(0,60):'NO SHEET';})()");
  check('学习页返回键先确认', back2 === true && studyBackSheet.indexOf('结束本次学习') >= 0, studyBackSheet);
  check('确认前学习会话未丢失', await cdp.eval("!!window.MociApp.state.session") === true);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('#sheet button')].find(x=>x.textContent.trim()==='继续学习');if(b)b.click();})()");
  await sleep(300);
  check('继续学习后仍在学习页', (await cdp.eval("window.MociApp.state.screen")) === 'study');
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.trim()==='结束');if(b)b.click();})()");
  await sleep(300);
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('#sheet button')].find(x=>x.textContent.trim()==='结束');if(b)b.click();})()");
  await sleep(400);
  check('结束后回到首页', (await cdp.eval("window.MociApp.state.screen")) === null);

  // 20. A 306-word book must be fully reachable through paging, not cut off.
  await cdp.eval("(()=>{const app=window.MociApp;const b=app.store.loadBook();for(let i=0;i<305;i++){const en='qq'+String.fromCharCode(97+(i%26))+String.fromCharCode(97+(Math.floor(i/26)%26))+i;b.words[en]={en:en,phonetic:'',pos:'n.',zh:'上限检验'+i,collo:[],tags:[],createdAt:Date.now()+i,src:'bulk',srcs:['bulk'],progress:{ef:2.5,reps:0,interval:0,due:0,lapses:0,seen:false,pass:false,last:0,wrongCount:0,lastWrongAt:0}};}app.store.saveBook(b);app.render();})()");
  await sleep(400);
  await cdp.eval("document.querySelectorAll('.tabs button')[1].click()");
  await sleep(450);
  const paged = await cdp.eval("(()=>{const btns=[...document.querySelectorAll('.screen button')].map(b=>b.textContent);const more=btns.find(t=>t.indexOf('再显示')>=0);const all=btns.find(t=>t.indexOf('显示全部')>=0);return JSON.stringify({more:more||'',all:all||''});})()");
  const pagedInfo = JSON.parse(paged);
  check('大词本可继续加载', /再显示/.test(pagedInfo.more), pagedInfo.more);
  check('大词本可一次显示全部', /显示全部/.test(pagedInfo.all), pagedInfo.all);
  await cdp.shot('28-cap-notice');
  // Prove nothing is unreachable: show all, then count the rows.
  await cdp.eval("(()=>{const b=[...document.querySelectorAll('.screen button')].find(x=>x.textContent.indexOf('显示全部')>=0);if(b)b.click();})()");
  await sleep(500);
  const rowCount = await cdp.eval("document.querySelectorAll('.cardlist .rowcard').length");
  check('显示全部后所有词都可见', rowCount >= 306, '行数 ' + rowCount);

  // summary
  const passed = results.filter(r => r.ok).length;
  console.log('\nQA RESULT: ' + passed + ' / ' + results.length + ' passed');
  fs.writeFileSync(path.resolve(__dirname, '../build/qa-report.json'), JSON.stringify({ results, passed, total: results.length }, null, 2));

  try { chrome.kill(); } catch (e) { }
  process.exit(passed === results.length ? 0 : 2);
})().catch(e => {
  console.error('QA harness crashed at step [' + qaStep + ']:', e.message);
  try { process.exit(3); } catch (x) { }
});
