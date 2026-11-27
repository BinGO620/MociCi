#!/usr/bin/env node
/**
 * Generates a handwriting-style dictation sheet image (pure Node, no deps) and
 * runs a REAL AI grading call against the configured gateway. Prints the raw
 * model output plus our own verdicts after applying the space exemption.
 *
 * Usage: MOCI_API_KEY=... node tools/gen-test-image.js [out.jpg]
 */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT = process.argv[2] || path.resolve(__dirname, '../build/handwriting.jpg');
const BASE = process.env.MOCI_BASE_URL || 'https://llm.ujn.edu.cn/v1';
const MODEL = process.env.MOCI_MODEL || 'Qwen3.8-Flash-Next';
const KEY = process.env.MOCI_API_KEY || '';
const W = 900, H = 1200;

/* A tiny 5x7 bitmap font is enough to make legible pseudo-handwriting. */
const FONT = {
  a: ['01110', '00001', '01111', '10001', '01111'],
  b: ['10000', '10110', '11001', '10001', '11110'],
  c: ['01111', '10000', '10000', '10000', '01111'],
  d: ['00001', '01101', '10011', '10001', '01111'],
  e: ['01110', '10001', '11111', '10000', '01110'],
  f: ['00110', '01001', '11100', '01000', '01000'],
  g: ['01111', '10001', '01111', '00001', '01110'],
  h: ['10000', '10110', '11001', '10001', '10001'],
  i: ['00100', '00000', '00100', '00100', '00100'],
  j: ['00010', '00000', '00010', '00010', '01100'],
  k: ['10000', '10010', '10100', '11010', '10001'],
  l: ['01100', '00100', '00100', '00100', '01110'],
  m: ['00000', '11010', '10101', '10001', '10001'],
  n: ['00000', '10110', '11001', '10001', '10001'],
  o: ['01110', '10001', '10001', '10001', '01110'],
  p: ['10110', '11001', '11110', '10000', '10000'],
  q: ['01101', '10011', '01111', '00001', '00001'],
  r: ['00000', '10110', '11000', '10000', '10000'],
  s: ['01111', '10000', '01110', '00001', '11110'],
  t: ['00100', '11111', '00100', '00100', '00011'],
  u: ['00000', '10001', '10001', '10011', '01101'],
  v: ['00000', '10001', '10001', '01010', '00100'],
  w: ['00000', '10001', '10101', '10101', '01010'],
  x: ['00000', '10001', '01010', '00100', '10001'],
  y: ['10001', '10001', '01111', '00001', '01110'],
  z: ['11111', '00010', '00100', '01000', '11111'],
  ' ': ['00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00100'],
  '-': ['00000', '00000', '11111', '00000', '00000']
};

function makeCanvas() {
  const px = new Uint8Array(W * H * 3).fill(250);
  // faint ruled lines
  for (let y = 140; y < H; y += 90) {
    for (let x = 40; x < W - 40; x++) {
      const i = (y * W + x) * 3;
      px[i] = 214; px[i + 1] = 220; px[i + 2] = 232;
    }
  }
  return px;
}

function dot(px, x, y, strength) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (Math.floor(y) * W + Math.floor(x)) * 3;
  const s = Math.max(0, Math.min(1, strength));
  px[i] = Math.round(px[i] * (1 - s) + 26 * s);
  px[i + 1] = Math.round(px[i + 1] * (1 - s) + 30 * s);
  px[i + 2] = Math.round(px[i + 2] * (1 - s) + 44 * s);
}

/** Draws text with a slight wobble and slant so it reads as handwriting. */
function drawText(px, text, x0, y0, scale, seed) {
  let x = x0;
  let n = seed || 1;
  for (const chRaw of text) {
    const ch = FONT[chRaw] ? chRaw : (FONT[chRaw.toLowerCase()] ? chRaw.toLowerCase() : ' ');
    const glyph = FONT[ch];
    for (let gy = 0; gy < glyph.length; gy++) {
      for (let gx = 0; gx < glyph[gy].length; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        n = (n * 1103515245 + 12345) & 0x7fffffff;
        const jitter = ((n % 100) / 100 - 0.5) * 1.5;
        const bx = x + gx * scale + gy * scale * 0.12 + jitter;
        const by = y0 + gy * scale * 1.25 + jitter;
        for (let sy = 0; sy < scale * 1.15; sy++) {
          for (let sx = 0; sx < scale * 1.05; sx++) {
            dot(px, bx + sx, by + sy, 0.85 + (n % 30) / 200);
          }
        }
      }
    }
    x += (FONT[ch][0].length + 1.4) * scale;
  }
  return x;
}

function encodeJpegLike(px) {
  // Minimal baseline JPEG is complex; use PNG internally, the model accepts it.
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    px.subarray(y * W * 3, (y + 1) * W * 3).forEach((v, i) => { raw[y * (W * 3 + 1) + 1 + i] = v; });
  }
  const table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc = buf => { let c = -1; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body), 0);
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* The sheet: question 3 is correct but written with no spaces (exemption target),
   question 5 has a real misspelling (benifit) and must stay wrong. */
const ITEMS = [
  { n: '1', wrote: 'abandon', answer: 'abandon' },
  { n: '2', wrote: 'ability', answer: 'ability' },
  { n: '3', wrote: 'abandonself', answer: 'abandon oneself' },
  { n: '4', wrote: 'subject', answer: 'subject' },
  { n: '5', wrote: 'benifit', answer: 'benefit' },
  { n: '6', wrote: 'copewith', answer: 'cope with' }
];

const px = makeCanvas();
let y = 150;
drawText(px, 'dictation', 300, 90, 4, 3);
ITEMS.forEach((it, i) => {
  drawText(px, it.n + '.', 70, y, 3.4, 10 + i);
  drawText(px, it.wrote, 170, y, 3.4, 40 + i * 7);
  y += 150;
});
fs.writeFileSync(OUT, encodeJpegLike(px));
console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');

if (!KEY) {
  console.log('MOCI_API_KEY not set: image generated only, skipping the real call.');
  process.exit(0);
}

const prompt = "图片是学生手写的英语听写作业。题目共 6 题，按顺序为：\n1. [word] abandon\n2. [word] ability\n3. [phrase] abandon oneself\n4. [word] subject\n5. [word] benefit\n6. [phrase] cope with\n\n第一步：逐字符忠实转写每一题的书写内容。禁止自动纠正拼写，禁止\"顺手改对\"。\n学生写的是 benifit 就转写 benifit，不要写成 benefit。看不清的字母用 ? 保留。\n\n判错规则：\n1. 手写时单词间空格不可靠（socialsecurity 视为 social security），空格缺失、大小写差异一律不判错\n2. 真正的拼写错误（benifit、supress）和介词/搭配用错（cope to）必须判错\n3. 识别短语时先对照题目切分手写内容，再逐词判断\n\n第二步：用转写结果与题目原答案逐词比较后判分。\n输出前自查：每题的 wrote/wrote 是否与图片中看到的字母完全一致（包括错误拼写）？\n\n每题必须带 index（从 1 开始）与题目原答案 en。只输出 JSON：\n{\"results\":[{\"index\":1,\"en\":\"题目原答案\",\"correct\":true,\"wrote\":\"逐字符转写内容\",\"note\":\"简短点评\"}],\"score\":正确数}";
const body = Buffer.from(JSON.stringify({
  model: MODEL,
  messages: [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + fs.readFileSync(OUT).toString('base64') } },
      { type: 'text', text: prompt }
    ]
  }],
  temperature: 0.1,
  reasoning_effort: 'none'
}), 'utf8');

const url = new URL(BASE.replace(/\/+$/, '') + '/chat/completions');
const req = https.request({
  hostname: url.hostname, path: url.pathname, method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, Authorization: 'Bearer ' + KEY },
  timeout: 180000
}, res => {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    console.log('HTTP', res.statusCode);
    let content = '';
    try {
      content = JSON.parse(text).choices[0].message.content;
    } catch (e) {
      console.log('unexpected envelope:', text.slice(0, 600));
      process.exit(1);
    }
    console.log('--- model content ---');
    console.log(content);

    // Apply the same parsing + space exemption the app uses.
    let t = content;
    const lb = t.indexOf('{'), rb = t.lastIndexOf('}');
    if (lb >= 0 && rb > lb) t = t.slice(lb, rb + 1);
    const data = JSON.parse(t);
    const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
    const rows = (data.results || []).map(r => {
      const expect = ITEMS[Number(r.index) - 1];
      const answer = expect ? expect.answer : r.en;
      const aiCorrect = !!r.correct;
      const exempted = !aiCorrect && norm(r.wrote) === norm(answer);
      return { index: r.index, answer, aiCorrect, final: aiCorrect || exempted, exempted, wrote: r.wrote };
    });
    console.log('--- final verdicts ---');
    console.log(JSON.stringify(rows, null, 2));
    const q3 = rows.find(r => r.answer === 'abandon oneself');
    const q5 = rows.find(r => r.answer === 'benefit');
    const q6 = rows.find(r => r.answer === 'cope with');
    console.log('CHECK 空格豁免(第3题判对):', q3 && q3.final === true);
    console.log('CHECK 真拼写错误(第5题判错):', q5 && q5.final === false);
    console.log('CHECK 介词短语(第6题判对):', q6 && q6.final === true);
  });
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', e => { console.error('request failed:', e.message); process.exit(1); });
req.write(body);
req.end();
