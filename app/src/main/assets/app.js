(function (root) {
  'use strict';
  var util = root.Moci.util;
  var parser = root.Moci.parser;
  var merger = root.Moci.merger;
  var sm2 = root.Moci.sm2;
  var grader = root.Moci.grader;
  var selector = root.Moci.selector;
  var wrongbook = root.Moci.wrongbook;
  var statsMod = root.Moci.stats;
  var storeMod = root.Moci.store;
  var storage = root.Moci.storage;
  var appmeta = root.Moci.appmeta;
  var meaning = root.Moci.meaning;
  var nativeParse = root.Moci.nativejson
    ? root.Moci.nativejson.parse
    : function (raw, fb) {
      if (typeof raw !== 'string') return raw == null ? fb : raw;
      try { return JSON.parse(raw); } catch (e) { return fb; }
    };

  var native = !!(root.MociNative && typeof root.MociNative.readText === 'function');
  var bridge = root.MociBridge || null;

  var store = storeMod.create(storage.pick(), {
    onError: function (msg) { showError(msg); }
  });

  var state = {
    tab: 'home',
    scope: 'all',
    screen: null,
    screenData: {},
    import: null,
    session: null,
    settings: null,
    speechRate: 1.0,
    // Explicit default: TTS can be triggered before loadSettings() runs, and
    // the Java side declares a primitive float, which rejects undefined.
    speechAccent: 'us',
    autoSpeak: true,
    // 'human' = recorded audio fetched once and cached; 'system' = device TTS.
    voiceSource: 'human',
    onlineTts: '',
    ttsIssueNotified: false,
    // Which dictation question was auto-spoken last, so a re-render of the same
    // question does not repeat the audio.
    dictationSpoken: null,
    lastError: null,
    errorLog: []
  };

  /* ------------------------------------------------------------- utilities */

  var el = function (tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style') node.setAttribute('style', v);
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else if (k === 'value') {
          // setAttribute('value') is ignored by <textarea> and <select>; those
          // need the live property. Using the attribute left editable boxes
          // silently empty (template editor, collocation fields).
          node.value = v;
        }
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
  };

  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1900);
  }

  var errorTimer = null;
  function showError(msg) {
    if (!msg) return;
    state.lastError = msg;
    state.errorLog = state.errorLog || [];
    state.errorLog.push(new Date().toISOString() + ' ' + msg);
    if (state.errorLog.length > 50) state.errorLog.shift();
    try { console.error('[Moci] ' + msg); } catch (e) { }
    var bar = $('#errbar');
    if (!bar) return;
    $('#errbar .msg', bar).textContent = msg;
    bar.classList.add('show');
    // Auto-dismiss: a persistent floating bar is what made the UI feel frozen.
    clearTimeout(errorTimer);
    errorTimer = setTimeout(function () {
      bar.classList.remove('show');
    }, 6000);
  }

  function dismissError() {
    var bar = $('#errbar');
    if (bar) bar.classList.remove('show');
  }

  function copy(text) {
    if (native) {
      try {
        root.MociNative.copyText(text);
        toast('已复制');
        return;
      } catch (e) { /* fall through to the DOM path */ }
    }
    var ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('已复制');
    } catch (e) {
      toast('复制失败，请手动选择');
    }
    document.body.removeChild(ta);
  }

  /**
   * Speaks a word. Order of preference, tuned for instant feedback:
   *   1. a prefetched local file or a filled online cache (zero-latency disk play)
   *   2. the system TTS engine (warmed up in MainActivity.onCreate)
   *   3. online TTS only as a background cache-filler, never as a blocking wait
   */
  /**
   * Pronunciation, in priority order:
   *   1. a cached clip on disk (recorded human audio, fetched once per word)
   *   2. the system TTS engine (always available, never blocks)
   *   3. online fetch fills the cache in the background for next time
   *
   * The human-audio layer is what makes speech sound natural: the device's only
   * speech engine is a basic formant synthesiser, and no amount of tuning makes
   * it pleasant. Fetching once and caching keeps the app offline-capable — after
   * the first listen a word plays without any network.
   */
  function speak(text) {
    if (!text) return;
    stopSpeaking();
    var cached = prefetchedAudio(text);
    if (cached) {
      playUrl(cached.src);
      return;
    }
    // Not cached yet: speak now so the tap is never silent, and warm the clip.
    speakSystem(text);
    warmAudioCache(text);
  }

  /** Where human audio comes from. Youdao serves recorded audio, no key needed. */
  function audioSourceUrl(text) {
    var custom = state.onlineTts;
    if (custom) {
      return custom.replace('{text}', encodeURIComponent(text))
        .replace('{accent}', state.speechAccent === 'uk' ? 'uk' : 'us');
    }
    // type=2 is US, type=1 is UK.
    return 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(text) +
      '&type=' + (state.speechAccent === 'uk' ? '1' : '2');
  }

  /** True when human audio should be used at all. */
  function wantsHumanAudio() {
    return state.voiceSource !== 'system' && !!(native && bridge);
  }

  /**
   * Downloads and caches one clip. Cached by text + accent, so switching accent
   * does not silently replay the other one.
   */
  function warmAudioCache(text) {
    if (!text || !wantsHumanAudio()) return;
    var key = audioCacheKey(text);
    try {
      var have = nativeParse(root.MociNative.audioCachedPath(key), null);
      if (have && have.ok && have.path) return; // already on disk
    } catch (e) { }
    try {
      bridge.audioFetch(audioSourceUrl(text), key).then(function (r) {
        // A failed fetch is silent by design: the system voice already spoke and
        // the next attempt will simply try again.
        return r;
      });
    } catch (e) { /* never let audio break the UI */ }
  }

  function audioCacheKey(text) {
    var accent = state.speechAccent === 'uk' ? 'uk' : 'us';
    return 'audio/' + accent + '/' + String(text || '').toLowerCase().replace(/[^a-z0-9']+/g, '_');
  }

  function prefetchedAudio(text) {
    if (!native || !bridge) return null;
    // Human audio first — it is the whole point of the mode.
    if (wantsHumanAudio()) {
      try {
        var h = nativeParse(root.MociNative.audioCachedPath(audioCacheKey(text)), null);
        if (h && h.ok && h.path) return { src: 'file://' + h.path, kind: 'human' };
      } catch (e) { }
      return null;
    }
    try {
      var r = nativeParse(root.MociNative.ttsCachedPath(text), null);
      if (r && r.ok && r.path) {
        return { src: 'file://' + r.path, kind: 'file' };
      }
    } catch (e) { }
    return null;
  }

  /**
   * Warms whatever the current source will need for this text: the human clip
   * when that mode is on, otherwise the system engine's own cache. Both are
   * keyed the same way the playback path looks them up, so a hit is guaranteed.
   */
  function prefetchWord(text) {
    if (!text || !native || !bridge) return;
    if (wantsHumanAudio()) {
      warmAudioCache(text);
      return;
    }
    try { root.MociNative.ttsPrefetch(text); } catch (e) { }
  }

  /**
   * Warms the words the user is about to hear: the current card plus the next
   * few, and each card's collocations. Deeper than one because the user often
   * flips and speaks several cards within a few seconds, and synthesis is
   * asynchronous — queueing them now means later taps are instant.
   */
  function prefetchStudyCards(cards, index, ahead) {
    if (!cards || !cards.length) return;
    var depth = ahead == null ? 3 : ahead;
    var end = Math.min(cards.length, index + depth + 1);
    for (var i = index; i < end; i++) {
      var c = cards[i];
      if (!c) continue;
      if (c.en) prefetchWord(c.en);
      (c.collo || []).forEach(function (phrase) {
        var split = selector.splitPhrase(phrase);
        if (split && split.en && split.en !== c.en) prefetchWord(split.en);
      });
    }
  }

  /**
   * Warms the upcoming dictation answers. Dictation now speaks each question as
   * it appears, so the answers have to be synthesised before they are reached;
   * otherwise every question would stutter through a fresh synthesis.
   */
  function prefetchDictation(questions, index, ahead) {
    if (!questions || !questions.length) return;
    var depth = ahead == null ? 3 : ahead;
    var end = Math.min(questions.length, index + depth + 1);
    for (var i = index; i < end; i++) {
      var q = questions[i];
      if (q && q.answer) prefetchWord(q.answer);
    }
  }

  function speakSystem(text) {
    if (native && bridge) {
      try {
        var r = nativeParse(bridge.ttsSpeak(text, state.speechRate), null);
        if (r && !r.ok) { showError('发音失败：' + (r.error || '未知错误')); return; }
        if (r && r.ok && r.spoken === false) ttsUnavailable(r);
        return;
      } catch (e) { }
    }
    try {
      if (root.speechSynthesis) {
        root.speechSynthesis.cancel();
        var u = new root.SpeechSynthesisUtterance(text);
        u.lang = state.speechAccent === 'us' ? 'en-US' : 'en-GB';
        u.rate = state.speechRate;
        root.speechSynthesis.speak(u);
      }
    } catch (e) { showError('发音失败：' + e.message); }
  }

  var audioEl = null;
  function playUrl(src) {
    stopAudio();
    try {
      audioEl = new Audio(src);
      // The speed setting only reached the system engine, so with recorded audio
      // (the default source) dragging the slider did nothing at all. Apply it to
      // the clip as well; preservesPitch keeps the voice natural instead of
      // sounding chipmunked when sped up.
      try {
        var v = Number(state.speechRate);
        if (isFinite(v) && v > 0) {
          audioEl.playbackRate = v;
          audioEl.preservesPitch = true;
          audioEl.mozPreservesPitch = true;
          audioEl.webkitPreservesPitch = true;
        }
      } catch (e0) { }
      audioEl.addEventListener('ended', stopAudio);
      var p = audioEl.play();
      if (p && p.catch) p.catch(function () { stopAudio(); });
    } catch (e) { showError('音频播放失败'); }
  }

  function playBase64(mime, b64) {
    playUrl('data:' + mime + ';base64,' + b64);
  }

  function stopAudio() {
    try { if (audioEl) { audioEl.pause(); audioEl.src = ''; audioEl = null; } } catch (e) { }
  }
  function stopSpeaking() {
    stopAudio();
    if (native && bridge) { try { bridge.ttsStop(); } catch (e) { } }
    try { if (root.speechSynthesis) root.speechSynthesis.cancel(); } catch (e) { }
  }

  function ttsUnavailable(r) {
    if (state.ttsIssueNotified) return;
    state.ttsIssueNotified = true;
    var detail = '';
    if (r && r.error) {
      detail = String(r.error);
    } else {
      try {
        var st = nativeParse(root.MociNative.ttsStatus(), null) || {};
        if (st.error) detail = st.error;
        else if (st.ready) detail = '语言未就绪 (langStatus=' + st.langStatus + ')';
        else detail = '引擎未初始化 (langStatus=' + st.langStatus + ')';
      } catch (e) { }
    }
    showError('发音失败：' + (detail || '系统的英语语音不可用') +
      '。可在设置页点「打开系统 TTS 设置」安装英语语音数据，或换一个 TTS 引擎。');
  }

  /**
   * TTS pre-flight. Only warns when the engine itself failed to initialise —
   * a negative language probe is not proof of failure (some ROMs report
   * LANG_MISSING_DATA at init yet synthesise fine). The real verdict comes from
   * an actual speak() attempt.
   */
  var ttsProbed = false;
  function ensureTtsReady() {
    if (ttsProbed) return;
    ttsProbed = true;
    if (!native || !bridge) return;
    try {
      var st = nativeParse(root.MociNative.ttsStatus(), null) || {};
      if (!st.ready) {
        if (!state.settings || state.settings.ttsWarned !== true) {
          toast('语音引擎未就绪，可在设置里更换 TTS 引擎');
          saveSettings({ ttsWarned: true });
        }
        return;
      }
      // Silent warm-up; if it fails the per-tap failure path will speak up once.
      root.MociNative.ttsSpeak('test', state.speechRate);
      root.MociNative.ttsStop();
    } catch (e) { /* TTS probing is best-effort */ }
  }

  function loadSettings() {
    state.settings = store.loadSettings();
    state.speechRate = Number(state.settings.speechRate) || 1.0;
    state.autoSpeak = state.settings.autoSpeak !== false;
    state.voiceSource = state.settings.voiceSource || 'human';
    state.onlineTts = state.settings.onlineTts || '';
    state.speechAccent = state.settings.ttsAccent === 'uk' ? 'uk' : 'us';
    var dark = null;
    if (state.settings.theme === 'dark') dark = true;
    else if (state.settings.theme === 'light') dark = false;
    if (dark === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var isDark = dark === null
      ? (root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches)
      : dark;
    if (native && bridge) { try { root.MociNative.applyTheme(isDark); } catch (e) { } }
  }

  function saveSettings(patch) {
    state.settings = Object.assign(store.loadSettings(), patch);
    store.saveSettings(state.settings);
    loadSettings();
  }

  /* ---------------------------------------------------------------- routing */

  function navigate(name, data) {
    state.screen = name;
    state.screenData = data || {};
    render();
    try { root.scrollTo({ top: 0, behavior: 'auto' }); } catch (e) { root.scrollTo(0, 0); }
  }

  function goTab(name) {
    state.tab = name;
    state.screen = null;
    state.screenData = {};
    render();
  }

  root.__mociBack = function () {
    if ($('#sheet')) { closeSheet(); return true; }
    if (!state.screen) {
      if (state.tab !== 'home') { goTab('home'); return true; }
      return false;
    }
    if (state.screen === 'import-detail') { navigate('import-summary'); return true; }
    // An in-flight session must not vanish on a stray back press.
    if (state.screen === 'study' || state.screen === 'dictate') { abortSession(); return true; }
    if (state.screen === 'result') { goTab('home'); return true; }
    if (state.screen === 'import-summary' || state.screen === 'import') {
      openSheet('放弃本次导入？', el('p', { class: 'small', text: '还没有写入词本，已解析的内容会丢弃。' }), [
        el('button', { class: 'btn ghost', text: '继续导入', onclick: closeSheet }),
        el('button', { class: 'btn danger', text: '放弃', onclick: function () {
          closeSheet();
          state.import = null;
          goTab('home');
        } })
      ]);
      return true;
    }
    navigate(null);
    return true;
  };

  /* ------------------------------------------------------------------ sheet */

  function openSheet(title, content, actions) {
    closeSheet();
    var panel = el('div', { class: 'panel' }, [
      el('h3', { text: title }),
      content,
      actions ? el('div', { class: 'btn-row' }, actions) : null
    ]);
    var sheet = el('div', { class: 'sheet', id: 'sheet', onclick: function (e) {
      if (e.target === sheet) closeSheet();
    } }, [panel]);
    document.body.appendChild(sheet);
  }
  function closeSheet() {
    var s = $('#sheet');
    if (s) s.parentNode.removeChild(s);
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    var app = $('#app');
    clear(app);
    var content = state.screen ? renderScreen() : renderTab();
    app.appendChild(content);
    // Full-screen flows (import/study/dictate) own the screen; showing tabs
    // there invites accidental navigation that would drop the session.
    var fullScreen = state.screen && ['import', 'import-summary', 'import-detail', 'import-done', 'study', 'dictate', 'result'].indexOf(state.screen) >= 0;
    if (!fullScreen) app.appendChild(renderTabs());
  }

  function renderTab() {
    var screen = el('div', { class: 'screen' });
    if (state.tab === 'home') renderHome(screen);
    else if (state.tab === 'book') renderBook(screen);
    else if (state.tab === 'data') renderData(screen);
    else if (state.tab === 'settings') renderSettings(screen);
    return screen;
  }

  function renderScreen() {
    if (state.screen === 'import') return screenImport();
    if (state.screen === 'import-summary') return screenImportSummary();
    if (state.screen === 'import-detail') return screenImportDetail();
    if (state.screen === 'import-done') return screenImportDone();
    if (state.screen === 'study') return screenStudy();
    if (state.screen === 'dictate') return screenDictate();
    if (state.screen === 'result') return screenResult();
    if (state.screen === 'phrases') return screenPhrases();
    if (state.screen === 'word') return screenWordDetail();
    if (state.screen === 'selfcheck') return screenSelfCheck();
    var s = el('div', { class: 'screen' });
    s.appendChild(el('p', { class: 'muted', text: '未知页面' }));
    return s;
  }

  function renderTabs() {
    var defs = [
      ['home', '🏠', '首页'],
      ['book', '📖', '词本'],
      ['data', '📊', '数据'],
      ['settings', '⚙️', '设置']
    ];
    var bar = el('nav', { class: 'tabs' });
    defs.forEach(function (d) {
      bar.appendChild(el('button', {
        class: state.tab === d[0] && !state.screen ? 'on' : '',
        onclick: function () { goTab(d[0]); }
      }, [el('span', { class: 'ico', text: d[1] }), el('span', { text: d[2] })]));
    });
    return bar;
  }

  /* ------------------------------------------------------------------ home */

  function renderHome(screen) {
    var book = store.loadBook();
    var words = Object.keys(book.words || {});
    var now = Date.now();

    if (!words.length) {
      var empty = el('div', { class: 'card pad empty' }, [
        el('div', { class: 'big', text: '📥' }),
        el('h2', { text: '词本还是空的' }),
        el('p', { class: 'muted small', text: '默词不内置任何词库。让任意 AI 按固定格式生成词表，复制粘贴即可入库。' }),
        el('div', { class: 'btn-row', style: 'margin-top:16px' }, [
          el('button', { class: 'btn block', text: '导入词本', onclick: function () { navigate('import'); } })
        ]),
        el('ul', { class: 'steps' }, [
          el('li', { text: '复制下方提示词，发给任意 AI 生成词表' }),
          el('li', { text: '把 AI 输出的代码块整段复制进「导入」' }),
          el('li', { text: '确认摘要后开始学习、听写' })
        ]),
        el('button', { class: 'btn ghost block', style: 'margin-top:12px', text: '查看提示词模板',
          onclick: showTemplate })
      ]);
      screen.appendChild(topbar('默词', '自建词本 · 记忆曲线 · 听写检验'));
      screen.appendChild(empty);
      return;
    }

    var due = 0, mastered = 0, learning = 0, wrong = 0;
    words.forEach(function (k) {
      var w = book.words[k];
      if (sm2.isDue(w.progress, now)) due++;
      if (sm2.isMastered(w.progress)) mastered++;
      else if (sm2.isLearning(w.progress)) learning++;
      if ((w.tags || []).length) wrong++;
    });

    screen.appendChild(topbar('默词', '已掌握 ' + mastered + ' / ' + words.length + ' 词'));

    var stats = el('div', { class: 'stat-grid' }, [
      stat('已掌握', mastered, '/ ' + words.length),
      stat('今日到期', due, '个词'),
      stat('错词', wrong, '上限 30')
    ]);
    screen.appendChild(stats);

    var scopes = [['all', '全部'], ['due', '今日到期'], ['new', '新词'], ['learning', '学习中'], ['mastered', '已掌握'], ['wrong', '错词']];
    var chips = el('div', { class: 'chips' });
    scopes.forEach(function (s) {
      chips.appendChild(el('button', {
        class: 'chip' + (state.scope === s[0] ? ' on' : ''),
        text: s[1],
        onclick: function () { state.scope = s[0]; render(); }
      }));
    });
    screen.appendChild(chips);

    var pool = merger.searchWords(book, '', { bucket: state.scope === 'all' ? null : state.scope, now: now });
    var settings = store.loadSettings();
    var groupSize = Number(settings.dailyGoal) || 15;
    var newPerDay = Number(settings.newPerDay);
    if (!isFinite(newPerDay)) newPerDay = 7;
    var preview = selector.selectLearnGroup(book, {
      scope: state.scope, now: now, seed: now % 100000,
      groupSize: groupSize, newPerDay: newPerDay
    });
    var unseen = Math.max(0, words.length - mastered - learning);
    var daysToFinish = newPerDay > 0 && unseen > 0 ? Math.ceil(unseen / newPerDay) : null;
    var info = el('div', { class: 'card pad' }, [
      el('div', { class: 'split' }, [
        el('div', { class: 'grow' }, [
          el('div', { style: 'font-weight:650', text: '本次可学 ' + preview.length + ' 张卡（每组 ' + groupSize + ' 张 / 新词 ' + newPerDay + '）' }),
          el('div', { class: 'muted small', text: daysToFinish == null
            ? (unseen === 0 ? '没有新词了，当前是纯复习阶段；范围 ' + pool.length + ' 词' : '每日新词为 0，只复习不学新词；范围 ' + pool.length + ' 词')
            : '按当前节奏约 ' + daysToFinish + ' 天学完剩余 ' + unseen + ' 个新词' })
        ]),
        el('div', { style: 'font-size:22px', text: '🎴' })
      ]),
      el('div', { class: 'btn-row', style: 'margin-top:14px' }, [
        el('button', {
          class: 'btn', text: preview.length ? '开始学习' : '没有可学的词',
          disabled: !preview.length ? '' : null,
          onclick: function () { startStudy(); }
        }),
        el('button', { class: 'btn ghost', text: '导入 / 追加', onclick: function () { navigate('import'); } })
      ]),
      el('div', { class: 'chips', style: 'margin-top:10px' }, [
        el('button', { class: 'chip', text: '节奏设置', onclick: function () { goTab('settings'); } })
      ])
    ]);
    screen.appendChild(info);

    screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:12px' }, [
      el('button', { class: 'btn soft', text: '短语视图', onclick: function () { navigate('phrases'); } }),
      el('button', { class: 'btn ghost', text: '词本', onclick: function () { goTab('book'); } })
    ]));

    if (wrong) {
      screen.appendChild(el('div', { class: 'card pad', style: 'margin-top:12px' }, [
        el('div', { style: 'font-weight:650', text: '📛 错词本' }),
        el('div', { class: 'muted small', text: '拼写易错与词义混淆分类展示，可在词本页筛选。' })
      ]));
    }
  }

  function stat(label, n, sub) {
    return el('div', { class: 'stat' }, [
      el('div', { class: 'n', text: String(n) }),
      el('div', { class: 'l', text: label + (sub ? ' · ' + sub : '') })
    ]);
  }

  /**
   * Long lists are capped for render performance. The cap is always surfaced
   * above the list so a 5000-word book can never look like it lost 4700 words.
   */
  function capNotice(shown, total, label) {
    if (shown >= total) return null;
    return el('div', {
      class: 'capnotice',
      text: '仅显示前 ' + shown + (label ? '，共 ' + total + ' ' + label : '') +
        '。当前版本未做虚拟滚动，请用搜索缩小范围。'
    });
  }

  function topbar(title, sub) {
    return el('header', { class: 'topbar' }, [
      el('div', { class: 'grow' }, [
        el('h1', { text: title }),
        sub ? el('div', { class: 'sub', text: sub }) : null
      ])
    ]);
  }

  /** The effective template: the user's saved copy if any, else the built-in one. */
  function effectiveTemplate() {
    var s = store.loadSettings();
    var custom = s.customTemplate;
    return (typeof custom === 'string' && custom.trim()) ? custom : appmeta.TEMPLATE;
  }

  function showTemplate() {
    var current = effectiveTemplate();
    var isCustom = current !== appmeta.TEMPLATE;
    var ta = el('textarea', {
      class: 'input', style: 'min-height:240px;font-family:ui-monospace,monospace;font-size:12.5px',
      spellcheck: 'false', value: current
    });
    var box = el('div', {}, [
      el('p', { class: 'muted small', text: '复制后粘到任意 AI 对话框，最后一行换成你要的内容。这个模板可以直接改，改完点「保存为我的模板」。' }),
      ta,
      isCustom ? el('div', { class: 'tiny', style: 'color:var(--brand);margin-top:6px', text: '当前使用的是你保存的自定义模板' }) : null
    ]);
    openSheet('AI 生成词表提示词', box, [
      el('button', { class: 'btn ghost', text: '恢复默认', onclick: function () {
        saveSettings({ customTemplate: '' });
        closeSheet();
        toast('已恢复默认模板');
        showTemplate();
      } }),
      el('button', { class: 'btn ghost', text: '保存为我的模板', onclick: function () {
        var v = ta.value;
        if (!v.trim()) { toast('模板不能为空'); return; }
        saveSettings({ customTemplate: v === appmeta.TEMPLATE ? '' : v });
        closeSheet();
        toast(v === appmeta.TEMPLATE ? '与默认一致，已清除自定义' : '已保存');
      } }),
      el('button', { class: 'btn', text: '复制提示词', onclick: function () { copy(ta.value); } })
    ]);
  }

  /* ---------------------------------------------------------------- import */

  function screenImport() {
    var screen = el('div', { class: 'screen narrow' });
    screen.appendChild(el('header', { class: 'topbar' }, [
      el('button', { class: 'btn ghost sm', text: '取消', onclick: function () { navigate(null); } }),
      el('div', { class: 'grow center', style: 'font-weight:650', text: '导入词本' }),
      el('button', { class: 'btn ghost sm', text: '模板', onclick: showTemplate })
    ]));
    var ta = el('textarea', {
      class: 'input', id: 'import-text', spellcheck: 'false', autocapitalize: 'off',
      placeholder: '把 AI 输出整段粘在这里…\n\nabandon /əˈbændən/ v. 放弃；抛弃\n  - abandon oneself to 沉溺于\n\n也支持 CSV / TSV / JSON。'
    });
    screen.appendChild(ta);
    screen.appendChild(el('div', { class: 'muted tiny', style: 'margin-top:8px', text: '提示：让 AI 把词表放在代码块里输出，直接复制粘贴即可。只解析第一个代码块。' }));
    screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:14px' }, [
      el('button', { class: 'btn', text: '导入', onclick: function () { doParseImport(ta.value); } }),
      el('button', { class: 'btn ghost', text: '从文件导入', onclick: pickImportFile }),
      el('button', { class: 'btn ghost', text: '清空', onclick: function () { ta.value = ''; ta.focus(); } })
    ]));
    var overwrite = el('input', { type: 'checkbox', checked: state.pendingOverwrite ? 'checked' : null });
    overwrite.addEventListener('change', function () {
      state.pendingOverwrite = overwrite.checked;
    });
    screen.appendChild(el('label', { class: 'checkline', style: 'margin-top:12px' }, [
      overwrite,
      el('div', { class: 'body' }, [
        el('div', { class: 'small', text: '覆盖导入（用这份词表整体替换）' }),
        el('div', { class: 'tiny muted', text: '同词保留学习进度；不在新词表里的词会被丢弃（导入前自动备份）。' })
      ])
    ]));
    return screen;
  }

  function pickImportFile() {
    if (!native || !bridge) { toast('浏览器调试请直接粘贴文本'); return; }
    bridge.pickFile().then(function (r) {
      if (!r || !r.ok) { if (r && r.error !== 'cancelled') toast(r.error || '读取失败'); return; }
      var text = r.base64 && !r.text ? '' : (r.text || '');
      if (!text && r.base64) { toast('不支持二进制文件，请另存为 CSV/TSV'); return; }
      var ta = $('#import-text');
      if (ta) ta.value = text;
      doParseImport(text, r.name);
    });
  }

  function doParseImport(text, filename) {
    if (!text || !String(text).trim()) { toast('请先粘贴词表'); return; }
    var parsed = parser.parse(text, { filename: filename });
    if (!parsed.ok) { showError(parsed.error); return; }
    var plan = merger.buildPlan(store.loadBook(), parsed, { now: Date.now(), srcStem: filename });
    state.import = {
      parsed: parsed, plan: plan, text: text, filename: filename || '',
      choices: {}, overrides: {}, mode: 'auto',
      overwrite: !!state.pendingOverwrite,
      mergedNote: parsed.counts.duplicates
    };
    navigate('import-summary');
  }

  function screenImportSummary() {
    var imp = state.import;
    var screen = el('div', { class: 'screen narrow' });
    var plan = imp.plan;
    var c = plan.counts;
    var skipCount = c.unparsed;
    var totalLines = Math.max(1, imp.parsed.counts.lines);
    var heavySkip = skipCount / totalLines > 0.2;

    screen.appendChild(el('header', { class: 'topbar' }, [
      el('button', { class: 'btn ghost sm', text: '返回', onclick: function () { navigate('import'); } }),
      el('div', { class: 'grow center', style: 'font-weight:650', text: '本次导入' })
    ]));

    var summary = el('div', { class: 'card pad' }, [
      el('div', { class: 'kv' }, [
        el('span', { class: 'k', text: '✅ 可导入' }),
        el('span', { class: 'v', text: c.addable + ' 个词（新增 ' + c.added + ' / 更新 ' + c.updated + ' / 无变化 ' + c.unchanged + '）' }),
        el('span', { class: 'k', text: '⏭️ 跳过' }),
        el('span', { class: 'v', text: skipCount + ' 行（无法解析）' })
      ])
    ]);
    if (heavySkip) {
      summary.style.borderColor = 'var(--warn)';
      summary.style.background = 'var(--warn-soft)';
      summary.appendChild(el('div', { class: 'small', style: 'color:var(--warn);margin-top:10px;font-weight:600', text: '格式可能有问题，建议复制提示词重新生成。' }));
    }
    if (imp.parsed.extraBlocks) {
      summary.appendChild(el('div', { class: 'tiny muted', style: 'margin-top:8px', text: '只解析第一个代码块，已忽略其余 ' + imp.parsed.extraBlocks + ' 个代码块。' }));
    } else if (imp.parsed.fallbackUsed) {
      summary.appendChild(el('div', { class: 'tiny muted', style: 'margin-top:8px', text: '代码块内没有词条，已回退解析代码块外内容。' }));
    } else if (imp.parsed.outsideIgnored) {
      summary.appendChild(el('div', { class: 'tiny muted', style: 'margin-top:8px', text: '已忽略代码块外的说明文字。' }));
    }
    screen.appendChild(summary);

    if (!c.addable) {
      screen.appendChild(el('div', { class: 'card pad', style: 'margin-top:12px' }, [
        el('div', { style: 'font-weight:650', text: '未识别到可导入词条' }),
        el('div', { class: 'muted small', text: '请检查格式，或复制提示词让 AI 重新生成。' })
      ]));
      screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:14px' }, [
        el('button', { class: 'btn ghost', text: '返回修改', onclick: function () { navigate('import'); } }),
        el('button', { class: 'btn soft', text: '查看提示词', onclick: showTemplate })
      ]));
      appendDetailFold(screen, imp, heavySkip);
      return screen;
    }

    if (imp.overwrite) {
      screen.appendChild(el('div', { class: 'card pad', style: 'margin-top:12px;background:var(--danger-soft)' }, [
        el('div', { class: 'small', style: 'color:var(--danger);font-weight:650', text: '覆盖导入模式' }),
        el('div', { class: 'tiny', style: 'color:var(--danger)', text: '将整体替换现有词本。点确认后会先让你核对将丢失的词数。' })
      ]));
    }

    screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:14px' }, [
      el('button', {
        class: 'btn', text: imp.overwrite ? '确认覆盖导入' : confirmLabel(c),
        onclick: function () { confirmImport(); }
      }),
      el('button', { class: 'btn ghost', text: '取消', onclick: function () { state.import = null; navigate(null); } })
    ]));

    appendDetailFold(screen, imp, heavySkip);
    return screen;
  }

  function confirmLabel(c) {
    var base = '确认导入 ' + c.addable + ' 词';
    if (c.unparsed > 0) base += '，跳过 ' + c.unparsed + ' 行';
    return base;
  }

  function appendDetailFold(screen, imp, forceOpen) {
    var plan = imp.plan;
    var c = plan.counts;
    var parts = [];
    if (c.unparsed) parts.push(c.unparsed + ' 行跳过');
    if (c.trimmed) parts.push(c.trimmed + ' 个词义项已截断');
    if (plan.deform && plan.deform.length) parts.push(plan.deform.length + ' 个疑似变形');
    if (c.duplicates) parts.push(c.duplicates + ' 个重复已合并');
    if (c.noMeaning) parts.push(c.noMeaning + ' 个无释义');
    if (imp.parsed.extraBlocks) parts.push('已忽略 ' + imp.parsed.extraBlocks + ' 个代码块');
    if (imp.parsed.outsideIgnored) parts.push('已忽略代码块外内容');
    if (imp.parsed.fallbackUsed) parts.push('已回退解析代码块外内容');
    var details = el('details', { class: 'fold', open: forceOpen ? true : null }, [
      el('summary', { text: '查看详情（' + (parts.join(' / ') || '无异常') + '）' }),
      el('div', { style: 'margin-top:10px' }, detailSections(imp))
    ]);
    // Low-confidence column inference means the preview may be wrong; open the
    // mapping panel instead of letting the user confirm a bad guess.
    if (imp.parsed.mode === 'table' && (imp.parsed.mappingConfidence || 0) < 0.8) {
      details.setAttribute('open', '');
      details.appendChild(el('div', { class: 'tiny', style: 'color:var(--warn);margin-top:6px', text: '列识别把握不大，请在下方调整列映射后再确认。' }));
    }
    screen.appendChild(details);
  }

  function detailSections(imp) {
    var out = [];
    var plan = imp.plan;
    var parsed = imp.parsed;

    if (parsed.outsideIgnored) {
      out.push(el('div', { class: 'small muted', style: 'margin-bottom:8px', text: '已忽略代码块外的内容（只解析第一个代码块）。' }));
    }
    if (parsed.extraBlocks) {
      out.push(el('div', { class: 'small muted', style: 'margin-bottom:8px', text: '已忽略其余 ' + parsed.extraBlocks + ' 个代码块。' }));
    }
    if (parsed.fallbackUsed) {
      out.push(el('div', { class: 'small muted', style: 'margin-bottom:8px', text: '代码块内没有词条，已回退解析代码块外内容。' }));
    }
    if (plan.counts.duplicates) {
      out.push(el('div', { class: 'small muted', style: 'margin-bottom:8px', text: '已自动合并 ' + plan.counts.duplicates + ' 个同批重复词。' }));
    }

    if (plan.counts.unparsed) {
      var skipBox = el('div', { style: 'margin:10px 0' });
      skipBox.appendChild(el('div', { class: 'split' }, [
        el('div', { class: 'grow', style: 'font-weight:650', text: '无法解析 ' + plan.counts.unparsed + ' 行' }),
        el('button', { class: 'btn ghost sm', text: '复制全部', onclick: function () {
          copy(plan.unparsed.map(function (u) { return u.raw; }).join('\n'));
        } })
      ]));
      plan.unparsed.slice(0, 200).forEach(function (u) {
        skipBox.appendChild(el('div', { class: 'checkline' }, [
          el('div', { class: 'body' }, [
            el('div', { class: 'small', text: u.raw }),
            el('div', { class: 'tiny muted', text: '第 ' + (u.line + 1) + ' 行 · ' + reasonText(u.reason) })
          ]),
          el('button', { class: 'btn ghost sm', text: '复制', onclick: function () { copy(u.raw); } })
        ]));
      });
      if (plan.unparsed.length > 200) {
        skipBox.appendChild(el('div', { class: 'tiny muted', text: '只显示前 200 行，可用「复制全部」拿走去重生成。' }));
      }
      out.push(skipBox);
    }

    if (plan.trimmed && plan.trimmed.length) {
      var tbox = el('div', { style: 'margin:10px 0' });
      tbox.appendChild(el('div', { style: 'font-weight:650', text: '义项已截断 ' + plan.trimmed.length + ' 个（首次为准，每词性保留 2 个、总计 4 个）' }));
      plan.trimmed.forEach(function (t) {
        tbox.appendChild(el('div', { class: 'checkline' }, [
          el('div', { class: 'body' }, [
            el('div', { class: 'small', style: 'font-weight:600', text: t.en }),
            el('div', { class: 'tiny muted', text: '保留：' + t.kept }),
            el('div', { class: 'tiny', style: 'color:var(--warn)', text: '已截断：' + t.dropped.map(function (d) { return d.text; }).join('、') })
          ]),
          el('button', { class: 'btn ghost sm', text: '复制', onclick: function () {
            copy(t.en + ': 已截断「' + t.dropped.map(function (d) { return d.text; }).join('」「') + '」');
          } })
        ]));
      });
      tbox.appendChild(el('button', { class: 'btn ghost sm', text: '复制全部截断记录', onclick: function () {
        copy(plan.trimmed.map(function (t) {
          return t.en + ': 已截断「' + t.dropped.map(function (d) { return d.text; }).join('」「') + '」';
        }).join('\n'));
      } }));
      out.push(tbox);
    }

    if (plan.deform && plan.deform.length) {
      var dbox = el('div', { style: 'margin:10px 0' });
      dbox.appendChild(el('div', { style: 'font-weight:650', text: '疑似变形 ' + plan.deform.length + ' 个（不自动合并）' }));
      plan.deform.forEach(function (d) {
        dbox.appendChild(el('div', { class: 'checkline' }, [
          el('div', { class: 'body' }, [
            el('div', { class: 'small', text: d.from + ' → ' + d.to }),
            el('div', { class: 'tiny muted', text: d.note || '后缀启发式提示，仅供参考' })
          ]),
          el('button', { class: 'btn ghost sm', text: '合并', onclick: function () { mergeDeform(d.from, d.to); } })
        ]));
      });
      out.push(dbox);
    }

    if (plan.counts.noMeaning) {
      var nm = el('div', { style: 'margin:10px 0;background:var(--warn-soft);border-radius:10px;padding:10px' }, [
        el('div', { class: 'small', style: 'color:var(--warn);font-weight:650', text: '以下 ' + plan.counts.noMeaning + ' 个词无释义，听写时无中文提示' }),
        el('div', { class: 'tiny', style: 'color:var(--warn);margin-top:4px', text: plan.noMeaning.slice(0, 40).map(function (n) { return n.en; }).join('、') })
      ]);
      out.push(nm);
    }

    if (imp.parsed.mode === 'table') {
      out.push(mappingBlock(imp));
    }

    out.push(el('div', { class: 'tiny muted', style: 'margin-top:8px', text: '解析模式：' + modeText(imp.parsed.mode) + ' · 用时 ' + imp.parsed.elapsedMs + 'ms · 批次 ' + plan.src }));

    var modeRow = el('div', { class: 'chips', style: 'margin-top:8px' });
    [['auto', '自动'], ['dict', '词典式'], ['table', '表格'], ['json', 'JSON']].forEach(function (m) {
      modeRow.appendChild(el('button', {
        class: 'chip' + ((imp.mode || 'auto') === m[0] ? ' on' : ''),
        text: m[1],
        onclick: function () {
          imp.mode = m[0];
          imp.parsed = parser.parse(imp.text, { mode: m[0], filename: imp.filename, mapping: imp.overrides.mapping });
          var srcStem = imp.filename;
          imp.plan = merger.buildPlan(store.loadBook(), imp.parsed, { now: Date.now(), srcStem: srcStem });
          imp.choices = {};
          render();
        }
      }));
    });
    out.push(modeRow);
    return out;
  }

  function mappingBlock(imp) {
    var wrap = el('div', { style: 'margin:10px 0' });
    var map = imp.overrides.mapping || imp.parsed.mapping;
    var rows = imp.parsed.tableRows || [];
    wrap.appendChild(el('div', { style: 'font-weight:650', text: '列映射（置信度 ' + Math.round((imp.parsed.mappingConfidence || 0) * 100) + '%）' }));
    var cols = ['word', 'phonetic', 'zh', 'pos', 'collo', 'tags'];
    var labels = { word: '单词', phonetic: '音标', zh: '释义', pos: '词性', collo: '搭配', tags: '标签' };
    var preview = el('div', { class: 'small mono muted', style: 'margin:6px 0;overflow:hidden' });
    if (rows.length) {
      preview.textContent = rows.slice(0, 2).map(function (r) { return r.cells.join(' | '); }).join('\n');
    }
    wrap.appendChild(preview);
    var grid = el('div', { class: 'chips' });
    cols.forEach(function (col) {
      var value = map[col];
      var btn = el('button', { class: 'chip' + (value >= 0 ? ' on' : ''), text: labels[col] + '：' + (value >= 0 ? '第 ' + (value + 1) + ' 列' : '未映射') });
      btn.addEventListener('click', function () {
        var next = (value + 2) % (Math.max(1, imp.parsed.mapping ? imp.parsed.mapping.width : 6) + 1) - 1;
        var nm = Object.assign({}, map);
        nm[col] = next;
        imp.overrides.mapping = nm;
        imp.parsed = parser.parse(imp.text, { mode: 'table', mapping: nm, filename: imp.filename });
        imp.plan = merger.buildPlan(store.loadBook(), imp.parsed, { now: Date.now() });
        imp.choices = {};
        render();
      });
      grid.appendChild(btn);
    });
    wrap.appendChild(grid);
    wrap.appendChild(el('div', { class: 'tiny muted', text: '点列名循环切换列号；单词列必须有值。' }));
    return wrap;
  }

  function reasonText(code) {
    var map = {
      'no-english': '没有英文',
      'bad-word': '单词格式不合法',
      'phrase-without-parent': '短语没有归属词',
      'empty-word': '单词为空',
      'not-object': 'JSON 不是对象',
      'json-invalid': 'JSON 无法解析',
      'no-table': '不是有效表格'
    };
    return map[code] || code;
  }

  function modeText(mode) {
    return { dict: '词典式', table: '表格', json: 'JSON' }[mode] || mode;
  }

  function mergeDeform(from, to) {
    var book = store.loadBook();
    var srcKey = util.wordKey(from);
    var dstKey = util.wordKey(to);
    var src = book.words[srcKey];
    var dst = book.words[dstKey];
    if (!src || !dst) { toast('合并失败：词条不存在'); return; }
    var srcHasProgress = src.progress && src.progress.seen;
    var dstHasProgress = dst.progress && dst.progress.seen;
    var apply = function () {
      (src.collo || []).forEach(function (c) { util.uniqPush(dst.collo, c); });
      (src.tags || []).forEach(function (t) { util.uniqPush(dst.tags, t); });
      if (!dst.phonetic && src.phonetic) dst.phonetic = src.phonetic;
      store.deleteWord(from, Date.now());
      store.saveBook(book);
      toast('已合并 ' + from + ' → ' + to);
      state.import.plan.deform = state.import.plan.deform.filter(function (d) { return d.from !== from; });
      render();
    };
    if (srcHasProgress && dstHasProgress) {
      openSheet('两条都有学习进度', el('div', {}, [
        el('p', { class: 'small', text: '「' + from + '」和「' + to + '」都有学习进度。合并会保留「' + to + '」的进度，并删除「' + from + '」（可在最近删除里找回）。' })
      ]), [
        el('button', { class: 'btn ghost', text: '取消', onclick: closeSheet }),
        el('button', { class: 'btn danger', text: '仍然合并', onclick: function () { closeSheet(); apply(); } })
      ]);
      return;
    }
    apply();
  }

  function confirmImport() {
    var imp = state.import;
    if (imp.overwrite) {
      var existing = Object.keys(store.loadBook().words).length;
      var incoming = {};
      (imp.parsed.entries || []).forEach(function (e) {
        if (util.validWord(e.en)) incoming[util.wordKey(e.en)] = true;
      });
      var dropped = 0;
      Object.keys(store.loadBook().words).forEach(function (k) {
        if (!incoming[k]) dropped++;
      });
      openSheet('覆盖导入确认', el('div', {}, [
        el('p', { class: 'small', text: '将用本次词表整体替换现有 ' + existing + ' 个词。' }),
        el('p', { class: 'small', text: '同词的学习进度、创建时间和已有标签会保留。' }),
        dropped
          ? el('p', { class: 'small', style: 'color:var(--danger);font-weight:600', text: '将丢失 ' + dropped + ' 个不在新词表中的词及其学习进度。' })
          : el('p', { class: 'small muted', text: '没有词会丢失。' }),
        el('p', { class: 'tiny muted', text: '执行前会自动备份，可在数据面板恢复。' })
      ]), [
        el('button', { class: 'btn ghost', text: '取消', onclick: closeSheet }),
        el('button', { class: 'btn danger', text: '覆盖导入', onclick: function () {
          closeSheet();
          var res = store.commitReplace(imp.parsed, {
            now: Date.now(), mode: imp.parsed.mode, source: imp.filename ? 'file' : 'paste'
          });
          if (!res.ok) { showError(res.error || '覆盖导入失败'); return; }
          state.lastImport = {
            added: Object.keys(res.book.words || {}).length,
            updated: 0,
            skipped: (imp.parsed.unparsed || []).length,
            replaced: true,
            dropped: res.dropped
          };
          state.import = null;
          navigate('import-done');
        } })
      ]);
      return;
    }
    var plan = imp.plan;
    var res = store.commitPlan(plan, imp.choices, {
      now: Date.now(), mode: imp.parsed.mode, source: imp.filename ? 'file' : 'paste'
    });
    if (!res.ok) { showError(res.error || '导入失败'); return; }
    state.lastImport = {
      added: plan.counts.added,
      updated: plan.counts.updated,
      skipped: plan.counts.unparsed
    };
    state.import = null;
    navigate('import-done');
  }

  function screenImportDetail() {
    var imp = state.import;
    var screen = el('div', { class: 'screen narrow' });
    screen.appendChild(el('header', { class: 'topbar' }, [
      el('button', { class: 'btn ghost sm', text: '返回', onclick: function () { navigate('import-summary'); } }),
      el('div', { class: 'grow center', style: 'font-weight:650', text: '导入详情' })
    ]));
    detailSections(imp).forEach(function (n) { screen.appendChild(n); });
    return screen;
  }

  /**
   * After an import, fetch audio for the words the user will meet first.
   *
   * Downloading a whole wordbook up front would spend data and disk on words that
   * may not be studied for weeks, and imported books can be thousands of entries.
   * The next study group is what actually gets heard in the next few minutes, so
   * warming exactly that makes the first session fully human-voiced at a bounded
   * cost. Everything else fills in as it is reached (see prefetchStudyCards).
   */
  function prefetchFirstStudyGroup() {
    if (!wantsHumanAudio()) return;
    try {
      var settings = store.loadSettings();
      var groupSize = Number(settings.dailyGoal) || 15;
      var newPerDay = Number(settings.newPerDay);
      if (!isFinite(newPerDay)) newPerDay = 7;
      var cards = selector.selectLearnGroup(store.loadBook(), {
        scope: state.scope, now: Date.now(), seed: Date.now() % 100000,
        groupSize: groupSize, newPerDay: newPerDay
      });
      if (!cards.length) return;
      // Same text set the study screen will play, including collocations.
      prefetchStudyCards(cards, 0, 6);
    } catch (e) { /* warming is best-effort; never block an import */ }
  }

  /** Shows how much disk the recorded audio uses, with a clear-out action. */
  function audioStorageRow() {
    if (!native) {
      return el('div', { class: 'tiny muted', style: 'margin-top:8px', text: '浏览器调试不缓存音频' });
    }
    var info = {};
    try { info = nativeParse(root.MociNative.audioStats(), {}) || {}; } catch (e) { info = {}; }
    var used = util.formatBytes(info.bytes || 0);
    var budget = util.formatBytes(info.budgetBytes || 0);
    return el('div', { style: 'margin-top:10px' }, [
      el('div', { class: 'tiny muted', text: '已缓存发音：' + used + ' / 上限 ' + budget }),
      el('div', { class: 'tiny muted', text:
        '缓存的发音保存在 App 私有目录，卸载才会清除；超过上限时自动删除最久未听的录音。' }),
      el('button', { class: 'btn ghost sm', style: 'margin-top:6px', text: '清除已缓存发音', onclick: function () {
        try { root.MociNative.audioClear(); } catch (e) { }
        toast('已清除发音缓存');
        render();
      } })
    ]);
  }

  function screenImportDone() {
    var r = state.lastImport || { added: 0, updated: 0, skipped: 0 };
    var screen = el('div', { class: 'screen narrow' });
    screen.appendChild(el('div', { class: 'card pad empty' }, [
      el('div', { class: 'big', text: '✅' }),
      el('h2', { text: '导入完成' }),
      el('p', { class: 'muted small', text: '新增 ' + r.added + '，更新 ' + r.updated + '，跳过 ' + r.skipped + ' 行' }),
      el('p', { class: 'tiny muted', text: '正在为接下来要学的词准备真人发音，其余的词会在学到时自动补齐。' }),
      el('div', { class: 'btn-row', style: 'margin-top:16px' }, [
        el('button', { class: 'btn', text: '去学习', onclick: function () { goTab('home'); startStudy(); } }),
        el('button', { class: 'btn ghost', text: '回词本', onclick: function () { goTab('book'); } })
      ])
    ]));
    // Warm the group the user is about to study, after the screen is painted so
    // the import never appears to hang.
    setTimeout(prefetchFirstStudyGroup, 400);
    return screen;
  }

  /* ----------------------------------------------------------- study/dictate */

  function startStudy() {
    var book = store.loadBook();
    var settings = store.loadSettings();
    var groupSize = Number(settings.dailyGoal) || 15;
    var newPerDay = Number(settings.newPerDay);
    if (!isFinite(newPerDay)) newPerDay = 7;
    var cards = selector.selectLearnGroup(book, {
      scope: state.scope, now: Date.now(), seed: Date.now() % 100000,
      groupSize: groupSize, newPerDay: newPerDay
    });
    if (!cards.length) { toast('当前范围没有可学的词'); return; }
    state.session = {
      cards: cards,
      index: 0,
      flipped: false,
      mode: null,
      questions: null,
      qIndex: 0,
      answers: [],
      finished: false
    };
    state.ttsIssueNotified = false;
    navigate('study');
    ensureTtsReady();
    // Warm the first words before they are asked for. The study card had NO
    // prefetch at all, so every tap waited for a full synthesis (≈2s on the
    // device). Prefetching the current and next card makes the first tap and
    // every "next" a cache hit.
    prefetchStudyCards(cards, 0);
    if (state.autoSpeak) setTimeout(function () { speak(cards[0].en); }, 240);
  }

  /**
   * Renders meanings as one line per part of speech:
   *
   *   v.  有益于
   *   n.  益处
   *
   * The stored `zh` string keeps inline markers ("有益于 n. 益处"), so printing
   * it directly next to a separate `pos` line made the marker of the SECOND
   * sense appear on the FIRST sense's line. Parsing through the meaning module
   * keeps every sense with its own marker, and a sense whose POS matches the
   * entry line simply inherits it instead of repeating.
   */
  function appendMeaningBlock(container, pos, zh) {
    var entryPos = String(pos == null ? '' : pos).trim();
    var groups = [];
    try {
      // Passing the entry-line POS as the base lets the parser strip a leading
      // marker that merely repeats it ("v." + "v. 有益于" must not render twice)
      // while keeping every genuinely different sense marker intact.
      groups = meaning.parseSegments(zh, entryPos) || [];
    } catch (e) {
      groups = [];
    }
    groups = groups.filter(function (g) { return (g.items && g.items.length) || g.pos; });

    // One sense needs no alignment gutter; several do. See style.css for why a
    // reserved gutter on a single-sense card reads as a hole.
    var block = el('div', { class: 'zh-rows ' + (groups.length > 1 ? 'multi' : 'single') });
    if (!groups.length) {
      block.appendChild(el('div', { class: 'zh-row' }, [
        entryPos ? el('span', { class: 'zh-pos', text: entryPos }) : null,
        el('span', { class: 'zh-text', text: '（无释义，仅凭发音记忆）' })
      ]));
    } else {
      groups.forEach(function (g) {
        block.appendChild(el('div', { class: 'zh-row' }, [
          g.pos ? el('span', { class: 'zh-pos', text: g.pos }) : null,
          el('span', { class: 'zh-text', text: (g.items || []).join('；') })
        ]));
      });
    }
    container.appendChild(block);
  }

  function screenStudy() {
    var s = state.session;
    var screen = el('div', { class: 'screen narrow' });
    if (!s) { screen.appendChild(el('p', { class: 'muted', text: '没有学习会话' })); return screen; }
    var card = s.cards[s.index];
    var total = s.cards.length;

    screen.appendChild(el('header', { class: 'topbar' }, [
      el('button', { class: 'btn ghost sm', text: '结束', onclick: abortSession }),
      el('div', { class: 'grow center small muted', text: (s.index + 1) + ' / ' + total })
    ]));
    var bar = el('div', { class: 'progressbar' }, [el('i', { style: 'width:' + Math.round(((s.index + 1) / total) * 100) + '%' })]);
    screen.appendChild(bar);

    var cardEl = el('div', { class: 'study-card', style: 'margin-top:14px' }, [
      el('div', { class: 'chips', style: 'justify-content:center;margin:0' }, [
        el('span', { class: 'badge ' + (card.isNew ? 'new' : 'rev'), text: card.isNew ? '新' : '复' }),
        card.phonetic ? el('span', { class: 'phon', text: '/' + card.phonetic + '/' }) : null
      ]),
      el('div', { class: 'word', text: card.en }),
      el('button', { class: 'speak', style: 'margin:6px auto 0', text: '🔊', onclick: function () { speak(card.en); } })
    ]);

    if (s.flipped) {
      cardEl.appendChild(el('div', { class: 'divider' }));
      // Meanings are grouped by part of speech and rendered on their own line.
      // The old layout printed card.pos on a separate line and card.zh verbatim
      // below it, so "v." stood alone while the noun sense ("n. 益处") stayed
      // glued to the verb line — the two never lined up.
      appendMeaningBlock(cardEl, card.pos, card.zh);
      if (card.collo.length) {
        var list = el('div', { class: 'collo' });
        card.collo.forEach(function (c) {
          var split = selector.splitPhrase(c);
          list.appendChild(el('div', { class: 'split', style: 'margin-top:4px' }, [
            el('div', { class: 'grow', text: c }),
            el('button', { class: 'speak sm', text: '🔊', onclick: function () { speak(split.en); } })
          ]));
        });
        cardEl.appendChild(list);
      }
    }

    screen.appendChild(cardEl);

    if (!s.flipped) {
      screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:14px' }, [
        el('button', { class: 'btn block', text: '翻面看释义', onclick: function () {
          // Fire before the re-render so audio starts while the card is still
          // visually turning over (parallel, not sequential).
          if (state.autoSpeak) speak(card.en);
          s.flipped = true;
          render();
        } })
      ]));
    } else {
      screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:14px' }, [
        el('button', { class: 'btn ghost', text: '上一张', disabled: s.index === 0 ? '' : null, onclick: function () {
          if (s.index > 0) { s.index--; s.flipped = false; render(); prefetchStudyCards(s.cards, s.index); }
        } }),
        el('button', { class: 'btn', text: s.index === total - 1 ? '进入听写' : '下一张', onclick: function () {
          if (s.index === total - 1) { startDictation(); return; }
          s.index++;
          s.flipped = false;
          render();
          // Keep the next few words warm so their taps stay instant.
          prefetchStudyCards(s.cards, s.index);
          if (state.autoSpeak) speak(s.cards[s.index].en);
        } })
      ]));
    }
    return screen;
  }

  function abortSession() {
    openSheet('结束本次学习？', el('p', { class: 'small', text: '本次未进入听写的卡片不会更新记忆进度。' }), [
      el('button', { class: 'btn ghost', text: '继续学习', onclick: closeSheet }),
      el('button', { class: 'btn danger', text: '结束', onclick: function () {
        closeSheet();
        state.session = null;
        goTab('home');
      } })
    ]);
  }

  function startDictation() {
    var s = state.session;
    s.mode = 'pick';
    navigate('dictate');
  }

  function screenDictate() {
    var s = state.session;
    var screen = el('div', { class: 'screen narrow' });
    if (!s) { screen.appendChild(el('p', { class: 'muted', text: '没有听写会话' })); return screen; }
    if (s.mode === 'pick') return renderDictatePick(screen, s);
    if (s.mode === 'type' || s.mode === 'temp') return renderDictateType(screen, s);
    if (s.mode === 'hand') return renderDictateHand(screen, s);
    return screen;
  }

  function renderDictatePick(screen, s) {
    screen.appendChild(el('header', { class: 'topbar' }, [
      el('button', { class: 'btn ghost sm', text: '返回', onclick: function () { navigate('study'); } }),
      el('div', { class: 'grow center', style: 'font-weight:650', text: '听写' })
    ]));
    screen.appendChild(el('div', { class: 'card pad' }, [
      el('div', { style: 'font-weight:650', text: '选择作答方式' }),
      el('div', { class: 'muted small', text: '15 题打乱顺序，含短语题。键入判分完全在本机进行。' })
    ]));
    screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:14px' }, [
      el('button', { class: 'btn', text: '⌨️ 键入听写', onclick: function () {
        s.questions = selector.buildDictation(s.cards, { seed: Date.now() % 10000 });
        s.qIndex = 0;
        s.answers = [];
        s.mode = 'type';
        state.dictationSpoken = null; // a fresh round must speak question 1 again
        render();
        // Auto-speak is on for dictation, so warm several answers up front
        // instead of just the first one.
        prefetchDictation(s.questions, 0);
      } }),
      el('button', { class: 'btn ghost', text: '📝 手写拍照批改', onclick: function () { s.mode = 'hand'; render(); } })
    ]));
    screen.appendChild(el('div', { class: 'muted tiny', style: 'margin-top:12px', text: '手写模式需要配置 API Key，仅手写照片会发送到 AI 批改。' }));
    return screen;
  }

  function renderDictateType(screen, s) {
    // A retry pass reuses this exact renderer with its own queue/answers.
    var Q = s.retryPass ? s.retryQuestions : s.questions;
    var A = s.retryPass ? s.retryAnswers : s.answers;
    var idx = s.retryPass ? s.retryIndex : s.qIndex;
    var q = Q[idx];
    var answered = A[idx];
    if (!q) {
      screen.appendChild(el('p', { class: 'muted', text: '没有题目' }));
      return screen;
    }
    // Dictation is a listening exercise: speak the thing being tested as soon as
    // the question appears, so the user hears exactly what they must write. Fired
    // once per question (not on every re-render, which would repeat it after a
    // keystroke or a re-render of the same question).
    if (state.autoSpeak && state.dictationSpoken !== (s.retryPass ? 'r' + idx : 'q' + idx)) {
      state.dictationSpoken = s.retryPass ? 'r' + idx : 'q' + idx;
      var speakText = q.answer;
      setTimeout(function () { speak(speakText); }, 220);
    }
    screen.appendChild(el('header', { class: 'topbar' }, [
      el('button', { class: 'btn ghost sm', text: '退出', onclick: abortSession }),
      el('div', { class: 'grow center small muted', text: (s.retryPass ? '错题重练 ' : '第 ') + (idx + 1) + ' / ' + Q.length + ' 题' })
    ]));
    var dots = el('div', { class: 'dots' });
    Q.forEach(function (_, i) {
      var a = A[i];
      var cls = '';
      if (a) cls = a.correct ? 'ok' : 'err';
      if (i === idx) cls += ' cur';
      dots.appendChild(el('i', { class: cls }));
    });
    screen.appendChild(dots);

    // Dictation shows the meaning and, for phrases, the Chinese. It deliberately
    // does NOT show the phonetic spelling, and does NOT show the owning word for
    // a phrase: the owner ("affect") is a literal part of the answer
    // ("affect health"), so printing it handed over the answer.
    screen.appendChild(el('div', { class: 'card pad' }, [
      el('div', { class: 'qi-hint', text: q.type === 'phrase' ? '写出英文短语' : '写出英文单词' }),
      el('div', { class: 'qi', text: q.prompt || (q.type === 'word' ? '（无中文提示）' : '') }),
      q.type === 'word' && q.noMeaning ? el('div', { class: 'qi-hint', style: 'color:var(--warn)', text: '仅凭发音拼写，无中文提示' }) : null,
      el('div', { class: 'btn-row', style: 'justify-content:center;margin-top:8px' }, [
        el('button', { class: 'btn soft sm', text: '🔊 听发音', onclick: function () { speak(q.answer); } })
      ])
    ]));

    var input = el('input', {
      class: 'input answer-input', id: 'answer', type: 'text', spellcheck: 'false',
      autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', enterkeyhint: 'done',
      value: answered ? (answered.wrote || '') : '',
      disabled: answered ? '' : null
    });
    screen.appendChild(el('div', { style: 'margin-top:12px' }, [input]));

    if (!answered) {
      var submit = function () {
        var wrote = input.value;
        if (!String(wrote).trim()) { toast('先写下答案'); return; }
        var res = grader.judgeTyped(wrote, q.answer);
        if (s.retryPass) s.retryAnswers[s.retryIndex] = { wrote: wrote, correct: res.correct };
        else s.answers[s.qIndex] = { wrote: wrote, correct: res.correct };
        render();
        setTimeout(function () {
          var next = $('#next-q');
          if (next) next.focus();
        }, 30);
      };
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
        el('button', { class: 'btn block', text: '判分', onclick: submit })
      ]));
      setTimeout(function () { try { input.focus(); } catch (e) { } }, 60);
    } else {
      var ok = answered.correct;
      screen.appendChild(el('div', { class: 'judge ' + (ok ? 'ok' : 'err'), text: ok ? '✅ 正确' : '❌ 错误' }));
      if (!ok) {
        screen.appendChild(el('div', { class: 'center small muted', text: '正确答案：' }));
        screen.appendChild(el('div', { class: 'qi', style: 'color:var(--ok)', text: q.answer }));
      }
      var isLast = idx === Q.length - 1;
      screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:12px' }, [
        el('button', {
          class: 'btn block', id: 'next-q',
          text: isLast ? (s.retryPass ? '完成重练' : '查看结果') : '下一题',
          onclick: function () {
            if (isLast) { finishDictation(); return; }
            if (s.retryPass) s.retryIndex++;
            else s.qIndex++;
            render();
            // Keep the listening queue warm past the new position.
            prefetchDictation(Q, s.retryPass ? s.retryIndex : s.qIndex);
          }
        })
      ]));
    }
    return screen;
  }

  function finishDictation() {
    var s = state.session;
    var results = s.questions.map(function (q, i) {
      var a = s.answers[i] || { wrote: '', correct: false };
      return { q: q, wrote: a.wrote || '', correct: !!a.correct };
    });
    if (s.mode === 'temp') { applySessionResults(results, 'temp'); return; }

    // In-session retry: a wrong answer never waits for a five-minute due; it is
    // re-asked right away, at most five questions, before anything is settled.
    if (!s.retryPass) {
      var missed = results.filter(function (r) { return !r.correct; });
      if (missed.length) { startRetry(missed.slice(0, 5), results); return; }
      applySessionResults(results, 'learn');
      return;
    }
    // Retry finished: merge first-pass and retry verdicts per question key.
    var retryByKey = {};
    s.retryQuestions.forEach(function (q, i) {
      var a = s.retryAnswers[i] || { wrote: '', correct: false };
      retryByKey[q.key + '#' + q.answer] = { q: q, wrote: a.wrote || '', correct: !!a.correct };
    });
    var merged = s.firstPass.map(function (r) {
      var retried = retryByKey[r.q.key + '#' + r.q.answer];
      return retried ? retried : r;
    });
    applySessionResults(merged, 'learn', s.firstPass);
  }

  /** Re-asks the missed questions once; retry answers override the first pass. */
  function startRetry(missed, allResults) {
    var s = state.session;
    s.retryPass = true;
    s.retryQuestions = missed.map(function (r) { return r.q; });
    s.retryAnswers = [];
    s.retryIndex = 0;
    s.firstPass = allResults;
    s.mode = 'type'; // reuse the typed renderer; it reads the retry queue
    navigate('dictate');
    prefetchDictation(s.retryQuestions, 0);
  }

  function applySessionResults(results, kind) {
    var s = state.session;
    var now = Date.now();
    var book = store.loadBook();
    var stats = store.loadStats();
    var byWord = {};
    var newWords = 0;
    var touched = {};

    results.forEach(function (r) {
      var ownerKey = r.q.ownerKey;
      if (!byWord[ownerKey]) byWord[ownerKey] = [];
      byWord[ownerKey].push(r);
      var key = util.wordKey(ownerKey);
      if (kind === 'learn') touched[key] = true;
    });

    var evicted = [];
    Object.keys(byWord).forEach(function (ownerKey) {
      var answers = byWord[ownerKey];
      var anyWrong = answers.some(function (a) { return !a.correct; });
      var w = book.words[util.wordKey(ownerKey)];
      if (!w) return;
      if (kind === 'learn') {
        var wasNew = sm2.isNew(w.progress);
        w.progress = sm2.review(w.progress, !anyWrong, now);
        if (wasNew && w.progress.seen) newWords++;
        if (anyWrong) {
          var wrong = answers.filter(function (a) { return !a.correct; })[0];
          var targetKey = w.en;
          if (wrong.q.type === 'phrase') {
            var known = new Set(Object.keys(book.words));
            targetKey = grader.coreWordForPhrase(wrong.q.rawPhrase || wrong.q.answer, w.en, known);
          }
          var tw = book.words[util.wordKey(targetKey)];
          if (tw) {
            var mr = wrongbook.markWrong(book, util.wordKey(targetKey), wrong.wrote, wrong.q.answer, null, now);
            if (mr.evicted && mr.evicted.length) evicted = evicted.concat(mr.evicted);
          }
        }
      } else {
        if (anyWrong) {
          stats.tempPhraseWrong = (stats.tempPhraseWrong || 0) + answers.filter(function (a) { return !a.correct; }).length;
        }
      }
    });

    var total = results.length;
    var correct = results.filter(function (r) { return r.correct; }).length;
    var reviewed = Object.keys(touched).length;

    // Words without a Chinese meaning are dictated blind and would permanently
    // drag the accuracy rate down, so they advance SM-2 but stay out of stats.
    var scored = results.filter(function (r) { return !r.q.noMeaning; });
    var scoredTotal = scored.length;
    var scoredCorrect = scored.filter(function (r) { return r.correct; }).length;

    if (kind === 'learn') {
      stats = statsMod.recordSession(stats, {
        type: 'learn', total: scoredTotal, correct: scoredCorrect,
        newWords: newWords, reviewed: reviewed
      }, now);
    } else {
      stats = statsMod.recordSession(stats, { type: 'temp', total: scoredTotal, correct: scoredCorrect }, now);
    }

    store.saveBook(book);
    store.saveStats(stats);

    state.session = null;
    navigate('result', {
      results: results,
      kind: kind,
      newWords: newWords,
      reviewed: reviewed,
      evicted: evicted,
      scored: { total: scoredTotal, correct: scoredCorrect }
    });
  }

  function renderDictateHand(screen, s) {
    screen.appendChild(el('header', { class: 'topbar' }, [
      el('button', { class: 'btn ghost sm', text: '返回', onclick: function () { navigate('study'); } }),
      el('div', { class: 'grow center', style: 'font-weight:650', text: '手写批改' })
    ]));
    if (!s.questions) {
      s.questions = selector.buildDictation(s.cards, { seed: Date.now() % 10000 });
      s.qIndex = 0;
      s.answers = [];
    }
    screen.appendChild(el('div', { class: 'card pad' }, [
      el('div', { style: 'font-weight:650', text: '本页共 ' + s.questions.length + ' 题' }),
      el('div', { class: 'muted small', text: '按顺序写在纸上，拍一张整页照片上传。' })
    ]));
    var list = el('div', { class: 'card pad', style: 'margin-top:12px' });
    s.questions.forEach(function (q, i) {
      list.appendChild(el('div', { class: 'checkline' }, [
        el('div', { class: 'body' }, [
          el('div', { class: 'small', text: (i + 1) + '. ' + (q.prompt || '（无中文提示）') }),
          el('div', { class: 'tiny muted', text: q.type === 'phrase' ? '短语 · 所属 ' + q.owner : '单词' })
        ])
      ]));
    });
    screen.appendChild(list);

    var key = getPref('apiKey', '');
    if (!key) {
      screen.appendChild(el('div', { class: 'card pad', style: 'margin-top:12px;background:var(--warn-soft)' }, [
        el('div', { class: 'small', style: 'color:var(--warn);font-weight:650', text: '需要配置 API Key' }),
        el('div', { class: 'tiny', style: 'color:var(--warn)', text: '拍照批改是唯一的 AI 用途。请到设置页填入 API Key 后重试。' })
      ]));
    }
    screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:14px' }, [
      el('button', { class: 'btn', text: '拍照 / 选图', disabled: key ? null : '', onclick: function () { pickHandwritingImage(s); } }),
      el('button', { class: 'btn ghost', text: '手动核对', onclick: function () { navigate('dictate'); s.mode = 'type'; render(); } })
    ]));
    return screen;
  }

  function pickHandwritingImage(s) {
    if (!native || !bridge) { toast('浏览器调试不支持拍照，请用键入模式'); return; }
    bridge.camera().then(function (r) {
      if (r && r.ok && r.base64) { gradeHandwriting(s, r.base64); return; }
      if (r && r.error && r.error !== 'cancelled') {
        bridge.pickImage().then(function (r2) {
          if (r2 && r2.ok && r2.base64) gradeHandwriting(s, r2.base64);
          else if (r2 && r2.error !== 'cancelled') showError(r2.error || '选图失败');
        });
      }
    });
  }

  function gradeHandwriting(s, base64) {
    var key = getPref('apiKey', '');
    var baseUrl = getPref('baseUrl', 'https://llm.ujn.edu.cn/v1');
    var model = getPref('model', 'deepseek-v41-flash');
    if (!key) { toast('请先在设置里配置 API Key'); return; }
    var items = s.questions.map(function (q) { return { type: q.type, answer: q.answer, prompt: q.prompt }; });
    var prompt = appmeta.buildGradingPrompt(items);
    var body = JSON.stringify({
      model: model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } },
          { type: 'text', text: prompt }
        ]
      }],
      temperature: 0.1,
      // Grading emits a JSON array for every question. Without an explicit budget
      // reasoning models spend the default allowance on thinking and return
      // truncated (unparseable) JSON, so state a budget large enough for both.
      max_tokens: 8192
    });
    toast('正在批改…');
    bridge.httpPost(baseUrl.replace(/\/+$/, '') + '/chat/completions', body).then(function (r) {
      if (!r || !r.ok) {
        var msg = (r && r.error) || ('HTTP ' + (r && r.status));
        try {
          var parsedErr = JSON.parse(r.body || '{}');
          if (parsedErr.error && parsedErr.error.message) msg = parsedErr.error.message;
        } catch (e) { }
        showError('批改失败：' + msg);
        return;
      }
      var text = '';
      try {
        var env = JSON.parse(r.body);
        text = env.choices[0].message.content;
      } catch (e) {
        showError('响应格式无法解析');
        return;
      }
      var results = parseGradingResponse(text, s.questions);
      s.answers = results.map(function (x) { return { wrote: x.wrote, correct: x.correct }; });
      navigate('result', { grading: results, questions: s.questions, handMode: true });
    });
  }

  function parseGradingResponse(text, questions) {
    var t = String(text || '');
    var lb = t.indexOf('{');
    var rb = t.lastIndexOf('}');
    if (lb >= 0 && rb > lb) t = t.slice(lb, rb + 1);
    var data = null;
    try { data = JSON.parse(t); } catch (e) { data = null; }
    var list = data && Array.isArray(data.results) ? data.results : [];
    var byIndex = {};
    var byEn = {};
    list.forEach(function (r, i) {
      if (!r || typeof r !== 'object') return;
      var idx = Number(r.index);
      if (idx >= 1 && idx <= questions.length) byIndex[idx - 1] = r;
      if (r.en) byEn[grader.normalizeAnswer(r.en)] = r;
    });
    return questions.map(function (q, i) {
      var r = byIndex[i] || byEn[grader.normalizeAnswer(q.answer)] || null;
      if (!r) return { q: q, wrote: '', correct: false, note: '未识别', missing: true };
      var rec = grader.reconcileAiVerdict(r.wrote || '', q.answer, !!r.correct);
      var note = r.note || '';
      if (rec.note === 'transcription-mismatch') note = '识别文本与答案不符，已按拼写错误判分';
      return {
        q: q, wrote: r.wrote || '', correct: rec.correct,
        exempted: rec.exempted, note: note, missing: false
      };
    });
  }

  /* ---------------------------------------------------------------- result */

  function screenResult() {
    var data = state.screenData;
    var screen = el('div', { class: 'screen narrow' });
    if (data.grading) return renderHandResult(screen, data);

    var results = data.results || [];
    var total = results.length;
    var correct = results.filter(function (r) { return r.correct; }).length;
    var rate = total ? Math.round((correct / total) * 100) : 0;

    screen.appendChild(topbar('本次结果', correct + ' / ' + total + ' 正确 · 正确率 ' + rate + '%'));
    screen.appendChild(el('div', { class: 'card pad center' }, [
      el('div', { style: 'font-size:44px;font-weight:700;line-height:1.1', text: rate + '%' }),
      el('div', { class: 'muted small', text: '新词 ' + (data.newWords || 0) + ' · 复习 ' + (data.reviewed || 0) })
    ]));

    if (data.evicted && data.evicted.length) {
      screen.appendChild(el('div', { class: 'card pad', style: 'margin-top:12px;background:var(--warn-soft)' }, [
        el('div', { class: 'small', style: 'color:var(--warn)', text: '错词本已满 30，移除了 ' + data.evicted.length + ' 个最不活跃的错词：' + data.evicted.join('、') })
      ]));
    }

    var list = el('div', { class: 'cardlist', style: 'margin-top:12px' });
    results.forEach(function (r, i) {
      var q = r.q;
      list.appendChild(el('div', { class: 'rowcard' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'head' }, [
            el('span', { class: 'badge ' + (r.correct ? 'ok' : 'err'), text: r.correct ? '对' : '错' }),
            el('span', { class: 'en', text: q.answer }),
            el('span', { class: 'ph', text: q.type === 'phrase' ? '短语' : '单词' })
          ]),
          el('div', { class: 'zh', text: '提示：' + (q.prompt || '无') }),
          r.correct ? null : el('div', { class: 'tiny', style: 'color:var(--danger);margin-top:3px', text: '你写：' + (r.wrote || '（空）') })
        ])
      ]));
    });
    screen.appendChild(list);

    screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:14px' }, [
      el('button', { class: 'btn', text: '再来一组', onclick: function () { goTab('home'); startStudy(); } }),
      el('button', { class: 'btn ghost', text: '回首页', onclick: function () { goTab('home'); } })
    ]));
    return screen;
  }

  function renderHandResult(screen, data) {
    var results = data.grading;
    var total = results.length;
    var correct = results.filter(function (r) { return r.correct; }).length;
    screen.appendChild(topbar('批改复核', correct + ' / ' + total + ' 正确，可逐题修正'));
    var list = el('div', { class: 'cardlist' });
    results.forEach(function (r, i) {
      var toggle = el('button', {
        class: 'btn sm ' + (r.correct ? 'ok' : 'danger'),
        text: r.correct ? '对' : '错',
        onclick: function () {
          r.correct = !r.correct;
          this.textContent = r.correct ? '对' : '错';
          this.className = 'btn sm ' + (r.correct ? 'ok' : 'danger');
          saveBtn.disabled = false;
        }
      });
      list.appendChild(el('div', { class: 'rowcard' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'head' }, [
            el('span', { class: 'muted tiny', text: '第 ' + (i + 1) + ' 题' }),
            el('span', { class: 'en', text: r.q.answer }),
            r.exempted ? el('span', { class: 'badge ok', text: '空格豁免' }) : null,
            r.missing ? el('span', { class: 'badge gray', text: '未识别' }) : null
          ]),
          el('div', { class: 'zh', text: '你写：' + (r.wrote || '（空）') }),
          r.note ? el('div', { class: 'tiny muted', text: r.note }) : null
        ]),
        toggle
      ]));
    });
    screen.appendChild(list);
    var saveBtn = el('button', { class: 'btn', text: '提交结果并结算', onclick: function () {
      var payload = results.map(function (r) {
        return { q: r.q, wrote: r.wrote, correct: r.correct };
      });
      state.session = { cards: [], questions: payload.map(function (p) { return p.q; }), answers: payload.map(function (p) { return p; }) };
      applySessionResults(payload, 'learn');
    } });
    screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:14px' }, [saveBtn]));
    return screen;
  }

  /* ------------------------------------------------------------ phrase view */

  function screenPhrases() {
    var book = store.loadBook();
    var all = merger.collectPhrases(book);
    var screen = el('div', { class: 'screen' });
    screen.appendChild(el('header', { class: 'topbar' }, [
      el('button', { class: 'btn ghost sm', text: '返回', onclick: function () { navigate(null); } }),
      el('div', { class: 'grow center', style: 'font-weight:650', text: '短语视图' }),
      el('div', { class: 'small muted', text: all.length + ' 条' })
    ]));
    if (!all.length) {
      screen.appendChild(el('div', { class: 'card pad empty' }, [
        el('div', { class: 'muted', text: '词本里还没有搭配短语。导入带 - 搭配行的词表即可。' })
      ]));
      return screen;
    }
    var selected = state.screenData.selected || {};
    var search = state.screenData.search || '';
    var searchInput = el('input', {
      class: 'input', placeholder: '搜索短语或释义', value: search,
      oninput: util.debounce(function () {
        state.screenData.search = this.value;
        render();
      }, 250)
    });
    screen.appendChild(searchInput);
    var filtered = all.filter(function (p) {
      if (!search) return true;
      var q = search.toLowerCase();
      return (p.en + ' ' + p.zh + ' ' + p.owner).toLowerCase().indexOf(q) >= 0;
    });
    var listWrap = el('div', { class: 'cardlist', style: 'margin-top:12px' });
    var shownPhrases = filtered.slice(0, 400);
    var phraseCap = capNotice(shownPhrases.length, filtered.length, '条短语');
    if (phraseCap) screen.appendChild(phraseCap);
    shownPhrases.forEach(function (p) {
      var on = !!selected[p.id];
      listWrap.appendChild(el('div', { class: 'rowcard' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'en', text: p.en }),
          el('div', { class: 'zh', text: p.zh || '（无中文）' }),
          el('div', { class: 'tiny muted', text: '所属：' + p.owner })
        ]),
        el('button', { class: 'chip' + (on ? ' on' : ''), text: on ? '已选' : '选择', onclick: function () {
          if (on) delete selected[p.id]; else selected[p.id] = true;
          state.screenData.selected = selected;
          render();
        } })
      ]));
    });
    screen.appendChild(listWrap);
    var count = Object.keys(selected).length;
    screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:14px' }, [
      el('button', { class: 'btn', text: '临时听写（已选 ' + count + '）', disabled: count ? null : '', onclick: function () {
        var picks = all.filter(function (p) { return selected[p.id]; }).slice(0, 50);
        var qs = selector.buildTempPhraseQuiz(picks, Date.now() % 10000);
        state.session = { cards: [], questions: qs, qIndex: 0, answers: [], mode: 'temp' };
        navigate('dictate');
      } }),
      count ? el('button', { class: 'btn ghost', text: '清空选择', onclick: function () { state.screenData.selected = {}; render(); } }) : null
    ]));
    screen.appendChild(el('div', { class: 'tiny muted', style: 'margin-top:8px', text: '临时听写只记录统计，不更新记忆进度、不写错词本。' }));
    return screen;
  }

  /* ------------------------------------------------------------------- book */

  function renderBook(screen) {
    var book = store.loadBook();
    var words = Object.keys(book.words || {});
    var q = state.screenData.bookQuery || '';
    var filter = state.screenData.bookFilter || 'all';

    screen.appendChild(topbar('词本', words.length + ' 词'));
    var input = el('input', {
      class: 'input', placeholder: '搜索单词、释义或搭配', value: q,
      oninput: util.debounce(function () {
        state.screenData.bookQuery = this.value;
        render();
      }, 250)
    });
    screen.appendChild(input);

    var chips = el('div', { class: 'chips' });
    [['all', '全部'], ['new', '新词'], ['learning', '学习中'], ['mastered', '已掌握'], ['wrong', '错词']].forEach(function (f) {
      chips.appendChild(el('button', { class: 'chip' + (filter === f[0] ? ' on' : ''), text: f[1], onclick: function () {
        state.screenData.bookFilter = f[0];
        render();
      } }));
    });
    screen.appendChild(chips);

    var list = merger.searchWords(book, q, { bucket: filter === 'all' ? null : filter, now: Date.now(), order: 'alpha' });
    if (!list.length) {
      screen.appendChild(el('div', { class: 'card pad empty' }, [el('div', { class: 'muted', text: '没有匹配的词' })]));
      return;
    }

    // Wrong words are grouped by cause: spelling slips vs meaning mix-ups.
    if (filter === 'wrong') {
      var spelling = list.filter(function (w) { return (w.tags || []).indexOf('拼写易错') >= 0; });
      var meaningMix = list.filter(function (w) { return (w.tags || []).indexOf('词义混淆') >= 0; });
      var other = list.filter(function (w) {
        return (w.tags || []).length && (w.tags || []).indexOf('拼写易错') < 0 && (w.tags || []).indexOf('词义混淆') < 0;
      });
      [
        ['📛 拼写易错', spelling],
        ['🔀 词义混淆', meaningMix],
        ['🏷️ 自定义标签', other]
      ].forEach(function (group) {
        if (!group[1].length) return;
        screen.appendChild(el('div', { class: 'small muted', style: 'margin:12px 2px 6px;font-weight:650', text: group[0] + ' · ' + group[1].length }));
        var wrap = el('div', { class: 'cardlist' });
        var shownGroup = group[1].slice(0, 100);
        var groupCap = capNotice(shownGroup.length, group[1].length, '个词');
        if (groupCap) wrap.appendChild(groupCap);
        shownGroup.forEach(function (w) { wrap.appendChild(renderWordRow(w)); });
        screen.appendChild(wrap);
      });
      screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:14px' }, [
        el('button', { class: 'btn ghost', text: '导入 / 追加', onclick: function () { navigate('import'); } })
      ]));
      return;
    }

    var wordCap = capNotice(Math.min(list.length, 300), list.length, '个词');
    if (wordCap) screen.appendChild(wordCap);
    var wrap = el('div', { class: 'cardlist' });
    list.slice(0, 300).forEach(function (w) {
      wrap.appendChild(renderWordRow(w));
    });
    screen.appendChild(wrap);
    screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:14px' }, [
      el('button', { class: 'btn soft', text: '手动新增', onclick: openAddWord }),
      el('button', { class: 'btn ghost', text: '导入 / 追加', onclick: function () { navigate('import'); } })
    ]));
  }

  function renderWordRow(w) {
    var b = sm2.bucket(w.progress);
    var badge = { new: 'new', learning: 'rev', mastered: 'ok' }[b];
    var label = { new: '新', learning: '学习中', mastered: '已掌握' }[b];
    return el('div', { class: 'rowcard', onclick: function () {
      navigate('word', { wordKey: util.wordKey(w.en) });
    } }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'head' }, [
          el('span', { class: 'en', text: w.en }),
          w.phonetic ? el('span', { class: 'ph', text: '/' + w.phonetic + '/' }) : null,
          el('span', { class: 'badge ' + badge, text: label })
        ]),
        el('div', { class: 'zh', text: (w.pos ? w.pos + ' ' : '') + (w.zh || '（无释义）') }),
        w.collo && w.collo.length ? el('div', { class: 'collo', text: w.collo.join(' · ') }) : null,
        w.tags && w.tags.length ? el('div', { class: 'tags' }, w.tags.map(function (t) {
          return el('span', { class: 'badge ' + (t === '拼写易错' || t === '词义混淆' ? 'err' : 'gray'), text: t });
        })) : null
      ]),
      el('button', { class: 'speak', text: '🔊', onclick: function (e) {
        e.stopPropagation();
        speak(w.en);
      } })
    ]);
  }

  function screenWordDetail() {
    var book = store.loadBook();
    var w = book.words[state.screenData.wordKey];
    var screen = el('div', { class: 'screen narrow' });
    if (!w) {
      screen.appendChild(el('p', { class: 'muted', text: '词条不存在' }));
      return screen;
    }
    screen.appendChild(el('header', { class: 'topbar' }, [
      el('button', { class: 'btn ghost sm', text: '返回', onclick: function () { navigate(null); } }),
      el('div', { class: 'grow center', style: 'font-weight:650', text: w.en })
    ]));

    var fields = [
      ['phonetic', '音标', w.phonetic],
      ['pos', '词性', w.pos],
      ['zh', '释义', w.zh]
    ];
    var inputs = {};
    fields.forEach(function (f) {
      var inp = el('input', { class: 'input', value: f[2] || '' });
      inputs[f[0]] = inp;
      screen.appendChild(el('label', { class: 'field' }, [el('span', { text: f[1] }), inp]));
    });
    var colloInp = el('textarea', { class: 'input', style: 'min-height:90px', value: (w.collo || []).join('\n') });
    screen.appendChild(el('label', { class: 'field' }, [el('span', { text: '搭配（每行一条）' }), colloInp]));
    var tagsInp = el('input', { class: 'input', value: (w.tags || []).join(' · ') });
    screen.appendChild(el('label', { class: 'field' }, [el('span', { text: '标签（用 · 或 , 分隔）' }), tagsInp]));

    var info = el('div', { class: 'card pad small' }, [
      el('div', { class: 'kv' }, [
        el('span', { class: 'k', text: '状态' }),
        el('span', { class: 'v', text: { new: '新词', learning: '学习中', mastered: '已掌握' }[sm2.bucket(w.progress)] }),
        el('span', { class: 'k', text: '间隔' }),
        el('span', { class: 'v', text: util.formatInterval(w.progress, Date.now()) }),
        el('span', { class: 'k', text: '复习次数 / 失误' }),
        el('span', { class: 'v', text: (w.progress.reps || 0) + ' / ' + (w.progress.lapses || 0) }),
        el('span', { class: 'k', text: '导入批次' }),
        el('span', { class: 'v', text: (w.srcs || [w.src]).filter(Boolean).join(', ') })
      ])
    ]);
    screen.appendChild(info);

    screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:14px' }, [
      el('button', { class: 'btn', text: '保存修改', onclick: function () {
        var tags = tagsInp.value.split(/[·,，;；\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
        var collo = colloInp.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        var r = store.updateWord(w.en, {
          phonetic: inputs.phonetic.value.trim(),
          pos: inputs.pos.value.trim(),
          zh: inputs.zh.value.trim(),
          collo: collo,
          tags: tags
        }, Date.now());
        if (!r.ok) { showError(r.error || '保存失败'); return; }
        toast('已保存');
        navigate(null);
      } }),
      el('button', { class: 'btn ghost', text: '🔊 发音', onclick: function () { speak(w.en); } })
    ]));
    screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
      el('button', { class: 'btn danger', text: '删除词条', onclick: function () {
        openSheet('删除「' + w.en + '」？', el('p', { class: 'small', text: '会同时删除它的学习进度，可在数据面板的「最近删除」恢复（保留最近 50 条）。' }), [
          el('button', { class: 'btn ghost', text: '取消', onclick: closeSheet }),
          el('button', { class: 'btn danger', text: '删除', onclick: function () {
            store.deleteWord(w.en, Date.now());
            closeSheet();
            toast('已删除');
            navigate(null);
          } })
        ]);
      } })
    ]));
    return screen;
  }

  function openAddWord() {
    var en = el('input', { class: 'input', placeholder: 'abandon（不含空格）' });
    var ph = el('input', { class: 'input', placeholder: 'əˈbændən（可空）' });
    var pos = el('input', { class: 'input', placeholder: 'v.（可空）' });
    var zh = el('input', { class: 'input', placeholder: '放弃；抛弃' });
    var collo = el('textarea', { class: 'input', style: 'min-height:70px', placeholder: 'abandon hope 放弃希望' });
    openSheet('手动新增词条', el('div', {}, [
      el('label', { class: 'field' }, [el('span', { text: '单词' }), en]),
      el('label', { class: 'field' }, [el('span', { text: '音标' }), ph]),
      el('label', { class: 'field' }, [el('span', { text: '词性' }), pos]),
      el('label', { class: 'field' }, [el('span', { text: '释义' }), zh]),
      el('label', { class: 'field' }, [el('span', { text: '搭配（每行一条）' }), collo])
    ]), [
      el('button', { class: 'btn ghost', text: '取消', onclick: closeSheet }),
      el('button', { class: 'btn', text: '添加', onclick: function () {
        var r = store.addWordManual({
          en: en.value.trim(), phonetic: ph.value.trim(), pos: pos.value.trim(), zh: zh.value.trim(),
          collo: collo.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean)
        }, Date.now());
        if (!r.ok) { showError(r.error || '添加失败'); return; }
        closeSheet();
        toast('已添加');
        render();
      } })
    ]);
  }

  /* ------------------------------------------------------------------- data */

  function renderData(screen) {
    var book = store.loadBook();
    var stats = store.loadStats();
    var now = Date.now();
    var words = Object.keys(book.words || {});
    var streaks = statsMod.streaks(stats, now);
    var days = statsMod.lastDays(stats, 14, now);
    var mastered = 0, learning = 0, fresh = 0, wrong = 0;
    words.forEach(function (k) {
      var p = book.words[k].progress;
      if (sm2.isMastered(p)) mastered++;
      else if (sm2.isLearning(p)) learning++;
      else fresh++;
      if ((book.words[k].tags || []).length) wrong++;
    });

    screen.appendChild(topbar('数据', '连续打卡 ' + streaks.current + ' 天'));
    screen.appendChild(el('div', { class: 'stat-grid' }, [
      stat('连续打卡', streaks.current, '天'),
      stat('最长连续', streaks.longest, '天'),
      stat('累计学习', streaks.totalDays, '天')
    ]));

    var chart = el('div', { class: 'card pad', style: 'margin-top:12px' });
    chart.appendChild(el('div', { class: 'split' }, [
      el('div', { class: 'grow', style: 'font-weight:650', text: '近 14 天做题量' }),
      el('div', { class: 'tiny muted', text: '正确率 <60% 标红' })
    ]));
    var maxAns = Math.max.apply(null, days.map(function (d) { return d.answered; }).concat([1]));
    var chartEl = el('div', { class: 'chart' });
    days.forEach(function (d) {
      var h = Math.max(2, Math.round((d.answered / maxAns) * 88));
      chartEl.appendChild(el('div', { class: 'col' }, [
        el('div', { class: 'bar' + (d.answered === 0 ? ' none' : (d.low ? ' low' : '')), style: 'height:' + h + 'px' }),
        el('div', { class: 'cap', text: d.date.slice(8) })
      ]));
    });
    chart.appendChild(chartEl);
    screen.appendChild(chart);

    screen.appendChild(el('div', { class: 'card pad', style: 'margin-top:12px' }, [
      el('div', { style: 'font-weight:650', text: '分层进度' }),
      el('div', { class: 'kv', style: 'margin-top:8px' }, [
        el('span', { class: 'k', text: '新词' }), el('span', { class: 'v', text: String(fresh) }),
        el('span', { class: 'k', text: '学习中' }), el('span', { class: 'v', text: String(learning) }),
        el('span', { class: 'k', text: '已掌握' }), el('span', { class: 'v', text: String(mastered) }),
        el('span', { class: 'k', text: '错词' }), el('span', { class: 'v', text: wrong + ' / 30' })
      ])
    ]));

    screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:12px' }, [
      el('button', { class: 'btn soft', text: '🩺 数据自检', onclick: function () { navigate('selfcheck'); } }),
      el('button', { class: 'btn ghost', text: '备份与恢复', onclick: openBackups }),
      el('button', { class: 'btn ghost', text: '导出', onclick: openExport }),
      el('button', { class: 'btn ghost', text: '最近删除', onclick: openDeleted })
    ]));

    var imports = (book.imports || []).slice().reverse().slice(0, 8);
    var impBox = el('div', { class: 'card pad', style: 'margin-top:12px' }, [
      el('div', { style: 'font-weight:650', text: '导入历史' })
    ]);
    if (!imports.length) impBox.appendChild(el('div', { class: 'muted small', text: '还没有导入记录' }));
    imports.forEach(function (r) {
      impBox.appendChild(el('div', { class: 'checkline' }, [
        el('div', { class: 'body' }, [
          el('div', { class: 'small', text: r.id }),
          el('div', { class: 'tiny muted', text: (r.at || '').slice(0, 19).replace('T', ' ') + ' · ' + (r.mode || 'dict') + ' · 新增 ' + (r.added || 0) + ' 更新 ' + (r.updated || 0) + (r.trimmed ? ' 截断 ' + r.trimmed : '') + (r.errors ? ' 跳过 ' + r.errors : '') })
        ]),
        el('button', { class: 'chip', text: '筛选', onclick: function () {
          state.screenData.bookFilter = 'all';
          state.screenData.bookQuery = '';
          state.screenData.bookSrc = r.id;
          goTab('book');
        } })
      ]));
    });
    screen.appendChild(impBox);
    return screen;
  }

  function screenSelfCheck() {
    var c = store.selfCheck();
    var screen = el('div', { class: 'screen narrow' });
    screen.appendChild(el('header', { class: 'topbar' }, [
      el('button', { class: 'btn ghost sm', text: '返回', onclick: function () { navigate(null); } }),
      el('div', { class: 'grow center', style: 'font-weight:650', text: '数据自检' })
    ]));

    // Storage write probe: proves the bridge can actually persist before the
    // user trusts an import. This is the check that would have caught the
    // "Method not found" failure immediately.
    var probeBox = el('div', { class: 'card pad', style: 'margin-bottom:12px' },
      [el('div', { class: 'muted small', text: '存储读写探测…' })]);
    screen.appendChild(probeBox);
    store.adapter.selfTest ? (function () {
      var r = store.adapter.selfTest();
      // Writing is what decides whether an import survives; a failing list()
      // only affects backup enumeration and must not claim writes are broken.
      var writeOk = r.writeText && r.readText;
      var allOk = writeOk && r.delete && r.stat && r.list;
      probeBox.style.background = allOk ? 'var(--ok-soft)' : (writeOk ? 'var(--warn-soft)' : 'var(--danger-soft)');
      probeBox.style.borderColor = allOk ? 'var(--ok)' : (writeOk ? 'var(--warn)' : 'var(--danger)');
      clear(probeBox);
      probeBox.appendChild(el('div', {
        style: 'font-weight:650;color:' + (allOk ? 'var(--ok)' : (writeOk ? 'var(--warn)' : 'var(--danger)')),
        text: allOk ? '✅ 存储读写正常（写入能真正落盘）'
          : (writeOk ? '⚠️ 写入正常，但部分读取功能异常（导入仍可保存）' : '❌ 存储写入失败，导入不会保存')
      }));
      probeBox.appendChild(el('div', { class: 'tiny', style: 'margin-top:4px;color:var(--muted)',
        text: 'write ' + (r.writeText ? '✓' : '✗') + ' · read ' + (r.readText ? '✓' : '✗') +
              ' · delete ' + (r.delete ? '✓' : '✗') + ' · stat ' + (r.stat ? '✓' : '✗') +
              ' · list ' + (r.list ? '✓' : '✗') }));
      if (r.firstError) {
        probeBox.appendChild(el('div', { class: 'tiny', style: 'color:var(--danger);margin-top:4px', text: '错误：' + r.firstError }));
      }
    })() : probeBox.appendChild(el('div', { class: 'tiny muted', text: '当前为浏览器存储，无原生探测' }));

    var rows = [
      ['词条数', c.words],
      ['进度条数', c.progress],
      ['缺进度', c.missingProgress.length],
      ['错词数', c.wrong + ' / 30'],
      ['导入历史', c.imports],
      ['听写历史', c.sessions],
      ['学习天数', c.days],
      ['最近删除', c.deleted],
      ['备份', c.backups + ' 份 / ' + util.formatBytes(c.backupBytes)],
      ['词本大小', util.formatBytes(c.sizes['wordbook.json'] ? c.sizes['wordbook.json'].size : 0)],
      ['统计大小', util.formatBytes(c.sizes['stats.json'] ? c.sizes['stats.json'].size : 0)],
      ['可用空间', c.freeBytes > 0 ? util.formatBytes(c.freeBytes) : '未知'],
      ['内置音频', c.audioFiles + ' 个（按需 TTS）'],
      ['存储适配器', c.adapter]
    ];
    var kv = el('div', { class: 'card pad' }, [el('div', { class: 'kv' }, rows.map(function (r) {
      return [el('span', { class: 'k', text: r[0] }), el('span', { class: 'v', text: String(r[1]) })];
    }).reduce(function (a, b) { return a.concat(b); }, []))]);
    screen.appendChild(kv);
    if (!c.ok) {
      screen.appendChild(el('div', { class: 'card pad', style: 'margin-top:12px;background:var(--danger-soft)' }, [
        el('div', { class: 'small', style: 'color:var(--danger)', text: '发现 ' + c.missingProgress.length + ' 个词条缺进度：' + c.missingProgress.join('、') })
      ]));
    }
    var log = state.errorLog || [];
    if (log.length) {
      var logBox = el('details', { class: 'fold' }, [
        el('summary', { text: '最近错误 ' + log.length + ' 条（排查用，可复制）' }),
        el('pre', { class: 'pre', style: 'background:var(--bg);padding:10px;border-radius:8px;max-height:220px;overflow:auto;margin-top:8px', text: log.slice(-20).join('\n') })
      ]);
      screen.appendChild(logBox);
    }

    screen.appendChild(el('div', { class: 'btn-row', style: 'margin-top:12px' }, [
      el('button', { class: 'btn ghost', text: '重新检查', onclick: function () { render(); } }),
      log.length ? el('button', { class: 'btn ghost', text: '复制错误日志', onclick: function () { copy(log.join('\n')); } }) : null
    ]));
    return screen;
  }

  function openBackups() {
    var list = store.listBackups();
    var body = el('div', {});
    if (!list.length) body.appendChild(el('p', { class: 'muted small', text: '还没有备份。导入前会自动备份。' }));
    list.forEach(function (b) {
      body.appendChild(el('div', { class: 'checkline' }, [
        el('div', { class: 'body' }, [
          el('div', { class: 'small', text: b.name }),
          el('div', { class: 'tiny muted', text: util.formatBytes(b.size) })
        ]),
        el('button', { class: 'btn ghost sm', text: '恢复', onclick: function () {
          openSheet('恢复此备份？', el('p', { class: 'small', text: '当前词本会先自动快照，可从备份列表回退。\n\n' + b.name }), [
            el('button', { class: 'btn ghost', text: '取消', onclick: closeSheet }),
            el('button', { class: 'btn', text: '恢复', onclick: function () {
              var r = store.restoreBackup(b.name);
              closeSheet();
              if (!r.ok) { showError(r.error || '恢复失败'); return; }
              toast('已恢复');
              render();
            } })
          ]);
        } })
      ]));
    });
    openSheet('备份（保留 7 份 / 50MB）', body, [el('button', { class: 'btn ghost', text: '关闭', onclick: closeSheet })]);
  }

  function openExport() {
    openSheet('导出', el('div', {}, [
      el('p', { class: 'small muted', text: 'JSON 含进度与导入历史，用于迁移；CSV / 文本便于再喂给 AI。' }),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn ghost', text: 'JSON 备份', onclick: function () { doExport('json'); } }),
        el('button', { class: 'btn ghost', text: 'CSV', onclick: function () { doExport('csv'); } }),
        el('button', { class: 'btn ghost', text: '词典式文本', onclick: function () { doExport('txt'); } })
      ])
    ]), [el('button', { class: 'btn', text: '关闭', onclick: closeSheet })]);
  }

  function doExport(kind) {
    var r = store.exportAll(kind, Date.now());
    if (!r.ok) { showError('导出失败'); return; }
    var name = 'moci-' + util.localDateKey(Date.now()) + '.' + r.ext;
    if (native && bridge) {
      var rel = 'export/' + name;
      var w = store.adapter.write(rel, r.text);
      if (w && w.ok === false) { showError('写入导出文件失败'); return; }
      bridge.saveFile(rel, name, r.mime).then(function (res) {
        if (!res || !res.ok) { if (res && res.error !== 'cancelled') showError(res.error || '保存失败'); return; }
        closeSheet();
        toast('已保存');
      });
      return;
    }
    copy(r.text);
    closeSheet();
  }

  function openDeleted() {
    var d = store.loadDeleted();
    var body = el('div', {});
    if (!d.items.length) body.appendChild(el('p', { class: 'muted small', text: '没有最近删除的词。' }));
    d.items.slice().reverse().forEach(function (item) {
      var idx = d.items.indexOf(item);
      body.appendChild(el('div', { class: 'checkline' }, [
        el('div', { class: 'body' }, [
          el('div', { class: 'small', style: 'font-weight:600', text: item.word.en }),
          el('div', { class: 'tiny muted', text: (item.word.zh || '（无释义）') + ' · ' + (item.at || '').slice(0, 10) })
        ]),
        el('button', { class: 'btn ghost sm', text: '恢复', onclick: function () {
          var r = store.restoreDeleted(idx);
          if (!r.ok) { showError(r.error || '恢复失败'); return; }
          toast('已恢复');
          closeSheet();
          render();
        } })
      ]));
    });
    openSheet('最近删除（50 条）', body, [el('button', { class: 'btn ghost', text: '关闭', onclick: closeSheet })]);
  }

  /* --------------------------------------------------------------- settings */

  function renderSettings(screen) {
    screen.appendChild(topbar('设置', '数据只存本机'));
    var s = store.loadSettings();

    // AI
    // Saved values only. Unconfigured fields show a grey example instead of
    // pre-filling a real-looking URL/model, which made it impossible to tell
    // whether the app was already configured.
    var savedBase = getPref('baseUrl', '');
    var savedModel = getPref('model', '');
    var baseUrl = el('input', {
      class: 'input', value: savedBase,
      placeholder: 'https://your-gateway.example.com/v1'
    });
    var model = el('input', {
      class: 'input', value: savedModel,
      placeholder: 'deepseek-v41-flash 或 Qwen3.8-Flash-Next'
    });
    var apiKey = el('input', { class: 'input', type: 'password', value: getPref('apiKey', ''), placeholder: 'sk-... 只保存在本机' });
    var keyVisible = false;
    var eye = el('button', {
      class: 'btn ghost sm', type: 'button', text: '👁 显示', style: 'flex:0 0 auto',
      onclick: function () {
        keyVisible = !keyVisible;
        apiKey.type = keyVisible ? 'text' : 'password';
        eye.textContent = keyVisible ? '🙈 隐藏' : '👁 显示';
      }
    });
    var insecure = el('input', { type: 'checkbox', checked: getPrefBool('allowInsecureHttp', false) });
    var configured = !!(savedBase && savedModel && getPref('apiKey', ''));
    var aiCard = el('div', { class: 'card pad' }, [
      el('div', { style: 'font-weight:650', text: '拍照批改（唯一 AI 用途）' }),
      el('div', { class: 'tiny', style: 'color:' + (configured ? 'var(--ok)' : 'var(--muted)') + ';margin-top:2px', text: configured ? '✓ 已配置，可使用手写拍照批改' : '未配置。灰色文字是示例，不是你已有的设置' }),
      el('label', { class: 'field' }, [el('span', { text: '网关地址 BASE_URL' }), baseUrl]),
      el('label', { class: 'field' }, [el('span', { text: '模型' }), model]),
      el('label', { class: 'field' }, [el('span', { text: 'API Key' }), apiKey]),
      el('div', { class: 'row', style: 'margin-top:6px;gap:8px' }, [eye]),
      el('label', { class: 'checkline' }, [insecure, el('div', { class: 'body' }, [el('div', { class: 'small', text: '允许 HTTP（不安全）' })])]),
      el('div', { class: 'btn-row', style: 'margin-top:8px' }, [
        el('button', { class: 'btn soft sm', text: '保存', onclick: function () {
          setPref('baseUrl', baseUrl.value.trim());
          setPref('model', model.value.trim());
          setPref('apiKey', apiKey.value.trim());
          setPrefBool('allowInsecureHttp', insecure.checked);
          toast('已保存');
        } }),
        el('button', { class: 'btn ghost sm', text: '清除 Key', onclick: function () {
          setPref('apiKey', '');
          apiKey.value = '';
          toast('已清除');
        } }),
        el('button', { class: 'btn ghost sm', text: '测试连接', onclick: function () { testConnection(); } })
      ])
    ]);
    screen.appendChild(aiCard);

    var engines = [];
    var ttsStatus = null;
    if (native && bridge) {
      ttsStatus = nativeParse(root.MociNative.ttsStatus(), null);
      var eo = nativeParse(root.MociNative.ttsEngines(), null);
      engines = (eo && eo.items) || [];
    }
    var engineChips = el('div', { class: 'chips' });
    engineChips.appendChild(el('button', { class: 'chip' + (!getPref('ttsEngine', '') ? ' on' : ''), text: '系统默认', onclick: function () {
      setPref('ttsEngine', '');
      if (native) { try { root.MociNative.ttsSetEngine(''); } catch (e) { } }
      toast('已切换');
      render();
    } }));
    engines.forEach(function (e) {
      engineChips.appendChild(el('button', { class: 'chip' + (getPref('ttsEngine', '') === e.pkg ? ' on' : ''), text: e.label, onclick: function () {
        setPref('ttsEngine', e.pkg);
        if (native) { try { root.MociNative.ttsSetEngine(e.pkg); } catch (e) { } }
        toast('已切换');
        render();
      } }));
    });

    var rate = el('input', { class: 'input', type: 'range', min: '0.3', max: '1.6', step: '0.1', value: String(state.speechRate) });
    rate.addEventListener('change', function () {
      saveSettings({ speechRate: Number(rate.value) });
      toast('语速 ' + rate.value);
      render();
    });
    var accent = getPref('ttsAccent', 'us');
    var accentChips = el('div', { class: 'chips' }, [
      el('button', { class: 'chip' + (accent === 'us' ? ' on' : ''), text: '美音 en-US（默认）', onclick: function () {
        setPref('ttsAccent', 'us');
        state.speechAccent = 'us';
        if (native) { try { root.MociNative.ttsSetAccent('us'); } catch (e) { } }
        toast('已切换美音');
        render();
      } }),
      el('button', { class: 'chip' + (accent !== 'us' ? ' on' : ''), text: '英音 en-GB', onclick: function () {
        setPref('ttsAccent', 'uk');
        state.speechAccent = 'uk';
        if (native) { try { root.MociNative.ttsSetAccent('uk'); } catch (e) { } }
        toast('已切换英音');
        render();
      } })
    ]);
    var auto = el('input', { type: 'checkbox', checked: state.autoSpeak });
    auto.addEventListener('change', function () { saveSettings({ autoSpeak: auto.checked }); });
    var voiceSource = el('div', { class: 'chips' }, [
      el('button', { class: 'chip' + (state.voiceSource !== 'system' ? ' on' : ''), text: '真人发音（默认）', onclick: function () { saveSettings({ voiceSource: 'human' }); render(); } }),
      el('button', { class: 'chip' + (state.voiceSource === 'system' ? ' on' : ''), text: '系统 TTS', onclick: function () { saveSettings({ voiceSource: 'system' }); render(); } })
    ]);
    var voiceCard = el('div', { class: 'card pad' }, [
      el('div', { style: 'font-weight:650', text: '发音' }),
      ttsStatus ? el('div', {
        class: 'tiny',
        style: 'margin-top:4px;color:' + (!ttsStatus.ready ? 'var(--danger)' : (ttsStatus.english ? 'var(--ok)' : 'var(--warn)')),
        text: !ttsStatus.ready
          ? '语音引擎启动失败。点「试听」会重试一次；仍无声请点「打开系统 TTS 设置」安装英语语音数据'
          : (ttsStatus.english
            ? '英语语音已就绪（按「试听」确认真实出声）'
            : '引擎未明确报告英语支持，但通常仍可发音。点「试听」验证')
      }) : null,
      ttsStatus && !ttsStatus.ready && engines.length === 0 ? el('div', {
        class: 'tiny', style: 'margin-top:2px;color:var(--danger)',
        text: '未检测到任何 TTS 引擎。请先安装系统语音服务（如 Google 文字转语音 / 手机自带语音引擎）'
      }) : null,
      el('div', { class: 'small muted', style: 'margin-top:10px', text: '发音来源' }),
      voiceSource,
      el('div', { class: 'small muted', style: 'margin-top:6px', text: 'TTS 引擎' }),
      engineChips,
      el('div', { class: 'small muted', style: 'margin-top:6px', text: '口音（引擎支持时生效）' }),
      accentChips,
      el('div', { class: 'btn-row', style: 'margin-top:6px' }, [
        el('button', { class: 'btn ghost sm', text: '试听', onclick: function () { speak('abandon'); } }),
        el('button', { class: 'btn ghost sm', text: '发音诊断', onclick: function () { showTtsDiagnostics(); } }),
        el('button', { class: 'btn ghost sm', text: '打开系统 TTS 设置', onclick: function () {
          if (native) { try { root.MociNative.ttsOpenSettings(); } catch (e) { } }
          else toast('仅 App 内可用');
        } })
      ]),
      el('label', { class: 'field' }, [el('span', { text: '语速 ' + state.speechRate }), rate]),
      el('label', { class: 'checkline' }, [auto, el('div', { class: 'body' }, [el('div', { class: 'small', text: '学习卡翻面自动发音' })])]),
      el('div', { class: 'tiny muted', style: 'margin-top:8px', text:
        '真人发音：第一次听到某个词时用系统语音先出声，同时后台下载真人录音并缓存；' +
        '之后同一个词直接播放本地录音，断网也能听。' }),
      el('div', { class: 'tiny', style: 'color:var(--muted)', text:
        '真人发音会把单词文本发送到在线发音服务以取得音频；若希望完全不联网，请选「系统 TTS」。' }),
      audioStorageRow()
    ]);
    screen.appendChild(voiceCard);

    var theme = el('div', { class: 'chips' }, ['auto', 'light', 'dark'].map(function (t) {
      return el('button', { class: 'chip' + (s.theme === t ? ' on' : ''), text: { auto: '跟随系统', light: '浅色', dark: '深色' }[t], onclick: function () {
        saveSettings({ theme: t });
        render();
      } });
    }));

    var goalChips = el('div', { class: 'chips' }, [5, 15, 30].map(function (n) {
      return el('button', {
        class: 'chip' + ((Number(s.dailyGoal) || 15) === n ? ' on' : ''),
        text: n + ' 张',
        onclick: function () { saveSettings({ dailyGoal: n }); toast('每组 ' + n + ' 张'); render(); }
      });
    }));
    var newChips = el('div', { class: 'chips' }, [3, 5, 7, 10].map(function (n) {
      return el('button', {
        class: 'chip' + ((Number(s.newPerDay) || 7) === n ? ' on' : ''),
        text: n + ' 个',
        onclick: function () { saveSettings({ newPerDay: n }); toast('每日新词 ' + n + ' 个'); render(); }
      });
    }));

    screen.appendChild(el('div', { class: 'card pad' }, [
      el('div', { style: 'font-weight:650', text: '学习节奏' }),
      el('div', { class: 'small muted', style: 'margin-top:8px', text: '每组卡片数（含复习 + 新词）' }),
      goalChips,
      el('div', { class: 'small muted', style: 'margin-top:6px', text: '每日新词' }),
      newChips,
      el('div', { class: 'tiny muted', style: 'margin-top:6px', text: '留一些旧词给复习，新词太多会学不完。' })
    ]));

    screen.appendChild(el('div', { class: 'card pad', style: 'border-color:var(--warn);background:var(--warn-soft)' }, [
      el('div', { class: 'small', style: 'color:var(--warn);font-weight:650', text: '⚠️ 卸载前请先导出备份' }),
      el('div', { class: 'tiny', style: 'color:var(--warn);margin-top:4px', text: '词本和进度只存在本机 App 私有目录，卸载即全部删除。每天首次打开会自动生成一份 daily 备份，但备份也在同一目录。' }),
      el('div', { class: 'btn-row', style: 'margin-top:8px' }, [
        el('button', { class: 'btn soft sm', text: '导出 JSON 备份', onclick: function () { doExport('json'); } }),
        el('button', { class: 'btn ghost sm', text: '查看备份列表', onclick: openBackups })
      ])
    ]));

    screen.appendChild(el('div', { class: 'card pad' }, [
      el('div', { style: 'font-weight:650', text: '外观与危险操作' }),
      el('div', { style: 'margin-top:8px' }, [theme]),
      el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
        el('button', { class: 'btn ghost', text: '查看提示词模板', onclick: showTemplate }),
        el('button', { class: 'btn danger', text: '清空全部数据', onclick: confirmClear })
      ])
    ]));
    return screen;
  }

  function confirmClear() {
    openSheet('清空全部数据？', el('div', {}, [
      el('p', { class: 'small', text: '将清空词本、学习进度、统计和最近删除，设置项保留。清空前会自动备份一份，可在备份列表恢复。' })
    ]), [
      el('button', { class: 'btn ghost', text: '取消', onclick: closeSheet }),
      el('button', { class: 'btn danger', text: '确认清空', onclick: function () {
        var r = store.clearAll();
        if (!r.ok) { showError(r.error || '清空失败'); return; }
        closeSheet();
        toast('已清空，备份：' + (r.backup || '已生成'));
        goTab('home');
      } })
    ]);
  }

  /**
   * Reports what the engine actually says, instead of leaving the user to guess
   * why nothing is audible. Attempts a real utterance so a stale status code
   * cannot masquerade as a working setup.
   */
  function showTtsDiagnostics() {
    if (!native || !bridge) { toast('浏览器调试请用系统语音'); return; }
    var st = {};
    var engines = [];
    var speakResult = null;
    try { st = nativeParse(root.MociNative.ttsStatus(), {}) || {}; } catch (e) { st = { error: String(e.message || e) }; }
    try {
      var eo = nativeParse(root.MociNative.ttsEngines(), null);
      engines = (eo && eo.items) || [];
    } catch (e) { }
    try { speakResult = nativeParse(bridge.ttsSpeak('test', state.speechRate), null); } catch (e2) {
      speakResult = { ok: false, error: String(e2.message || e2) };
    }

    var langName = { '-1': 'LANG_MISSING_DATA（缺少语音数据）', '-2': 'LANG_NOT_SUPPORTED（不支持该语言）' };
    var rows = [
      ['引擎已初始化', st.ready ? '是' : '否'],
      ['语言状态', langName[String(st.langStatus)] || ('正常 (' + st.langStatus + ')')],
      ['当前引擎', st.engine ? st.engine : '系统默认'],
      ['系统默认引擎', st.defaultEngine || '未知'],
      ['可用引擎数', engines.length + ' 个'],
      ['当前音色', st.voice ? st.voice : '引擎默认'],
      ['英语音色数', (st.voiceCount || 0) + ' 个'],
      ['最近错误', st.error || '无'],
      ['试朗读', (speakResult && speakResult.ok)
        ? (speakResult.spoken === false ? '调用了但未发声' : '已提交')
        : ('失败：' + ((speakResult && speakResult.error) || '未知'))],
      ['Android 版本', 'API ' + (st.sdk || '?')]
    ];

    var body = el('div', {});
    rows.forEach(function (r) {
      body.appendChild(el('div', { class: 'checkline' }, [
        el('div', { class: 'grow small muted', text: r[0] }),
        el('div', { class: 'small', style: 'text-align:right;max-width:60%;word-break:break-all', text: String(r[1]) })
      ]));
    });
    if (!engines.length) {
      body.appendChild(el('div', { class: 'tiny', style: 'color:var(--danger);margin-top:8px', text:
        '未检测到任何 TTS 引擎。请到系统设置 → 无障碍/文字转语音 安装一个语音引擎（如 Google 文字转语音）。' }));
    } else if (!st.ready) {
      body.appendChild(el('div', { class: 'tiny', style: 'color:var(--danger);margin-top:8px', text:
        '引擎存在但初始化失败。常见原因：语音数据未下载、引擎被系统休眠、或该引擎不支持英语。' }));
    }
    openSheet('发音诊断', body, [
      el('button', { class: 'btn ghost', text: '关闭', onclick: closeSheet }),
      el('button', { class: 'btn', text: '复制结果', onclick: function () {
        copy(rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n'));
        toast('已复制');
      } })
    ]);
  }

  /**
   * Read-only reachability probe used to locate a 403.
   * Calls back with true (reachable), false (blocked) or null (inconclusive).
   */
  function probeGatewayModels(base, cb) {
    if (!native || !bridge || !bridge.httpGetJson) { cb(null); return; }
    var done = false;
    var finish = function (v) { if (!done) { done = true; cb(v); } };
    try {
      bridge.httpGetJson(base + '/models').then(function (r) {
        if (!r) { finish(null); return; }
        if (r.ok) { finish(true); return; }
        // Same empty 403 as the POST ⇒ the block is in front of the gateway.
        finish(r.status === 403 && !r.body);
      });
    } catch (e) { finish(null); }
    setTimeout(function () { finish(null); }, 12000);
  }

  function testConnection() {
    if (!native || !bridge) { toast('浏览器调试请直接在终端测试'); return; }
    var key = getPref('apiKey', '');
    if (!key) { toast('先保存 API Key'); return; }
    var base = getPref('baseUrl', 'https://llm.ujn.edu.cn/v1').replace(/\/+$/, '');
    var model = getPref('model', 'deepseek-v41-flash');
    toast('正在测试…');
    // Reasoning models spend tokens thinking BEFORE emitting any content. A tiny
    // budget (8) is exhausted by the reasoning pass, which the gateway reports as
    // "思考过程耗尽了全部输出预算" — or, on some models, hangs until the timeout.
    // Give the probe enough room to finish thinking and answer.
    bridge.httpPost(base + '/chat/completions', JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: '回复 OK' }],
      max_tokens: 2048,
      temperature: 0
    })).then(function (r) {
      if (r && r.ok) { toast('连接成功'); return; }
      var status = r && r.status;
      var msg = (r && r.error) || ('HTTP ' + status);
      var detail = '';
      try {
        var body = JSON.parse(r.body || '{}');
        if (body.error && body.error.message) detail = body.error.message;
        else if (body.detail) detail = String(body.detail);
        else if (body.message) detail = String(body.message);
      } catch (e) { }
      if (detail) msg = detail;

      // 401/403 from the gateway itself always carries a JSON explanation
      // ("API Token 无效或已吊销"). An empty 403 body therefore did NOT come from
      // the gateway — it was produced by something in between (campus network,
      // carrier, or a WAF), which no client-side setting can fix. Say so instead
      // of showing a bare "HTTP 403" that looks like a key problem.
      if (status === 403 && !detail) {
        // Prove where the block comes from instead of guessing. /models is a
        // trivial read-only endpoint: if IT is also refused, the block sits in
        // front of the gateway (campus network / carrier / WAF) and no app
        // setting can fix it. If it succeeds, the path is fine and the problem
        // is specific to the request.
        var who = [];
        if (r && r.server) who.push('Server: ' + r.server);
        probeGatewayModels(base, function (ok) {
          if (ok === false) {
            showError('网关拒绝访问（HTTP 403，响应体为空）。' +
              '自检结果：连只读的 /models 也被拒绝，说明请求在到达网关前就被挡下了，' +
              '与 API Key、模型名无关。' +
              '校内 API 通常只允许校园网访问：请连接校园 WiFi 或学校 VPN 后再试' +
              '（手机流量的公网 IP 不在校内白名单里）。' +
              (who.length ? '［' + who.join('，') + '］' : ''));
          } else if (ok === true) {
            showError('网关可达，但该请求被拒（HTTP 403）。' +
              '自检结果：/models 正常，说明不是网络问题，可能是模型名或权限受限。' +
              '请到 /models 确认可用模型后再试。模型：' + model);
          } else {
            showError('请求被拒绝（HTTP 403，响应体为空）。' +
              '可能是网络层拦截或网关权限限制，请换网络重试。' +
              (who.length ? '［' + who.join('，') + '］' : ''));
          }
        });
        return;
      }
      if (status === 401) {
        showError('API Key 无效或已过期（HTTP 401）：' + (detail || '请到设置页检查 Key'));
        return;
      }
      // 404/400 usually means the model id does not exist on this gateway.
      showError('测试失败：' + msg + '（模型：' + model + '，HTTP ' + (status || '?') + '）');
    });
  }

  /**
   * Preference accessors.
   *
   * Every MociNative method returns a JSON *string* such as
   * {"ok":true,"value":"sk-..."}. Reading it directly made getPref() return the
   * whole envelope and getPrefBool() return `true` for every key, because a
   * non-empty string is always truthy. Both are parsed here.
   */
  function getPref(k, def) {
    if (native) {
      try {
        var r = nativeParse(root.MociNative.prefGet(k), null);
        if (r && r.ok && typeof r.value === 'string' && r.value !== '') return r.value;
      } catch (e) { }
    }
    return def;
  }
  function setPref(k, v) {
    if (!native) return;
    try { root.MociNative.prefSet(k, v); } catch (e) { showError('保存设置失败：' + (e.message || e)); }
  }
  function getPrefBool(k, def) {
    if (native) {
      try {
        var r = nativeParse(root.MociNative.prefGetBool(k, !!def), null);
        if (r && r.ok) return !!r.value;
      } catch (e) { }
    }
    return def;
  }
  function setPrefBool(k, v) {
    if (!native) return;
    try { root.MociNative.prefSetBool(k, !!v); } catch (e) { showError('保存设置失败：' + (e.message || e)); }
  }

  /* ------------------------------------------------------------------- boot */

  function boot() {
    var shell = $('#app');
    if (!shell) {
      shell = el('div', { class: 'app', id: 'app' });
      document.body.appendChild(shell);
    }
    shell.className = 'app';
    document.body.appendChild(el('div', { class: 'toast', id: 'toast' }));
    var bar = el('div', { class: 'errbar', id: 'errbar' }, [
      el('div', { class: 'msg' }),
      el('div', { class: 'acts' }, [
        el('button', { class: 'plain', text: '忽略', onclick: dismissError }),
        el('button', { text: '复制', onclick: function () { copy(state.lastError || ''); } })
      ])
    ]);
    document.body.appendChild(bar);

    root.onerror = function (msg, src, line, col, err) {
      showError('脚本错误：' + msg + ' (' + (src || '') + ':' + line + ':' + col + ')');
      return false;
    };
    root.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      showError('未处理异常：' + (r && r.message ? r.message : String(r)));
    });

    loadSettings();
    render();

    // One snapshot per day, independent of imports: an accidental uninstall
    // wipes private storage, so a fresh daily copy must already exist.
    try { store.dailyBackup(Date.now()); } catch (e) { /* backup is best-effort */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  root.MociApp = {
    store: store,
    state: state,
    navigate: navigate,
    render: render,
    speak: speak,
    copy: copy,
    // Rendering helpers are exposed so DOM-level tests can assert what the user
    // actually sees (the POS layout regression was invisible to string tests).
    appendMeaningBlock: appendMeaningBlock
  };
})(typeof self !== 'undefined' ? self : this);
