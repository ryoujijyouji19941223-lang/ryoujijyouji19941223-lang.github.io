'use strict';
/*
 * 語学の見直しアプリ（フェーズ1）
 * 復習の背骨は「ユーザーのリズム」：
 *   - おさらい = 配信の3日後
 *   - テスト   = 翌週の同じ曜日（配信の7日後）
 *   - 結果は「できた／まだ」で順に記録する。隠れた計算や罰（ハート等）は無い。
 * 追加ルールは1つだけ：「まだ」にした行は、翌日と3日後に「弱い行の早出し」として
 * 理由つきでキューの先頭に出す。言えた行は通常のリズムに戻る。
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
function markEpisode(kind, epId, result) {
  var es = epState(epId);
  es[kind] = { result: result, date: todayStr() };
  saveState();
  renderAll();
}

function markLine(epId, idx, result, weakDate) {
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
  renderAll();
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
function lineTextHtml(ep, idx) {
  var ln = ep.lines[idx];
  var h = '';
  if (ln.sp) h += '<span class="sp">' + esc(ln.sp) + '：</span> ';
  h += '<span class="tx" dir="auto">' + esc(ln.text) + '</span>';
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
      var key = lineKey(it.epId, it.lineIdx);
      html += '<div class="qitem">' +
        '<span class="reason weak">' + esc(it.reason) + '（' + fmtFull(it.weakDate) + 'の分）</span>' +
        '<div class="q-title">' + esc(ep.langName) + '「' + esc(ep.title) + '」</div>' +
        '<div class="q-text">' + lineTextHtml(ep, it.lineIdx) + '</div>' +
        '<div class="q-meta">声に出して言えたら「できた」、言えなかったら「まだ」</div>' +
        markButtons('line-mark', 'data-ep="' + esc(it.epId) + '" data-idx="' + it.lineIdx + '" data-weak="' + esc(it.weakDate) + '"') +
        '</div>';
    } else {
      var badges = '';
      var dueText = it.kind === 'prep'
        ? 'テストは ' + fmtFull(it.due)
        : '期日：' + fmtFull(it.due) + (it.due < today ? '（過ぎています）' : '');
      html += '<div class="qitem">' +
        '<span class="reason">' + esc(it.reason) + '</span>' +
        '<div class="q-title">' + esc(ep.langName) + '「' + esc(ep.title) + '」 ' + badges + '</div>' +
        '<div class="q-meta">場面：' + esc(ep.scene) + '／全' + ep.lines.length + '行／' + dueText + '</div>' +
        '<div class="q-meta">本棚で開いて聞き直してから、全体の手応えを記録してください。</div>' +
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
var LANG_ORDER = ['en', 'el', 'fi', 'sv', 'ko', 'fr', 'ar'];

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
  var html = '<h2>本棚</h2><p class="hint">配信されたエピソードが、言語ごとに並んでいます。いつでも開いて聞き直せます。</p>';
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
      (mistakesOnly ? 'いま「間違えた物」はありません。「まだ」にした行が、ここに集まります。' : '表示する行がありません。') +
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

/* ---------- 画面切り替え ---------- */
function switchTab(name) {
  ['queue', 'shelf', 'phrases', 'samurai'].forEach(function (t) {
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
  if (tabBtn) { switchTab(tabBtn.getAttribute('data-tab')); return; }
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
