#!/usr/bin/env node
/* Dev server for browser QA: serves assets/ and proxies POST /api/http + GET /api/tts. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const ASSETS = path.resolve(__dirname, '../app/src/main/assets');
const PORT = Number(process.env.PORT) || 8099;
const API_KEY = process.env.MOCI_API_KEY || '';
const BASE_URL = process.env.MOCI_BASE_URL || 'https://llm.ujn.edu.cn/v1';
const MODEL = process.env.MOCI_MODEL || 'Qwen3.8-Flash-Next';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, limit, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > limit) { cb(new Error('body too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', e => cb(e));
}

function upstreamPost(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL.replace(/\/+$/, '') + '/chat/completions');
    const payload = Buffer.from(body || '{}', 'utf8');
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        Authorization: 'Bearer ' + API_KEY
      },
      timeout: 120000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && u.pathname === '/api/http') {
    readBody(req, 24 * 1024 * 1024, (err, buf) => {
      if (err) return json(res, 400, { ok: false, error: err.message });
      upstreamPost(buf.toString('utf8')).then(r => {
        json(res, 200, { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.body });
      }).catch(e => json(res, 200, { ok: false, error: e.message }));
    });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/config') {
    return json(res, 200, { hasKey: !!API_KEY, baseUrl: BASE_URL, model: MODEL });
  }

  if (req.method === 'GET' && u.pathname === '/api/versions') {
    return json(res, 200, {
      hasKey: !!API_KEY,
      baseUrl: BASE_URL,
      model: MODEL
    });
  }

  if (req.method === 'GET' && u.pathname === '/api/save') {
    return json(res, 200, { ok: true });
  }

  // Static files
  let rel = decodeURIComponent(u.pathname);

  // QA-only pages live outside assets so they never ship in the APK.
  if (rel.indexOf('/qa/') === 0) {
    const qaFile = path.join(path.resolve(__dirname, '../build/qa'), rel.slice(4).replace(/^\/+/, ''));
    fs.readFile(qaFile, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(qaFile).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
    return;
  }

  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ASSETS, rel.replace(/^\/+/, ''));
  if (!file.startsWith(ASSETS)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('devserver on http://127.0.0.1:' + PORT);
  console.log('AI proxy:', BASE_URL, 'model', MODEL, API_KEY ? '(key loaded)' : '(no key; /api/http will fail)');
});
