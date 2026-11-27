'use strict';
/**
 * Android bridge simulator.
 *
 * Reproduces the two behaviours that broke the real device:
 *   1. @JavascriptInterface resolves methods by EXACT arity -> wrong arg count
 *      throws "Method not found".
 *   2. Every method returns a JSON *string*, never an object.
 *
 * If this harness passes, the JS layer is compatible with the real bridge.
 * If it fails, the device would fail too.
 */
const fs = require('fs');
const path = require('path');

/** Method name -> declared arity, mirroring NativeBridge.java. */
const ARITY = {
  readText: 1, writeText: 2, writeBase64: 2, readBase64: 1,
  list: 1, stat: 1, delete: 1, copy: 2, storageInfo: 0,
  prefGet: 1, prefSet: 2, prefGetBool: 2, prefSetBool: 2,
  ttsStatus: 0, ttsEngines: 0, ttsSetEngine: 1, ttsSetAccent: 1,
  ttsSpeak: 2, ttsStop: 0, ttsIsReady: 0, ttsPrefetch: 1,
  ttsCachedPath: 1, ttsOpenSettings: 0, ttsSetRate: 1,
  pickFile: 1, pickImage: 1, camera: 1, saveFile: 4,
  toast: 1, copyText: 1, applyTheme: 1, platform: 0,
  httpPost: 3, httpGetBase64: 2
};

function createBridge(opts) {
  opts = opts || {};
  const files = {};
  const mtimes = {};
  const prefs = {};
  const calls = [];
  let clock = 0;
  let ttsAvailable = opts.tts !== false;
  let failWrites = opts.failWrites === true;

  function norm(rel) {
    if (rel == null) throw new Error('empty path');
    let p = String(rel).replace(/\\/g, '/').trim();
    while (p.startsWith('/')) p = p.slice(1);
    if (p === '' ) throw new Error('empty path');
    if (p.includes('..')) throw new Error('illegal path');
    if (!/^[A-Za-z0-9._/-]+$/.test(p)) throw new Error('illegal characters');
    return p;
  }
  function dir(name) {
    const out = [];
    const prefix = name === '.' ? '' : name.replace(/\/+$/, '') + '/';
    const seen = new Set();
    Object.keys(files).forEach(k => {
      if (!k.startsWith(prefix)) return;
      const rest = k.slice(prefix.length);
      const slash = rest.indexOf('/');
      const base = slash < 0 ? rest : rest.slice(0, slash);
      if (!base || seen.has(base)) return;
      seen.add(base);
      out.push({ name: base, dir: slash >= 0, size: slash >= 0 ? 0 : files[k].length, mtime: mtimes[k] || 0 });
    });
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
  const okObj = o => JSON.stringify(Object.assign({ ok: true }, o || {}));

  const impl = {
    readText(rel) {
      const p = norm(rel);
      if (!Object.prototype.hasOwnProperty.call(files, p)) return okObj({ text: null, exists: false });
      return okObj({ text: files[p], exists: true });
    },
    writeText(rel, text) {
      if (failWrites) throw new Error('simulated disk full');
      const p = norm(rel);
      files[p] = String(text);
      mtimes[p] = ++clock;
      return okObj({ bytes: String(text).length });
    },
    writeBase64(rel, b64) {
      if (failWrites) throw new Error('simulated disk full');
      const p = norm(rel);
      files[p] = String(b64);
      mtimes[p] = ++clock;
      return okObj({ bytes: String(b64).length });
    },
    readBase64(rel) {
      const p = norm(rel);
      return Object.prototype.hasOwnProperty.call(files, p)
        ? okObj({ base64: files[p] }) : okObj({ base64: null, exists: false });
    },
    list(rel) { return okObj({ items: dir(norm(rel)) }); },
    stat(rel) {
      const p = norm(rel);
      const isDir = Object.keys(files).some(k => k.startsWith(p + '/'));
      return okObj({ exists: Object.prototype.hasOwnProperty.call(files, p) || isDir,
        size: files[p] ? files[p].length : 0, dir: isDir, mtime: mtimes[p] || 0 });
    },
    delete(rel) {
      const p = norm(rel);
      let n = 0;
      Object.keys(files).forEach(k => {
        if (k === p || k.startsWith(p + '/')) { delete files[k]; delete mtimes[k]; n++; }
      });
      return okObj({ deleted: n > 0 });
    },
    copy(from, to) {
      const a = norm(from), b = norm(to);
      if (!Object.prototype.hasOwnProperty.call(files, a)) throw new Error('source missing');
      files[b] = files[a]; mtimes[b] = ++clock;
      return okObj({ bytes: files[b].length });
    },
    storageInfo() { return okObj({ freeBytes: 1024 * 1024 * 512, totalBytes: 1024 * 1024 * 1024 }); },
    prefGet(k) { return okObj({ value: prefs[k] == null ? null : prefs[k] }); },
    prefSet(k, v) { prefs[k] = v; return okObj({}); },
    prefGetBool(k, d) { return okObj({ value: prefs[k] == null ? !!d : prefs[k] === 'true' }); },
    prefSetBool(k, v) { prefs[k] = String(!!v); return okObj({}); },
    ttsStatus() {
      return okObj({ ready: ttsAvailable, english: ttsAvailable, accent: prefs.ttsAccent || 'uk',
        langStatus: ttsAvailable ? 0 : -2, engine: '', defaultEngine: '', error: '', sdk: 34 });
    },
    ttsEngines() { return okObj({ items: [{ label: 'System', pkg: 'com.test.tts', default: true }] }); },
    ttsSetEngine() { return okObj({}); },
    ttsSetAccent(a) { prefs.ttsAccent = a; return okObj({ accent: a }); },
    ttsSpeak() { return okObj({ spoken: ttsAvailable }); },
    ttsStop() { return okObj({}); },
    ttsIsReady() { return okObj({ ready: ttsAvailable, english: ttsAvailable }); },
    ttsPrefetch() { return okObj({ started: ttsAvailable, path: null }); },
    ttsCachedPath() { return okObj({ path: null }); },
    ttsOpenSettings() { return okObj({}); },
    ttsSetRate() { return okObj({}); },
    pickFile() { return okObj({}); },
    pickImage() { return okObj({}); },
    camera() { return okObj({}); },
    saveFile() { return okObj({}); },
    toast() { return okObj({}); },
    copyText() { return okObj({}); },
    applyTheme() { return okObj({}); },
    platform() { return okObj({ os: 'android', sdk: 34, device: 'harness', version: '1.0' }); }
  };

  /**
   * Mirrors android.webkit.JavaBridge: unknown method -> TypeError,
   * wrong argument count -> Error("Method not found").
   */
  function invoke(name, args) {
    calls.push({ name, argc: args.length });
    if (!(name in ARITY)) throw new TypeError(name + ' is not a function');
    if (args.length !== ARITY[name]) throw new Error('Method not found: ' + name);
    return impl[name].apply(null, args);
  }

  const proxy = new Proxy({}, {
    get(_, name) {
      if (typeof name !== 'string') return undefined;
      return function () { return invoke(name, Array.prototype.slice.call(arguments)); };
    }
  });

  return {
    bridge: proxy,
    files,
    prefs,
    calls,
    setTts(on) { ttsAvailable = on; },
    setFailWrites(on) { failWrites = on; },
    raw: impl
  };
}

/** Loads the browser modules into a fake global so they use our bridge. */
function loadModules(bridgeProxy) {
  const base = path.resolve(__dirname, '../../app/src/main/assets');
  const vm = require('vm');
  const sandbox = {
    console,
    JSON,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Set,
    Map,
    isFinite,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
    localStorage: undefined
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.MociNative = bridgeProxy;
  vm.createContext(sandbox);

  const order = ['util', 'nativejson', 'sm2', 'meaning', 'grader', 'parser', 'merger', 'selector',
    'wrongbook', 'stats', 'storage', 'store', 'appmeta'];
  order.forEach(name => {
    const src = fs.readFileSync(path.join(base, 'js', name + '.js'), 'utf8');
    vm.runInContext(src, sandbox, { filename: name + '.js' });
  });
  return sandbox.Moci;
}

module.exports = { createBridge, loadModules, ARITY };
