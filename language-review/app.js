'use strict';
/*
 * 語学の見直しアプリ v3
 *
 * 本筋は「自動クイズ＋自動採点」。エピソードの行から問題を自動で作る：
 *   意味当て（外国語の文→日本語の意味を4択）／逆向き（日本語→外国語の文を4択）／
 *   穴埋め（文の内容語を隠して4択）／並べ替え（短い文をタップで並べる）／
 *   聞き取り（音声を聞いて文を4択）。
 * 答えるとその場で正解・不正解が出て、採点結果がそのまま復習の記録になる。
 * 「できた／まだ」の自己申告ボタンは、本棚などに補助として残してある。
 *
 * 復習の背骨は「ユーザーのリズム」（v2から不変）：
 *   - おさらい = 配信の3日後
 *   - テスト   = 翌週の同じ曜日（配信の7日後）
 *   - 間違えた行だけ、翌日と3日後に「弱い行の早出し」として理由つきで先に出す。
 *   - 隠れた計算や罰（ハート等）は無い。
 *
 * 読み上げ：第1段として端末の音声合成（speechSynthesis）を言語タグ付きで使う。
 * 本命は録音クリップ方式（スーパーのゲームと同じ）で、行ごとの音声ファイルが
 * 用意できたら line.audio を優先して再生するよう作ってある。
 *
 * 日付はすべて Asia/Tokyo の実日付で計算する（todayStr が唯一の入口）。
 * 動作確認のために日付をずらして見たい場合は、todayStr の戻り値を
 * 固定の 'YYYY-MM-DD' に変えるだけでよい（UI には出さない）。
 */

var EPISODES = (window.LR_DATA && window.LR_DATA.episodes) || [];
var EP_BY_ID = {};
EPISODES.forEach(function (e) { EP_BY_ID[e.id] = e; });

var LS_KEY = 'lr_state_v1';
var QUEUE_CAP = 20;
var QUIZ_LEN = 10;

var LANG_TAGS = {
  fi: 'fi-FI', el: 'el-GR', sv: 'sv-SE', en: 'en-US',
  ko: 'ko-KR', fr: 'fr-FR', ja: 'ja-JP', ar: 'ar-EG'
};

/* ---------- 日付（Asia/Tokyo） ---------- */
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
function addDays(ds, n) {
  var d = new Date(ds + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diffDays(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}
function fmtMD(ds) {
  var p = ds.split('-');
  return Number(p[1]) + '/' + Number(p[2]);
}
var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
function fmtFull(ds) {
  var d = new Date(ds + 'T00:00:00Z');
  return fmtMD(ds) + '（' + WEEKDAYS[d.getUTCDay()] + '）';
}

/* ---------- 記録（localStorage） ---------- */
function loadState() {
  try {
    var s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && s.eps && s.lines) return s;
  } catch (e) { /* 壊れていたら初期化する */ }
  return { eps: {}, lines: {} };
}
var state = loadState();
function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* 保存できなくても画面は続く */ }
}
function epState(id) {
  if (!state.eps[id]) state.eps[id] = {};
  return state.eps[id];
}
function lineKey(epId, idx) { return epId + '#' + idx; }
function lineState(key) {
  if (!state.lines[key]) {
    state.lines[key] = { status: 'new', lastResult: null, lastDate: null, everMada: false, weak: [] };
  }
  return state.lines[key];
}
function peekLine(key) {
  return state.lines[key] || { status: 'new', lastResult: null, lastDate: null, everMada: false, weak: [] };
}

/* ---------- 期日の計算 ---------- */
function recapDue(ep) { return addDays(ep.delivered, 3); }
function testDue(ep) { return addDays(ep.delivered, 7); } // 翌週の同じ曜日

function buildQueue(today) {
  var weakItems = [];
  var mainItems = [];
  Object.keys(state.lines).forEach(function (key) {
    var ls = state.lines[key];
    (ls.weak || []).forEach(function (w) {
      if (w.done || w.d > today) return;
      var parts = key.split('#');
      var ep = EP_BY_ID[parts[0]];
      if (!ep) return;
      weakItems.push({
        kind: 'weak', epId: ep.id, lineIdx: Number(parts[1]), weakDate: w.d, due: w.d,
        reason: '弱い行の早出し'
      });
    });
  });
  weakItems.sort(function (a, b) { return a.due < b.due ? -1 : 1; });

  EPISODES.forEach(function (ep) {
    var es = state.eps[ep.id] || {};
    var rD = recapDue(ep);
    var tD = testDue(ep);
    if (!es.recap && rD <= today) {
      mainItems.push({ kind: 'recap', epId: ep.id, due: rD, reason: fmtMD(ep.delivered) + '分・3日後のおさらい' });
    } else if (es.recap && !es.test && tD <= today) {
      mainItems.push({ kind: 'test', epId: ep.id, due: tD, reason: fmtMD(ep.delivered) + '分・テスト' });
    } else if (es.recap && !es.test && !es.prep && tD > today && diffDays(today, tD) <= 3) {
      mainItems.push({ kind: 'prep', epId: ep.id, due: tD, reason: fmtMD(tD) + 'のテストの予習' });
    }
  });
  mainItems.sort(function (a, b) { return a.due < b.due ? -1 : 1; });
  return weakItems.concat(mainItems);
}

function nextDueLabel(today) {
  var best = null;
  EPISODES.forEach(function (ep) {
    var es = state.eps[ep.id] || {};
    var cands = [];
    if (!es.recap) cands.push({ d: recapDue(ep), what: 'おさらい' });
    else if (!es.test) cands.push({ d: testDue(ep), what: 'テスト' });
    cands.forEach(function (c) {
      if (c.d > today && (!best || c.d < best.d)) best = { d: c.d, what: c.what, ep: ep };
    });
  });
  Object.keys(state.lines).forEach(function (key) {
    (state.lines[key].weak || []).forEach(function (w) {
      if (!w.done && w.d > today && (!best || w.d < best.d)) {
        var ep = EP_BY_ID[key.split('#')[0]];
        if (ep) best = { d: w.d, what: '弱い行の早出し', ep: ep };
      }
    });
  });
  if (!best) return '';
  return '次は ' + fmtFull(best.d) + '：' + best.ep.langName + '「' + best.ep.title + '」の' + best.what + 'です。';
}

/* ---------- 記録する操作 ---------- */
function applyEpisodeMark(kind, epId, result) {
  var es = epState(epId);
  es[kind] = { result: result, date: todayStr() };
  saveState();
}
function markEpisode(kind, epId, result) {
  applyEpisodeMark(kind, epId, result);
  renderAll();
}

function applyLineMark(epId, idx, result, weakDate) {
  var key = lineKey(epId, idx);
  var ls = lineState(key);
  var t = todayStr();
  ls.status = result;
  ls.lastResult = result;
  ls.lastDate = t;
  if (!ls.weak) ls.weak = [];
  if (weakDate) {
    ls.weak.forEach(function (w) { if (w.d === weakDate) w.done = true; });
  }
  if (result === 'ok') {
    // 言えた行は通常のリズムに戻る：残っている早出し予定は全部終える
    ls.weak.forEach(function (w) { w.done = true; });
  }
  if (result === 'mada') {
    ls.everMada = true;
    [1, 3].forEach(function (n) {
      var d = addDays(t, n);
      var exists = ls.weak.some(function (w) { return w.d === d && !w.done; });
      if (!exists) ls.weak.push({ d: d, done: false });
    });
  }
  saveState();
}
function markLine(epId, idx, result, weakDate) {
  applyLineMark(epId, idx, result, weakDate);
  renderAll();
}

/* ---------- 読み上げ ---------- */
/* 第1段：端末の音声合成。本命の録音クリップ（line.audio）があればそちらを優先する。 */
function speakLine(ep, idx) {
  var ln = ep.lines[idx];
  if (!ln) return;
  if (ln.audio) {
    try { new Audio(ln.audio).play(); } catch (e) { /* 再生できなくても続く */ }
    return;
  }
  speakText(ln.text, ep.lang);
}
function speakText(text, lang) {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = LANG_TAGS[lang] || lang || 'en-US';
    speechSynthesis.speak(u);
  } catch (e) { /* 音声が無くても画面は続く */ }
}
function stopSpeak() {
  try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (e) { /* 何もしない */ }
}

/* ---------- クイズ生成 ---------- */
function shuffle(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
/* 文を単語に割る（並べ替え用：空白区切り） */
function splitTokens(text) {
  return String(text).trim().split(/\s+/).filter(function (w) { return w.length > 0; });
}
/* 穴埋めの候補語を割る（空白＋句読点区切り、記号を落とす） */
function cleanWord(w) {
  return String(w).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}
function contentWords(text) {
  var seen = {};
  var out = [];
  String(text).split(/[\s、。,．・；;:：!！?？«»"“”„'‘’()（）]+/).forEach(function (w) {
    var c = cleanWord(w);
    if (c.length >= 2 && !seen[c.toLowerCase()]) { seen[c.toLowerCase()] = 1; out.push(c); }
  });
  return out;
}
/* 選択肢の材料：同じエピソード優先、足りなければ同じ言語の他エピソード */
function linePool(ep) {
  var pool = [];
  ep.lines.forEach(function (ln, i) { pool.push({ ep: ep, idx: i, ln: ln }); });
  EPISODES.forEach(function (e2) {
    if (e2.id === ep.id || e2.lang !== ep.lang) return;
    e2.lines.forEach(function (ln, i) { pool.push({ ep: e2, idx: i, ln: ln }); });
  });
  return pool;
}
function pickOptions(correctVal, candidates, keyFn) {
  var used = {};
  used[keyFn(correctVal)] = 1;
  var ds = [];
  shuffle(candidates).forEach(function (c) {
    if (ds.length >= 3) return;
    var k = keyFn(c);
    if (used[k]) return;
    used[k] = 1;
    ds.push(c);
  });
  if (ds.length < 3) return null;
  var opts = shuffle([correctVal].concat(ds));
  return { options: opts, correct: opts.indexOf(correctVal) };
}

var QUIZ_FORMATS = ['meaning', 'reverse', 'fill', 'order', 'listening'];
function makeQuestion(ep, idx, format) {
  var ln = ep.lines[idx];
  var pool = linePool(ep);
  var q = null;
  if (format === 'meaning') {
    if (!ln.ja) return null;
    var vals = [];
    pool.forEach(function (p) { if (p.ln.ja) vals.push(p.ln.ja); });
    q = pickOptions(ln.ja, vals, function (s) { return s; });
    if (!q) return null;
    return { type: 'meaning', epId: ep.id, lineIdx: idx, text: ln.text, options: q.options, correct: q.correct };
  }
  if (format === 'reverse' || format === 'listening') {
    var texts = [];
    pool.forEach(function (p) { texts.push(p.ln.text); });
    q = pickOptions(ln.text, texts, function (s) { return s; });
    if (!q) return null;
    return { type: format, epId: ep.id, lineIdx: idx, ja: ln.ja || '', text: ln.text, options: q.options, correct: q.correct };
  }
  if (format === 'fill') {
    var words = contentWords(ln.text);
    if (!words.length) return null;
    var word = words[Math.floor(Math.random() * words.length)];
    var wpool = [];
    pool.forEach(function (p) { contentWords(p.ln.text).forEach(function (w) { wpool.push(w); }); });
    q = pickOptions(word, wpool, function (s) { return s.toLowerCase(); });
    if (!q) return null;
    var sentence = ln.text.replace(word, '＿＿＿');
    if (sentence === ln.text) return null;
    return { type: 'fill', epId: ep.id, lineIdx: idx, sentence: sentence, word: word, ja: ln.ja || '', options: q.options, correct: q.correct };
  }
  if (format === 'order') {
    var toks = splitTokens(ln.text);
    if (toks.length < 2 || toks.length > 6) return null;
    if (toks.every(function (t) { return t === toks[0]; })) return null;
    return { type: 'order', epId: ep.id, lineIdx: idx, ja: ln.ja || '', tokens: toks };
  }
  return null;
}

/* エピソードから1セッション分（目安10問）を作る */
function genEpisodeQuiz(ep, targetLen) {
  targetLen = targetLen || QUIZ_LEN;
  var cand = [];
  ep.lines.forEach(function (ln, idx) {
    QUIZ_FORMATS.forEach(function (f) {
      var q = makeQuestion(ep, idx, f);
      if (q) cand.push(q);
    });
  });
  cand = shuffle(cand);
  var picked = [];
  var perFormat = {};
  var perLine = {};
  cand.forEach(function (q) {
    if (picked.length >= targetLen) return;
    if ((perFormat[q.type] || 0) >= 3) return;
    if ((perLine[q.lineIdx] || 0) >= 2) return;
    perFormat[q.type] = (perFormat[q.type] || 0) + 1;
    perLine[q.lineIdx] = (perLine[q.lineIdx] || 0) + 1;
    picked.push(q);
  });
  if (picked.length < targetLen) {
    cand.forEach(function (q) {
      if (picked.length >= targetLen) return;
      if (picked.indexOf(q) >= 0) return;
      if ((perLine[q.lineIdx] || 0) >= 3) return;
      perLine[q.lineIdx] = (perLine[q.lineIdx] || 0) + 1;
      picked.push(q);
    });
  }
  return picked;
}
/* 指定した行だけの短いクイズ（弱い行用）。keys = ['epId#idx', ...] */
function genLineQuiz(keys, targetLen) {
  targetLen = targetLen || 5;
  var cand = [];
  keys.forEach(function (key) {
    var parts = key.split('#');
    var ep = EP_BY_ID[parts[0]];
    if (!ep) return;
    var idx = Number(parts[1]);
    QUIZ_FORMATS.forEach(function (f) {
      var q = makeQuestion(ep, idx, f);
      if (q) cand.push(q);
    });
  });
  cand = shuffle(cand);
  var perFormat = {};
  var picked = [];
  cand.forEach(function (q) {
    if (picked.length >= targetLen) return;
    if ((perFormat[q.type] || 0) >= 2) return;
    perFormat[q.type] = (perFormat[q.type] || 0) + 1;
    picked.push(q);
  });
  if (picked.length < targetLen) {
    cand.forEach(function (q) {
      if (picked.length >= targetLen) return;
      if (picked.indexOf(q) >= 0) return;
      picked.push(q);
    });
  }
  return picked;
}

/* ---------- 表示の部品 ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function statusBadge(ls) {
  if (ls.status === 'ok') return '<span class="badge ok">できた</span>';
  if (ls.status === 'mada') return '<span class="badge mada">まだ</span>';
  return '<span class="badge">未記録</span>';
}
function markButtons(act, attrs) {
  return '<div class="mark-btns">' +
    '<button type="button" class="ok" data-act="' + act + '" ' + attrs + ' data-result="ok">できた</button>' +
    '<button type="button" class="mada" data-act="' + act + '" ' + attrs + ' data-result="mada">まだ</button>' +
    '</div>';
}
function speakBtn(epId, idx) {
  return '<button type="button" class="speak-btn" data-act="speak" data-ep="' + esc(epId) +
    '" data-idx="' + idx + '" aria-label="読み上げ">🔊</button>';
}
function lineTextHtml(ep, idx) {
  var ln = ep.lines[idx];
  var h = '';
  if (ln.sp) h += '<span class="sp">' + esc(ln.sp) + '：</span> ';
  h += '<span class="tx" dir="auto">' + esc(ln.text) + '</span> ' + speakBtn(ep.id, idx);
  if (ln.ja) h += '<div class="ja">' + esc(ln.ja) + '</div>';
  return h;
}

/* ---------- 1. 今日の復習キュー ---------- */
function renderQueue() {
  var today = todayStr();
  var items = buildQueue(today);
  var box = document.getElementById('queue-list');
  if (items.length === 0) {
    var nx = nextDueLabel(today);
    box.innerHTML = '<div class="empty">今日の分は終わりです。お疲れさま。<br>' + esc(nx) + '</div>';
    return;
  }
  var shown = items.slice(0, QUEUE_CAP);
  var html = '';
  shown.forEach(function (it) {
    var ep = EP_BY_ID[it.epId];
    if (it.kind === 'weak') {
      html += '<div class="qitem">' +
        '<span class="reason weak">' + esc(it.reason) + '（' + fmtFull(it.weakDate) + 'の分）</span>' +
        '<div class="q-title">' + esc(ep.langName) + '「' + esc(ep.title) + '」</div>' +
        '<div class="q-text">' + lineTextHtml(ep, it.lineIdx) + '</div>' +
        '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-weak" data-ep="' +
          esc(it.epId) + '" data-idx="' + it.lineIdx + '">クイズで復習</button></div>' +
        '<div class="q-meta">自分で言えたかチェックしたい時は、こちらでも記録できます。</div>' +
        markButtons('line-mark', 'data-ep="' + esc(it.epId) + '" data-idx="' + it.lineIdx + '" data-weak="' + esc(it.weakDate) + '"') +
        '</div>';
    } else {
      var dueText = it.kind === 'prep'
        ? 'テストは ' + fmtFull(it.due)
        : '期日：' + fmtFull(it.due) + (it.due < today ? '（過ぎています）' : '');
      html += '<div class="qitem">' +
        '<span class="reason">' + esc(it.reason) + '</span>' +
        '<div class="q-title">' + esc(ep.langName) + '「' + esc(ep.title) + '」</div>' +
        '<div class="q-meta">場面：' + esc(ep.scene) + '／全' + ep.lines.length + '行／' + dueText + '</div>' +
        '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-ep" data-ep="' +
          esc(it.epId) + '" data-kind="' + it.kind + '">クイズで復習</button></div>' +
        '<div class="q-meta">クイズを最後まで解くと、この' + (it.kind === 'test' ? 'テスト' : 'おさらい') +
          'は完了として記録されます。自己申告で記録する場合はこちら。</div>' +
        markButtons('ep-mark', 'data-kind="' + it.kind + '" data-ep="' + esc(it.epId) + '"') +
        '</div>';
    }
  });
  if (items.length > QUEUE_CAP) {
    html += '<p class="hint">ほか ' + (items.length - QUEUE_CAP) + ' 件は、上の分が終わると出てきます。</p>';
  }
  box.innerHTML = html;
}

/* ---------- 2. 本棚 ---------- */
var currentEpisode = null;
var LANG_ORDER = ['en', 'el', 'fi', 'sv', 'ko', 'fr', 'ar', 'ja'];

function renderShelf() {
  var listBox = document.getElementById('shelf-list');
  var detailBox = document.getElementById('episode-detail');
  if (currentEpisode && EP_BY_ID[currentEpisode]) {
    listBox.hidden = true;
    detailBox.hidden = false;
    detailBox.innerHTML = episodeDetailHtml(EP_BY_ID[currentEpisode]);
    return;
  }
  listBox.hidden = false;
  detailBox.hidden = true;
  detailBox.innerHTML = '';
  var html = '<h2>本棚</h2><p class="hint">配信されたエピソードが、言語ごとに並んでいます。いつでも開いて聞き直せます。侍言葉は日本語のシリーズとしてここに並びます。</p>';
  LANG_ORDER.forEach(function (lang) {
    var eps = EPISODES.filter(function (e) { return e.lang === lang; });
    if (!eps.length) return;
    eps.sort(function (a, b) { return a.delivered < b.delivered ? 1 : -1; });
    html += '<h3 class="lang-head">' + esc(eps[0].langName) + '</h3>';
    eps.forEach(function (ep) {
      var es = state.eps[ep.id] || {};
      var badges = '';
      if (es.recap) badges += ' <span class="badge done">おさらい済み</span>';
      if (es.test) badges += ' <span class="badge done">テスト済み</span>';
      if (ep.audio) badges += ' <span class="badge">音声あり</span>';
      html += '<button type="button" class="ep-row" data-act="open-ep" data-ep="' + esc(ep.id) + '">' +
        '<span class="ep-title">' + esc(ep.title) + '</span>' + badges +
        '<div class="ep-meta">' + fmtFull(ep.delivered) + ' 配信／場面：' + esc(ep.scene) + '／全' + ep.lines.length + '行</div>' +
        '</button>';
    });
  });
  listBox.innerHTML = html;
}

function episodeDetailHtml(ep) {
  var html = '<button type="button" class="back-btn" data-act="back-shelf">← 本棚に戻る</button>';
  html += '<h2>' + esc(ep.langName) + '「' + esc(ep.title) + '」</h2>';
  html += '<p class="hint">' + fmtFull(ep.delivered) + ' 配信／場面：' + esc(ep.scene) +
    '／おさらい期日：' + fmtFull(recapDue(ep)) + '／テスト期日：' + fmtFull(testDue(ep)) + '</p>';
  html += '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-ep" data-ep="' +
    esc(ep.id) + '" data-kind="free">クイズで復習</button></div>';
  if (ep.audio) {
    html += '<audio controls preload="none" src="' + esc(ep.audio) + '"></audio>';
  }
  ep.lines.forEach(function (ln, idx) {
    var ls = peekLine(lineKey(ep.id, idx));
    html += '<div class="line-row">' +
      '<div>' + lineTextHtml(ep, idx) + ' ' + statusBadge(ls) + '</div>' +
      markButtons('line-mark', 'data-ep="' + esc(ep.id) + '" data-idx="' + idx + '"') +
      '</div>';
  });
  return html;
}

/* ---------- 3. 表現帳 ---------- */
function renderPhrases() {
  var langSel = document.getElementById('filter-lang');
  var mistakesOnly = document.getElementById('filter-mistakes').checked;
  var lang = langSel.value || 'all';
  var rows = [];
  EPISODES.forEach(function (ep) {
    if (lang !== 'all' && ep.lang !== lang) return;
    ep.lines.forEach(function (ln, idx) {
      var ls = peekLine(lineKey(ep.id, idx));
      if (mistakesOnly && !(ls.everMada && ls.lastResult === 'mada')) return;
      rows.push({ ep: ep, idx: idx, ls: ls });
    });
  });
  document.getElementById('phrases-count').textContent =
    (mistakesOnly ? '間違えた物だけ：' : '全部で ') + rows.length + ' 件';
  var box = document.getElementById('phrases-list');
  if (!rows.length) {
    box.innerHTML = '<div class="empty">' +
      (mistakesOnly ? 'いま「間違えた物」はありません。クイズで間違えた行や「まだ」にした行が、ここに集まります。' : '表示する行がありません。') +
      '</div>';
    return;
  }
  var html = '';
  rows.forEach(function (r) {
    html += '<div class="phrase-row">' +
      '<div>' + lineTextHtml(r.ep, r.idx) + ' ' + statusBadge(r.ls) + '</div>' +
      '<div class="q-meta">' + esc(r.ep.langName) + '「' + esc(r.ep.title) + '」</div>' +
      markButtons('line-mark', 'data-ep="' + esc(r.ep.id) + '" data-idx="' + r.idx + '"') +
      '</div>';
  });
  box.innerHTML = html;
}

/* ---------- 4. クイズ ---------- */
var quiz = null; // {title, kind, epId, questions, idx, correctCount, answered, picked}

function startEpisodeQuiz(epId, kind) {
  var ep = EP_BY_ID[epId];
  if (!ep) return;
  var qs = genEpisodeQuiz(ep);
  if (!qs.length) return;
  quiz = {
    title: ep.langName + '「' + ep.title + '」',
    kind: kind, epId: epId, questions: qs, idx: 0, correctCount: 0,
    answered: false, picked: []
  };
  showQuiz();
}
function startLineQuiz(epId, idx) {
  var ep = EP_BY_ID[epId];
  if (!ep) return;
  var qs = genLineQuiz([lineKey(epId, idx)]);
  if (!qs.length) return;
  quiz = {
    title: ep.langName + '「' + ep.title + '」弱い行クイズ',
    kind: 'weak', epId: epId, questions: qs, idx: 0, correctCount: 0,
    answered: false, picked: []
  };
  showQuiz();
}
function showQuiz() {
  stopSpeak();
  ['queue', 'shelf', 'phrases'].forEach(function (t) {
    document.getElementById('view-' + t).hidden = true;
  });
  document.getElementById('view-quiz').hidden = false;
  document.querySelectorAll('.tabbar .tab').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === 'queue');
  });
  window.scrollTo(0, 0);
  renderQuiz();
}
function closeQuiz() {
  quiz = null;
  stopSpeak();
  document.getElementById('view-quiz').hidden = true;
  renderAll();
  switchTab('queue');
}
function quizHeadHtml() {
  return '<div class="quiz-head"><span>' + (quiz.idx + 1) + ' / ' + quiz.questions.length + ' 問</span>' +
    '<span>正解 ' + quiz.correctCount + '</span>' +
    '<button type="button" class="quiz-quit" data-act="quiz-quit">やめる</button></div>' +
    '<div class="quiz-title">' + esc(quiz.title) + '</div>';
}
function renderQuiz() {
  var box = document.getElementById('quiz-box');
  if (!quiz) { box.innerHTML = ''; return; }
  if (quiz.idx >= quiz.questions.length) { renderQuizSummary(box); return; }
  var q = quiz.questions[quiz.idx];
  var ep = EP_BY_ID[q.epId];
  var html = quizHeadHtml();
  if (q.type === 'meaning') {
    html += '<div class="q-kind">意味当て：この文の意味は？</div>' +
      '<div class="q-prompt"><span dir="auto">' + esc(q.text) + '</span> ' + speakBtn(q.epId, q.lineIdx) + '</div>' +
      optionsHtml(q);
  } else if (q.type === 'reverse') {
    html += '<div class="q-kind">逆向き：この意味の文はどれ？</div>' +
      '<div class="q-prompt">' + esc(q.ja) + '</div>' + optionsHtml(q);
  } else if (q.type === 'fill') {
    html += '<div class="q-kind">穴埋め：＿＿＿に入る言葉は？</div>' +
      '<div class="q-prompt"><span dir="auto">' + esc(q.sentence) + '</span></div>' +
      (q.ja ? '<div class="q-ja">意味：' + esc(q.ja) + '</div>' : '') + optionsHtml(q);
  } else if (q.type === 'listening') {
    html += '<div class="q-kind">聞き取り：音声を聞いて、言った文を選んでください</div>' +
      '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-listen">🔊 聞く</button></div>' +
      optionsHtml(q);
  } else if (q.type === 'order') {
    html += '<div class="q-kind">並べ替え：言葉を正しい順にタップしてください</div>' +
      (q.ja ? '<div class="q-prompt">' + esc(q.ja) + '</div>' : '') +
      '<div class="order-answer" id="order-answer"></div>' +
      '<div class="order-pool" id="order-pool"></div>' +
      '<div class="q-actions"><button type="button" class="quiz-btn" id="order-check" data-act="quiz-order-check" disabled>答え合わせ</button></div>';
  }
  html += '<div id="quiz-feedback"></div>';
  box.innerHTML = html;
  if (q.type === 'order') renderOrderChips();
}
function optionsHtml(q) {
  var html = '<div class="options">';
  q.options.forEach(function (opt, i) {
    html += '<button type="button" class="opt-btn" data-act="quiz-answer" data-i="' + i + '">' +
      '<span dir="auto">' + esc(opt) + '</span></button>';
  });
  return html + '</div>';
}
function renderOrderChips() {
  var q = quiz.questions[quiz.idx];
  if (!q || q.type !== 'order') return;
  if (!quiz.shuffledTokens) quiz.shuffledTokens = shuffle(q.tokens);
  var poolBox = document.getElementById('order-pool');
  var ansBox = document.getElementById('order-answer');
  var poolHtml = '';
  quiz.shuffledTokens.forEach(function (tok, i) {
    if (quiz.picked.indexOf(i) >= 0) return;
    poolHtml += '<button type="button" class="chip" data-act="chip-pick" data-i="' + i + '">' + esc(tok) + '</button>';
  });
  poolBox.innerHTML = poolHtml || '<span class="hint">全部置きました</span>';
  var ansHtml = '';
  quiz.picked.forEach(function (pi, pos) {
    ansHtml += '<button type="button" class="chip placed" data-act="chip-unpick" data-pos="' + pos + '">' +
      esc(quiz.shuffledTokens[pi]) + '</button>';
  });
  ansBox.innerHTML = ansHtml || '<span class="hint">ここに文が組み上がります</span>';
  var btn = document.getElementById('order-check');
  if (btn) btn.disabled = quiz.picked.length !== q.tokens.length || quiz.answered;
}
/* 採点して記録する。戻り値：正解かどうか */
function gradeCurrent(isCorrect) {
  var q = quiz.questions[quiz.idx];
  applyLineMark(q.epId, q.lineIdx, isCorrect ? 'ok' : 'mada', null);
  if (isCorrect) quiz.correctCount++;
  quiz.answered = true;
  return isCorrect;
}
function feedbackHtml(isCorrect, q) {
  var ep = EP_BY_ID[q.epId];
  var ln = ep.lines[q.lineIdx];
  var msg = isCorrect ? '正解！' : '残念。正解は：';
  var html = '<div class="feedback ' + (isCorrect ? 'good' : 'bad') + '">' +
    '<div class="fb-msg">' + msg + '</div>' +
    '<div class="fb-line"><span dir="auto">' + esc(ln.text) + '</span> ' + speakBtn(q.epId, q.lineIdx) +
    (ln.ja ? '<div class="ja">' + esc(ln.ja) + '</div>' : '') + '</div>' +
    '<div class="q-meta">' + (isCorrect
      ? 'この行は「できた」で記録しました。'
      : 'この行は「まだ」で記録しました。明日と3日後に、弱い行として先に出ます。') + '</div>' +
    '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-next">' +
    (quiz.idx + 1 >= quiz.questions.length ? '結果を見る' : '次へ') + '</button></div></div>';
  return html;
}
function answerChoice(i) {
  if (!quiz || quiz.answered) return;
  var q = quiz.questions[quiz.idx];
  var isCorrect = (i === q.correct);
  gradeCurrent(isCorrect);
  var box = document.getElementById('quiz-box');
  box.querySelectorAll('.opt-btn').forEach(function (b) {
    var bi = Number(b.getAttribute('data-i'));
    b.disabled = true;
    if (bi === q.correct) b.classList.add('correct');
    else if (bi === i) b.classList.add('wrong');
  });
  document.getElementById('quiz-feedback').innerHTML = feedbackHtml(isCorrect, q);
}
function answerOrder() {
  if (!quiz || quiz.answered) return;
  var q = quiz.questions[quiz.idx];
  if (q.type !== 'order' || quiz.picked.length !== q.tokens.length) return;
  var mine = quiz.picked.map(function (pi) { return quiz.shuffledTokens[pi]; });
  var isCorrect = mine.join(' ') === q.tokens.join(' ');
  gradeCurrent(isCorrect);
  document.getElementById('quiz-feedback').innerHTML = feedbackHtml(isCorrect, q);
  renderOrderChips();
}
function renderQuizSummary(box) {
  var total = quiz.questions.length;
  var html = '<div class="card"><h3>結果</h3>' +
    '<p class="quiz-score">' + total + '問中 ' + quiz.correctCount + ' 問正解</p>';
  if (quiz.kind === 'recap' || quiz.kind === 'test' || quiz.kind === 'prep') {
    var res = (quiz.correctCount * 2 >= total) ? 'ok' : 'mada';
    applyEpisodeMark(quiz.kind, quiz.epId, res);
    var ep = EP_BY_ID[quiz.epId];
    var label = quiz.kind === 'test' ? 'テスト' : (quiz.kind === 'prep' ? '予習' : 'おさらい');
    html += '<p>' + esc(ep.langName) + '「' + esc(ep.title) + '」の' + label + 'を完了として記録しました。</p>';
  }
  if (quiz.correctCount < total) {
    html += '<p class="hint">間違えた行は「まだ」で記録され、明日と3日後に弱い行として先に出ます。</p>';
  }
  html += '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-done">キューに戻る</button></div></div>';
  box.innerHTML = html;
}

/* ---------- 画面切り替え ---------- */
function switchTab(name) {
  stopSpeak();
  ['queue', 'shelf', 'phrases', 'quiz'].forEach(function (t) {
    document.getElementById('view-' + t).hidden = (t !== name);
  });
  document.querySelectorAll('.tabbar .tab').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === name);
  });
  window.scrollTo(0, 0);
}

function renderAll() {
  renderQueue();
  renderShelf();
  renderPhrases();
}

/* ---------- イベント ---------- */
document.addEventListener('click', function (ev) {
  var tabBtn = ev.target.closest ? ev.target.closest('[data-tab]') : null;
  if (tabBtn) {
    if (quiz) { quiz = null; }
    switchTab(tabBtn.getAttribute('data-tab'));
    renderAll();
    return;
  }
  var el = ev.target.closest ? ev.target.closest('[data-act]') : null;
  if (!el) return;
  var act = el.getAttribute('data-act');
  if (act === 'ep-mark') {
    markEpisode(el.getAttribute('data-kind'), el.getAttribute('data-ep'), el.getAttribute('data-result'));
  } else if (act === 'line-mark') {
    markLine(el.getAttribute('data-ep'), Number(el.getAttribute('data-idx')),
      el.getAttribute('data-result'), el.getAttribute('data-weak') || null);
  } else if (act === 'open-ep') {
    currentEpisode = el.getAttribute('data-ep');
    renderShelf();
    window.scrollTo(0, 0);
  } else if (act === 'back-shelf') {
    currentEpisode = null;
    renderShelf();
  } else if (act === 'speak') {
    var ep = EP_BY_ID[el.getAttribute('data-ep')];
    if (ep) speakLine(ep, Number(el.getAttribute('data-idx')));
  } else if (act === 'quiz-ep') {
    startEpisodeQuiz(el.getAttribute('data-ep'), el.getAttribute('data-kind') || 'free');
  } else if (act === 'quiz-weak') {
    startLineQuiz(el.getAttribute('data-ep'), Number(el.getAttribute('data-idx')));
  } else if (act === 'quiz-answer') {
    answerChoice(Number(el.getAttribute('data-i')));
  } else if (act === 'quiz-listen') {
    if (quiz) {
      var q = quiz.questions[quiz.idx];
      var ep2 = EP_BY_ID[q.epId];
      if (ep2) speakLine(ep2, q.lineIdx);
    }
  } else if (act === 'chip-pick') {
    if (quiz && !quiz.answered) { quiz.picked.push(Number(el.getAttribute('data-i'))); renderOrderChips(); }
  } else if (act === 'chip-unpick') {
    if (quiz && !quiz.answered) { quiz.picked.splice(Number(el.getAttribute('data-pos')), 1); renderOrderChips(); }
  } else if (act === 'quiz-order-check') {
    answerOrder();
  } else if (act === 'quiz-next') {
    quiz.idx++;
    quiz.answered = false;
    quiz.picked = [];
    quiz.shuffledTokens = null;
    renderQuiz();
  } else if (act === 'quiz-done' || act === 'quiz-quit') {
    closeQuiz();
  }
});

/* ---------- 初期化 ---------- */
(function init() {
  var t = todayStr();
  document.getElementById('today-label').textContent = '今日は ' + fmtFull(t) + ' です';
  var sel = document.getElementById('filter-lang');
  var opts = '<option value="all">すべての言語</option>';
  LANG_ORDER.forEach(function (lang) {
    var ep = EPISODES.filter(function (e) { return e.lang === lang; })[0];
    if (ep) opts += '<option value="' + lang + '">' + esc(ep.langName) + '</option>';
  });
  sel.innerHTML = opts;
  sel.addEventListener('change', renderPhrases);
  document.getElementById('filter-mistakes').addEventListener('change', renderPhrases);
  renderAll();
})();
