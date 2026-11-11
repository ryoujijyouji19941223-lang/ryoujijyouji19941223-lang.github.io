'use strict';
/*
 * 語学の見直しアプリ v5
 *
 * 本筋は「自動クイズ＋自動採点」。エピソードの行から問題を自動で作る：
 *   意味当て（外国語の文→日本語の意味を4択）／逆向き（日本語→外国語の文を4択）／
 *   穴埋め（文の内容語を隠して4択）／入力（隠した語を打つ）／
 *   並べ替え（短い文をタップで並べる。余分な言葉も混ざる）／
 *   聞き取り（音声を聞いて文を4択）。本棚の回からは「ペア合わせ」もできる。
 * v4の要点：今日の復習は言語単位のミックス復習が本筋（回を選ばない）。
 *   セッションは「見て分かる→穴埋め→作る」の弧を描き、同じ行を続けない。
 *   入力形式は言語ごとに表記ゆれをならして採点し、1文字違いまで「惜しい正解」。
 * 答えるとその場で正解・不正解が出て、採点結果がそのまま復習の記録になる。
 * 「できた／まだ」の自己申告ボタンは、本棚などに補助として残してある。
 *
 * v5の要点（2026-11-10、学習法レビューに基づくユーザー承認済み）：
 *   - 卒業テール：「できた」行に +14日／+30日の確認を予定し、両方できたら「卒業」。
 *     途中で「まだ」になったらテールは白紙に戻り、弱い行フローへ戻る。
 *   - ミックス復習の類似度ルール：全言語ミックスではロマンス語群
 *     （イタリア語・フランス語・ポルトガル語・ラテン語）から1言語だけ、登場言語は最大5つ。
 *   - 聞いて打つ（ディクテーション）形式を用意したが、行ごとの音声区間データが
 *     無いため DICTATION_ENABLED=false で無効化してある（理由は同変数のコメント参照）。
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
 * v7の要点（2026-11-11、ユーザーの「Duolingoみたいなアプリがよかったな」に応えて）：
 *   - Duolingo式レッスンモードを追加。全言語が対象で、形式は5つ：
 *     ペア合わせ（単語⇔読み／読みが無い言語は単語⇔日本語訳）、文字クイズ
 *     （読みを見て正しい綴りを4択。読みのある言語だけ）、聞いて選ぶ、
 *     聞いて並べる、訳して並べる。1問ずつ表示・進捗バー・大きなCHECK・
 *     即時フィードバックという作法で、結果は既存の行の記録へ反映する。
 *   - 行が4行未満の回（アラビア語ワンフレーズ）と日本語シリーズ（侍言葉）は
 *     レッスンを組まず、入口で理由を表示する。
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

  /* v5：卒業テール（弱い行の早出しの次、回の期日分より先に出す小さな区分） */
  var tailItems = [];
  Object.keys(state.lines).forEach(function (key) {
    var td = tailDue(state.lines[key], today);
    if (!td) return;
    var parts = key.split('#');
    var ep = EP_BY_ID[parts[0]];
    if (!ep) return;
    tailItems.push({
      kind: 'tail', epId: ep.id, lineIdx: Number(parts[1]), due: td.d, tailDate: td.d, stage: td.stage,
      reason: td.stage === 14 ? '卒業チェック（14日後）' : '卒業チェック（30日後・最終）'
    });
  });
  tailItems.sort(function (a, b) { return a.due < b.due ? -1 : 1; });

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
  return weakItems.concat(tailItems, mainItems);
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
  Object.keys(state.lines).forEach(function (key) {
    var ls = state.lines[key];
    if (!ls || !ls.tail || ls.graduated) return;
    var d = !ls.tail.passed14 ? ls.tail.d14 : (!ls.tail.passed30 ? ls.tail.d30 : null);
    if (d && d > today && (!best || d < best.d)) {
      var ep2 = EP_BY_ID[key.split('#')[0]];
      if (ep2) best = { d: d, what: '卒業チェック', ep: ep2 };
    }
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

/* ---------- v5：卒業テール ----------
 * 「できた」になった行は、+14日と+30日に確認（テールチェック）を予定する。
 * 両方できたら「卒業」：以後は「できた」行の抜き打ち（スポットチェック）枠でのみ出る。
 * 途中で一度でも「まだ」になったらテールは白紙に戻り、弱い行フロー（+1日/+3日）へ戻る。
 * 行の記録への追加フィールド（すべて任意・v4以前の保存データには無いので、
 * 無い場合は「テール未予定・未卒業」として扱い、保存データは消さない）：
 *   tail: { base, d14, passed14, d30, passed30 } / graduated: true / graduatedDate */
function scheduleTail(ls, t) {
  if (ls.graduated || ls.tail) return;
  ls.tail = { base: t, d14: addDays(t, 14), passed14: false, d30: addDays(t, 30), passed30: false };
}
/* 期日が来ているテール段階。無ければ null。buildQueue と classifyLangLines が使う */
function tailDue(ls, today) {
  if (!ls || !ls.tail || ls.graduated) return null;
  if (!ls.tail.passed14 && ls.tail.d14 <= today) return { stage: 14, d: ls.tail.d14 };
  if (ls.tail.passed14 && !ls.tail.passed30 && ls.tail.d30 <= today) return { stage: 30, d: ls.tail.d30 };
  return null;
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
  if (result === 'ok') {
    /* 卒業テール：期日が来た段階を消化し、テールが無ければ（再）予定する */
    if (ls.tail) {
      if (!ls.tail.passed14 && ls.tail.d14 <= t) ls.tail.passed14 = true;
      else if (ls.tail.passed14 && !ls.tail.passed30 && ls.tail.d30 <= t) ls.tail.passed30 = true;
      if (ls.tail.passed14 && ls.tail.passed30) {
        ls.graduated = true;
        ls.graduatedDate = t;
        ls.tail = null;
      }
    }
    scheduleTail(ls, t);
  }
  if (result === 'mada') {
    /* 「まだ」になったらテールは白紙に戻す。卒業済みも取り消して弱い行フローへ */
    ls.tail = null;
    ls.graduated = false;
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
  stopDictation();
}

/* ---------- v5：聞いて打つ（ディクテーション） ----------
 * 形式そのもの（出題・区間再生・採点・記録）は実装済みだが、現在のデータでは
 * 行ごとの音声区間（その行が ep.audio の何秒〜何秒か）が存在しないため、
 * 下のフラグで無効化してある。端末の音声合成（speakText）での代用はしない
 * （モデルの発音が違うと、間違った音を覚えてしまうため）。
 *
 * 有効化に必要なデータ：エピソードごとに、行 index と対応する
 * {start, end}（秒）の配列。置き場所は data.js の ep.timing（推奨）か各行の t0/t1。
 * lineTiming() が両形式を読む。
 * データが無い理由：render_episode_v2.py は行ごとのクリップを（行の後に0.35秒の
 * 間を挟み、PAUSE行は指定秒の無音）連結して1本の音声を作るが、区間表を
 * 書き出していない。作業フォルダの line_NN.wav キャッシュもワークスペースに
 * 残っていないため、既存エピソードの区間を正確には復元できない
 * （無音検出での推定は、文中の間や分割時の0.15秒の間と混ざって誤差が大きく、使わない）。
 * レンダーに区間表（JSON）の出力を足せば今後のエピソードから有効化でき、
 * その時は DICTATION_ENABLED を true に変えるだけでよい。 */
var DICTATION_ENABLED = false;
var dictAudio = null;
var dictTimer = null;
function lineTiming(ep, idx) {
  var ln = ep.lines[idx];
  if (!ln) return null;
  if (typeof ln.t0 === 'number' && typeof ln.t1 === 'number' && ln.t1 > ln.t0) {
    return { start: ln.t0, end: ln.t1 };
  }
  if (Array.isArray(ep.timing) && ep.timing[idx] &&
      typeof ep.timing[idx].start === 'number' && typeof ep.timing[idx].end === 'number' &&
      ep.timing[idx].end > ep.timing[idx].start) {
    return { start: ep.timing[idx].start, end: ep.timing[idx].end };
  }
  return null;
}
function playDictation(q) {
  var ep = EP_BY_ID[q.epId];
  if (!ep || !ep.audio || q.start == null || q.end == null) return;
  try {
    stopSpeak();
    if (!dictAudio) dictAudio = new Audio();
    try { dictAudio.pause(); } catch (e) { /* 初回は止める物が無い */ }
    dictAudio.src = ep.audio;
    dictAudio.currentTime = q.start;
    var pr = dictAudio.play();
    if (pr && pr.catch) pr.catch(function () { /* 再生できなくても画面は続く */ });
    if (dictTimer) clearTimeout(dictTimer);
    dictTimer = setTimeout(function () {
      if (dictAudio) { try { dictAudio.pause(); } catch (e) { /* 何もしない */ } }
    }, Math.max(0, (q.end - q.start)) * 1000 + 300);
  } catch (e) { /* 音が出なくても画面は続く */ }
}
function stopDictation() {
  if (dictTimer) { clearTimeout(dictTimer); dictTimer = null; }
  if (dictAudio) { try { dictAudio.pause(); } catch (e) { /* 何もしない */ } }
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
/* ---------- v4：正規化と入力形式の採点 ---------- */
/* 言語ごとに表記ゆれをならしてから比べる（研究の生成ルール14：正規化してから採点） */
function normalizeAnswer(s, lang) {
  var t = String(s == null ? '' : s).trim();
  if (lang === 'ar') {
    /* 母音記号（タシュキール）とタトウィール（伸ばし記号）を落とす */
    t = t.replace(/[ً-ٰٟـ]/g, '');
    /* ة/ه、ى/ي のゆれと、hamza付きアリフをならす */
    t = t.replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[إأآ]/g, 'ا');
  }
  if (lang === 'el') {
    /* トノス（アクセント記号）を外して比べる */
    t = t.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
  }
  if (lang === 'ko') t = t.replace(/\s+/g, ''); /* 韓国語は空白を無視 */
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ''); /* 句読点・記号を落とす */
  if (lang !== 'ko') t = t.replace(/\s+/g, ' ');
  return t.toLowerCase().trim();
}
function editDistance(a, b) {
  var m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  var prev = [], cur = [], i, j, tmp;
  for (j = 0; j <= n; j++) prev[j] = j;
  for (i = 1; i <= m; i++) {
    cur[0] = i;
    for (j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    tmp = prev; prev = cur; cur = tmp;
  }
  return prev[n];
}
/* 入力形式の採点。戻り値 result: 'exact' 正解 / 'close' 惜しい正解（正解として記録） / 'wrong' / 'empty' */
function gradeTyped(input, answer, lang) {
  var a = normalizeAnswer(input, lang);
  var b = normalizeAnswer(answer, lang);
  if (!a) return { result: 'empty', distance: null };
  if (a === b) return { result: 'exact', distance: 0 };
  if (lang === 'zh') return { result: 'wrong', distance: null }; /* 中国語は完全一致のみ */
  var d = editDistance(a, b);
  if (d <= 1 && b.length >= 3) return { result: 'close', distance: d };
  return { result: 'wrong', distance: d };
}

/* ---------- v4：選択肢（間違いの選択肢）の生成 ---------- */
/* 同じエピソード→同じ言語の他エピソードの順に優先する（研究の生成ルール1）。
 * 正規化して正解と重なる物・他と重なる物は捨てる（ルール5）。
 * 長さが極端に違う物も捨てる（ルール2：長さで正解が漏れないように）。 */
function pickDistractors(ep, correctVal, tiers, opt) {
  opt = opt || {};
  var lang = ep.lang;
  var used = {};
  used[normalizeAnswer(correctVal, lang)] = 1;
  (opt.excludeKeys || []).forEach(function (k) { used[k] = 1; });
  var minR = opt.minR || 0.4, maxR = opt.maxR || 2.5;
  var pickedVals = [];
  tiers.forEach(function (tier) {
    shuffle(tier).forEach(function (v) {
      if (pickedVals.length >= 3) return;
      var k = normalizeAnswer(v, lang);
      if (!k || used[k]) return;
      var a = String(correctVal).length, b = String(v).length;
      if (!a || !b) return;
      var r = b / a;
      if (r < minR || r > maxR) return;
      used[k] = 1;
      pickedVals.push(v);
    });
  });
  if (pickedVals.length < 3) return null;
  var opts = shuffle([correctVal].concat(pickedVals));
  return { options: opts, correct: opts.indexOf(correctVal) };
}
/* 行レベルの候補 tiers：[同じエピソードの行, 同じ言語の他エピソードの行] から値を取る */
function lineTiers(ep, getVal, skipIdx) {
  var same = [], other = [];
  ep.lines.forEach(function (ln, i) {
    if (i === skipIdx) return;
    var v = getVal(ln);
    if (v) same.push(v);
  });
  EPISODES.forEach(function (e2) {
    if (e2.id === ep.id || e2.lang !== ep.lang) return;
    e2.lines.forEach(function (ln) {
      var v = getVal(ln);
      if (v) other.push(v);
    });
  });
  return [same, other];
}
/* 語レベルの候補 tiers。対象の行に出てくる語は「入れても当てはまる」危険があるので除外キーに入れる */
function wordTiers(ep, ln) {
  var excludeKeys = [];
  var seen = {};
  contentWords(ln.text).forEach(function (w) {
    var k = normalizeAnswer(w, ep.lang);
    if (!seen[k]) { seen[k] = 1; excludeKeys.push(k); }
  });
  var same = [], other = [];
  ep.lines.forEach(function (l2) {
    if (l2 === ln) return;
    contentWords(l2.text).forEach(function (w) { same.push(w); });
  });
  EPISODES.forEach(function (e2) {
    if (e2.id === ep.id || e2.lang !== ep.lang) return;
    e2.lines.forEach(function (l2) {
      contentWords(l2.text).forEach(function (w) { other.push(w); });
    });
  });
  return { tiers: [same, other], excludeKeys: excludeKeys };
}

var QUIZ_FORMATS = ['meaning', 'reverse', 'fill', 'type', 'order', 'listening', 'dictation'];
/* 穴埋め（4択）と入力形式で共用する、隠す語と文の決定 */
function pickClozeTarget(ep, idx) {
  var ln = ep.lines[idx];
  var words = contentWords(ln.text);
  if (!words.length) return null;
  var word = words[Math.floor(Math.random() * words.length)];
  var sentence = ln.text.replace(word, '＿＿＿');
  if (sentence === ln.text) return null;
  return { word: word, sentence: sentence };
}
function makeQuestion(ep, idx, format) {
  var ln = ep.lines[idx];
  if (format === 'meaning') {
    if (!ln.ja) return null;
    var tiersM = lineTiers(ep, function (l) { return l.ja; }, idx);
    var qm = pickDistractors(ep, ln.ja, tiersM, { minR: 0.35, maxR: 2.8 });
    if (!qm) return null;
    return { type: 'meaning', epId: ep.id, lineIdx: idx, text: ln.text, options: qm.options, correct: qm.correct };
  }
  if (format === 'reverse' || format === 'listening') {
    var tiersT = lineTiers(ep, function (l) { return l.text; }, idx);
    var qt = pickDistractors(ep, ln.text, tiersT, { minR: 0.35, maxR: 2.8 });
    if (!qt) return null;
    return { type: format, epId: ep.id, lineIdx: idx, ja: ln.ja || '', text: ln.text, options: qt.options, correct: qt.correct };
  }
  if (format === 'fill' || format === 'type') {
    var ct = pickClozeTarget(ep, idx);
    if (!ct) return null;
    if (format === 'type') {
      return { type: 'type', epId: ep.id, lineIdx: idx, sentence: ct.sentence, word: ct.word, ja: ln.ja || '', text: ln.text };
    }
    var wt = wordTiers(ep, ln);
    var qf = pickDistractors(ep, ct.word, wt.tiers, { minR: 0.5, maxR: 2.0, excludeKeys: wt.excludeKeys });
    if (!qf) return null;
    return { type: 'fill', epId: ep.id, lineIdx: idx, sentence: ct.sentence, word: ct.word, ja: ln.ja || '', options: qf.options, correct: qf.correct };
  }
  if (format === 'dictation') {
    /* 聞いて打つ：行の音声区間がデータに無いため、通常は作れない（DICTATION_ENABLED のコメント参照） */
    if (!DICTATION_ENABLED) return null;
    var tm = lineTiming(ep, idx);
    if (!ep.audio || !tm) return null;
    return { type: 'dictation', epId: ep.id, lineIdx: idx, text: ln.text, ja: ln.ja || '', start: tm.start, end: tm.end };
  }
  if (format === 'order') {
    var toks = splitTokens(ln.text);
    if (toks.length < 2 || toks.length > 6) return null;
    if (toks.every(function (t) { return t === toks[0]; })) return null;
    var extras = pickOrderExtras(ep, ln, toks);
    return { type: 'order', epId: ep.id, lineIdx: idx, ja: ln.ja || '', tokens: toks, extras: extras };
  }
  return null;
}
/* 並べ替えの「余分タイル」：同じエピソードの他の行から、答えと重ならない語を1〜2枚 */
function pickOrderExtras(ep, ln, toks) {
  var used = {};
  toks.forEach(function (t) { used[normalizeAnswer(t, ep.lang)] = 1; });
  contentWords(ln.text).forEach(function (w) { used[normalizeAnswer(w, ep.lang)] = 1; });
  var pool = [];
  ep.lines.forEach(function (l2) {
    if (l2 === ln) return;
    splitTokens(l2.text).forEach(function (t) {
      var c = cleanWord(t);
      if (c.length >= 2 && !used[normalizeAnswer(c, ep.lang)]) pool.push(c);
    });
  });
  pool = shuffle(pool);
  var out = [];
  pool.forEach(function (w) {
    if (out.length >= 2) return;
    var k = normalizeAnswer(w, ep.lang);
    if (used[k]) return;
    used[k] = 1;
    out.push(w);
  });
  return out;
}
/* 並べ替えのタイル列（extra=true のタイルは答えに不要で、置かなくてよい） */
function buildTiles(q) {
  var tiles = q.tokens.map(function (t) { return { t: t, extra: false }; });
  (q.extras || []).forEach(function (t) { tiles.push({ t: t, extra: true }); });
  return shuffle(tiles);
}
/* 並べ替えの答え合わせ：余分タイルは無視し、答えタイルの並びだけを見る */
function checkOrder(q, tiles, pickedIdxs) {
  var seq = [];
  pickedIdxs.forEach(function (pi) { if (!tiles[pi].extra) seq.push(tiles[pi].t); });
  if (seq.length !== q.tokens.length) return false;
  for (var i = 0; i < seq.length; i++) if (seq[i] !== q.tokens[i]) return false;
  return true;
}
function countAnswerTiles(tiles, pickedIdxs) {
  var n = 0;
  pickedIdxs.forEach(function (pi) { if (!tiles[pi].extra) n++; });
  return n;
}

/* ---------- v4：セッションの弧 ---------- */
/* 段階：0=見て分かる（意味当て・逆向き・聞き取り）→ 1=穴埋め4択 → 2=作る（入力・並べ替え）。
 * 段階の中は行を散らして、同じ行の問題が背中合わせにならないようにする。 */
var FORMAT_PHASE = { meaning: 0, reverse: 0, listening: 0, fill: 1, type: 2, order: 2, dictation: 2 };
function interleaveByLine(list, prevLineIdx) {
  var groups = {}, order = [];
  list.forEach(function (q) {
    var k = String(q.lineIdx);
    if (!groups[k]) { groups[k] = []; order.push(k); }
    groups[k].push(q);
  });
  var out = [], last = prevLineIdx, remaining = list.length;
  while (remaining > 0) {
    var bestKey = null, bestLen = -1;
    order.forEach(function (k) {
      var len = groups[k].length;
      if (!len) return;
      if (Number(k) === last) return;
      if (len > bestLen) { bestLen = len; bestKey = k; }
    });
    if (bestKey === null) { /* 避けられない場合だけ同じ行を続ける */
      order.forEach(function (k) { if (groups[k].length && bestKey === null) bestKey = k; });
    }
    out.push(groups[bestKey].shift());
    last = Number(bestKey);
    remaining--;
  }
  return out;
}
function arrangeArc(list) {
  var blocks = [[], [], []];
  list.forEach(function (q) { blocks[FORMAT_PHASE[q.type]].push(q); });
  var out = [], prev = null;
  blocks.forEach(function (b) {
    var a = interleaveByLine(b, prev);
    if (a.length) prev = a[a.length - 1].lineIdx;
    out = out.concat(a);
  });
  return out;
}

/* エピソードから1セッション分（目安10問）を作る */
function genEpisodeQuiz(ep, targetLen) {
  targetLen = targetLen || QUIZ_LEN;
  var candByPhase = [[], [], []];
  ep.lines.forEach(function (ln, idx) {
    QUIZ_FORMATS.forEach(function (f) {
      var q = makeQuestion(ep, idx, f);
      if (q) candByPhase[FORMAT_PHASE[f]].push(q);
    });
  });
  function selectFrom(cands, already, perFormatCap, perLineCap, limit) {
    var perFormat = {}, perLine = {}, chosen = [];
    already.forEach(function (q) {
      perFormat[q.type] = (perFormat[q.type] || 0) + 1;
      perLine[q.lineIdx] = (perLine[q.lineIdx] || 0) + 1;
    });
    shuffle(cands).forEach(function (q) {
      if (already.length + chosen.length >= targetLen) return;
      if (chosen.length >= limit) return;
      if ((perFormat[q.type] || 0) >= perFormatCap) return;
      if ((perLine[q.lineIdx] || 0) >= perLineCap) return;
      perFormat[q.type] = (perFormat[q.type] || 0) + 1;
      perLine[q.lineIdx] = (perLine[q.lineIdx] || 0) + 1;
      chosen.push(q);
    });
    return chosen;
  }
  /* 段階ごとに枠を確保する（前段だけで枠が埋まると、入力形式まで回らないため） */
  var phaseLimits = [4, 3, targetLen];
  var pickedSoFar = [];
  var ph;
  for (ph = 0; ph < 3; ph++) {
    pickedSoFar = pickedSoFar.concat(selectFrom(candByPhase[ph], pickedSoFar, 3, 2, phaseLimits[ph]));
  }
  for (ph = 0; ph < 3; ph++) {
    if (pickedSoFar.length >= targetLen) break;
    var rest = candByPhase[ph].filter(function (q) { return pickedSoFar.indexOf(q) < 0; });
    pickedSoFar = pickedSoFar.concat(selectFrom(rest, pickedSoFar, 99, 3, targetLen));
  }
  return arrangeArc(pickedSoFar).slice(0, targetLen);
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
  return arrangeArc(picked);
}

/* ---------- 表示の部品 ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function statusBadge(ls) {
  var h;
  if (ls.status === 'ok') h = '<span class="badge ok">できた</span>';
  else if (ls.status === 'mada') h = '<span class="badge mada">まだ</span>';
  else h = '<span class="badge">未記録</span>';
  if (ls.graduated) h += ' <span class="badge grad">🎓卒業</span>';
  return h;
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
  h += '<span class="tx" dir="auto">' + lineGlossHtml(ep, idx) + '</span> ' + speakBtn(ep.id, idx);
  if (ln.ja) h += '<div class="ja">' + esc(ln.ja) + '</div>';
  return h;
}

/* ---------- v4：単語グロス（押すと意味が出る） ---------- */
/* line.gloss = [{t, r, ja}, ...]。t を全部つなぐと行の文と一致する（道具側でも検証する）。
 * r は読み（ギリシャ語・アラビア語・韓国語・ロシア語はカナ、中国語は pinyin）、
 * ja はその語・区切りの短い意味。gloss の無い行は今まで通りただの文字として出す。 */
function validateGloss(text, gloss) {
  if (!Array.isArray(gloss)) return false;
  var joined = '';
  for (var i = 0; i < gloss.length; i++) {
    var seg = gloss[i];
    if (!seg || typeof seg.t !== 'string') return false;
    joined += seg.t;
  }
  return joined === text;
}
function glossSegHtml(seg) {
  if (!seg.ja && !seg.r) return esc(seg.t);
  return '<span class="gloss-word" data-act="gloss" data-w="' + esc(seg.t.trim()) + '" data-r="' +
    esc(seg.r || '') + '" data-ja="' + esc(seg.ja || '') + '">' + esc(seg.t) + '</span>';
}
/* 行全体をグロス可能に描く（本棚・表現帳・フィードバック用） */
function lineGlossHtml(ep, idx) {
  var ln = ep.lines[idx];
  if (!ln.gloss || !ln.gloss.length || !validateGloss(ln.text, ln.gloss)) return esc(ln.text);
  return ln.gloss.map(glossSegHtml).join('');
}
/* 穴埋め・入力形式の出題中：狙いの語を含むセグメントだけ伏せ（グロス不可）、
 * それ以外はグロス可能にする。狙いの語がセグメント内に無ければ null を返し、
 * 呼び出し側は平文で出す。答えの選択肢にはグロスを付けない（答えが漏れるため）。 */
function clozeGlossHtml(ep, idx, word) {
  var ln = ep.lines[idx];
  if (!ln.gloss || !ln.gloss.length || !validateGloss(ln.text, ln.gloss)) return null;
  var done = false;
  var html = ln.gloss.map(function (seg) {
    if (!done && word && seg.t.indexOf(word) >= 0) {
      done = true;
      return esc(seg.t.replace(word, '＿＿＿'));
    }
    return glossSegHtml(seg);
  }).join('');
  return done ? html : null;
}
function glossPopHtml(w, r, ja) {
  return '<div class="gp-word" dir="auto">' + esc(w) + '</div>' +
    (r ? '<div class="gp-reading">' + esc(r) + '</div>' : '') +
    (ja ? '<div class="gp-ja">' + esc(ja) + '</div>' : '');
}
var glossPopEl = null;
var glossPressAt = 0;
var glossLastSpan = null;
function ensureGlossPop() {
  if (!glossPopEl) {
    glossPopEl = document.createElement('div');
    glossPopEl.id = 'gloss-pop';
    glossPopEl.className = 'gloss-pop';
    glossPopEl.hidden = true;
    document.body.appendChild(glossPopEl);
  }
  return glossPopEl;
}
function showGlossPop(span) {
  var pop = ensureGlossPop();
  pop.innerHTML = glossPopHtml(span.getAttribute('data-w'), span.getAttribute('data-r'), span.getAttribute('data-ja'));
  pop.hidden = false;
  glossLastSpan = span;
  var rect = span.getBoundingClientRect();
  pop.style.left = Math.max(8, rect.left + (window.scrollX || 0)) + 'px';
  pop.style.top = (rect.bottom + (window.scrollY || 0) + 6) + 'px';
}
function hideGlossPop() {
  if (glossPopEl) glossPopEl.hidden = true;
  glossLastSpan = null;
}
document.addEventListener('pointerdown', function (ev) {
  var span = ev.target && ev.target.closest ? ev.target.closest('.gloss-word') : null;
  if (span) {
    if (glossPopEl && !glossPopEl.hidden && glossLastSpan === span) { hideGlossPop(); return; }
    glossPressAt = Date.now();
    showGlossPop(span);
    return;
  }
  var inPop = ev.target && ev.target.closest ? ev.target.closest('#gloss-pop') : null;
  if (!inPop) hideGlossPop();
});
document.addEventListener('pointerup', function () {
  if (!glossPopEl || glossPopEl.hidden) return;
  /* 長押しは離したら消す。短いタップはトグルとして残し、次のタップで消える */
  if (Date.now() - glossPressAt >= 350) hideGlossPop();
});

/* ---------- 1. 今日の復習キュー ---------- */
function renderQueue() {
  var today = todayStr();
  var items = buildQueue(today);
  var box = document.getElementById('queue-list');
  var html = mixedSectionHtml(today);
  if (items.length === 0) {
    var nx = nextDueLabel(today);
    html += '<div class="empty">今日の期日分は終わりです。お疲れさま。<br>' + esc(nx) + '</div>';
    box.innerHTML = html;
    return;
  }
  var shown = items.slice(0, QUEUE_CAP);
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
    } else if (it.kind === 'tail') {
      html += '<div class="qitem">' +
        '<span class="reason tail">' + esc(it.reason) + '（' + fmtFull(it.tailDate) + 'の分）</span>' +
        '<div class="q-title">' + esc(ep.langName) + '「' + esc(ep.title) + '」</div>' +
        '<div class="q-text">' + lineTextHtml(ep, it.lineIdx) + '</div>' +
        '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-weak" data-ep="' +
          esc(it.epId) + '" data-idx="' + it.lineIdx + '">クイズで復習</button></div>' +
        '<div class="q-meta">「できた」から' + (it.stage === 14 ? '14日' : '30日') + 'の確認です。できれば卒業に近づきます。自分で言えたかチェックしたい時は、こちらでも記録できます。</div>' +
        markButtons('line-mark', 'data-ep="' + esc(it.epId) + '" data-idx="' + it.lineIdx + '"') +
        '</div>';
    } else {
      var dueText = it.kind === 'prep'
        ? 'テストは ' + fmtFull(it.due)
        : '期日：' + fmtFull(it.due) + (it.due < today ? '（過ぎています）' : '');
      html += '<div class="qitem">' +
        '<span class="reason">' + esc(it.reason) + '</span>' +
        '<div class="q-title">' + esc(ep.langName) + '「' + esc(ep.title) + '」</div>' +
        '<div class="q-meta">場面：' + esc(ep.scene) + '／全' + ep.lines.length + '行／' + dueText + '</div>' +
        '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-mixed" data-lang="' +
          esc(ep.lang) + '">' + esc(ep.langName) + 'のミックス復習で解く</button></div>' +
        '<div class="q-meta">この回の行は、上のミックス復習の中に混ざって出ます。自己申告で記録する場合はこちら。</div>' +
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
      if (canLesson(ep)) badges += ' <span class="badge done">レッスン可</span>';
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
    esc(ep.id) + '" data-kind="free">自由練習（この回のクイズ）</button></div>';
  html += '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-match" data-ep="' +
    esc(ep.id) + '">ペア合わせ</button></div>';
  var blockReason = lessonBlockReason(ep);
  if (!blockReason) {
    html += '<div class="q-actions"><button type="button" class="quiz-btn lsn-btn" data-act="lesson-ep" data-ep="' +
      esc(ep.id) + '">🎮 レッスン（Duolingo式・約10問）</button></div>';
  } else {
    html += '<p class="hint">🎮 レッスン：' + esc(blockReason) + '。</p>';
  }
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
    answered: false, picked: [], perQ: []
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
    answered: false, picked: [], perQ: []
  };
  showQuiz();
}
function showQuiz() {
  stopSpeak();
  matchGame = null;
  lesson = null;
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
  matchGame = null;
  lesson = null;
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
  hideGlossPop();
  var box = document.getElementById('quiz-box');
  if (!quiz) { box.innerHTML = ''; return; }
  if (quiz.idx >= quiz.questions.length) { renderQuizSummary(box); return; }
  var q = quiz.questions[quiz.idx];
  var ep = EP_BY_ID[q.epId];
  var html = quizHeadHtml();
  if (q.type === 'meaning') {
    html += '<div class="q-kind">意味当て：この文の意味は？</div>' +
      '<div class="q-prompt"><span dir="auto">' + lineGlossHtml(ep, q.lineIdx) + '</span> ' + speakBtn(q.epId, q.lineIdx) + '</div>' +
      optionsHtml(q);
  } else if (q.type === 'reverse') {
    html += '<div class="q-kind">逆向き：この意味の文はどれ？</div>' +
      '<div class="q-prompt">' + esc(q.ja) + '</div>' + optionsHtml(q);
  } else if (q.type === 'fill') {
    html += '<div class="q-kind">穴埋め：＿＿＿に入る言葉は？</div>' +
      '<div class="q-prompt"><span dir="auto">' + (clozeGlossHtml(ep, q.lineIdx, q.word) || esc(q.sentence)) + '</span></div>' +
      (q.ja ? '<div class="q-ja">意味：' + esc(q.ja) + '</div>' : '') + optionsHtml(q);
  } else if (q.type === 'listening') {
    html += '<div class="q-kind">聞き取り：音声を聞いて、言った文を選んでください</div>' +
      '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-listen">🔊 聞く</button></div>' +
      optionsHtml(q);
  } else if (q.type === 'type') {
    html += '<div class="q-kind">入力：＿＿＿に入る言葉を打ってください</div>' +
      '<div class="q-prompt"><span dir="auto">' + (clozeGlossHtml(ep, q.lineIdx, q.word) || esc(q.sentence)) + '</span></div>' +
      '<input type="text" id="type-input" class="type-input" dir="auto" lang="' + esc(ep.lang) + '" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ここに打つ">' +
      (q.ja ? '<div class="q-actions"><button type="button" class="back-btn" data-act="quiz-hint">意味のヒントを見る</button></div>' +
        '<div class="q-ja" id="type-hint" hidden>意味：' + esc(q.ja) + '</div>' : '') +
      '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-type-check">答える</button></div>' +
      '<div class="q-actions"><button type="button" class="back-btn" data-act="quiz-giveup">分からない（答えを見る）</button></div>';
  } else if (q.type === 'dictation') {
    html += '<div class="q-kind">聞いて打つ：音声を聞いて、聞こえた文をそのまま打ってください</div>' +
      '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-dict-play">🔊 聞く</button></div>' +
      '<input type="text" id="dict-input" class="type-input" dir="auto" lang="' + esc(ep.lang) + '" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="聞こえた文をここに打つ">' +
      (q.ja ? '<div class="q-actions"><button type="button" class="back-btn" data-act="quiz-hint">意味のヒントを見る</button></div>' +
        '<div class="q-ja" id="type-hint" hidden>意味：' + esc(q.ja) + '</div>' : '') +
      '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-dict-check">答える</button></div>' +
      '<div class="q-actions"><button type="button" class="back-btn" data-act="quiz-dict-giveup">分からない（答えを見る）</button></div>';
  } else if (q.type === 'order') {
    html += '<div class="q-kind">並べ替え：言葉を正しい順にタップしてください（余分な言葉が混ざっています。全部使う必要はありません）</div>' +
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
  if (!quiz.tiles) quiz.tiles = buildTiles(q);
  var poolBox = document.getElementById('order-pool');
  var ansBox = document.getElementById('order-answer');
  var poolHtml = '';
  quiz.tiles.forEach(function (tile, i) {
    if (quiz.picked.indexOf(i) >= 0) return;
    poolHtml += '<button type="button" class="chip" data-act="chip-pick" data-i="' + i + '">' + esc(tile.t) + '</button>';
  });
  poolBox.innerHTML = poolHtml || '<span class="hint">全部置きました</span>';
  var ansHtml = '';
  quiz.picked.forEach(function (pi) {
    ansHtml += '<button type="button" class="chip placed" data-act="chip-unpick" data-pos="' + quiz.picked.indexOf(pi) + '">' +
      esc(quiz.tiles[pi].t) + '</button>';
  });
  ansBox.innerHTML = ansHtml || '<span class="hint">ここに文が組み上がります（余分な言葉は置かなくてOK）</span>';
  var btn = document.getElementById('order-check');
  if (btn) btn.disabled = quiz.answered || countAnswerTiles(quiz.tiles, quiz.picked) !== q.tokens.length;
}
/* 採点して記録する。戻り値：正解かどうか。
 * 入力形式で正解した行は「2倍の進み」として typedOk に印を残す。 */
function gradeCurrent(isCorrect) {
  var q = quiz.questions[quiz.idx];
  applyLineMark(q.epId, q.lineIdx, isCorrect ? 'ok' : 'mada', null);
  if (isCorrect) {
    quiz.correctCount++;
    if (q.type === 'type' || q.type === 'dictation') {
      var ls = lineState(lineKey(q.epId, q.lineIdx));
      ls.typedOk = (ls.typedOk || 0) + 1;
      saveState();
    }
  }
  if (quiz.perQ) quiz.perQ.push({ epId: q.epId, lineIdx: q.lineIdx, correct: isCorrect });
  quiz.answered = true;
  return isCorrect;
}
function correctAnswerText(q) {
  if (q.type === 'meaning' || q.type === 'reverse' || q.type === 'listening') return q.options[q.correct];
  if (q.type === 'fill' || q.type === 'type') return q.word;
  if (q.type === 'dictation') return q.text;
  if (q.type === 'order') {
    var ep = EP_BY_ID[q.epId];
    return ep.lines[q.lineIdx].text;
  }
  return '';
}
/* v5：卒業テール／卒業の進み具合をフィードバックに添える（採点直後の状態を見る） */
function tailNote(q) {
  var ls = peekLine(lineKey(q.epId, q.lineIdx));
  if (ls.graduated) return ' 🎓 この行は卒業しました！';
  if (ls.tail) {
    return ls.tail.passed14
      ? ' 卒業チェック 1/2 通過（残りは30日後の確認です）。'
      : ' 卒業チェックは14日後と30日後にあります。';
  }
  return '';
}
/* フィードバックは全形式で必ず：正解＋元の文＋和訳＋音声ボタン（研究の生成ルール9） */
function feedbackHtml(isCorrect, q, opts) {
  opts = opts || {};
  var ep = EP_BY_ID[q.epId];
  var ln = ep.lines[q.lineIdx];
  var html = '<div class="feedback ' + (isCorrect ? 'good' : 'bad') + '">';
  if (opts.close) {
    html += '<div class="fb-msg">惜しい！正解として記録します</div>' +
      '<div class="fb-answer">正しいつづり：<span dir="auto">' + esc(q.word || q.text) + '</span></div>' +
      (opts.yours ? '<div class="q-meta">あなたの入力：<span dir="auto">' + esc(opts.yours) + '</span></div>' : '');
  } else {
    html += '<div class="fb-msg">' + (isCorrect ? '正解！' : '残念。') + '</div>' +
      '<div class="fb-answer">正解：<span dir="auto">' + esc(correctAnswerText(q)) + '</span></div>';
  }
  html += '<div class="fb-line"><span dir="auto">' + lineGlossHtml(ep, q.lineIdx) + '</span> ' + speakBtn(q.epId, q.lineIdx) +
    (ln.ja ? '<div class="ja">' + esc(ln.ja) + '</div>' : '') + '</div>' +
    /* ミックス復習では、答えた後にだけ「どの回の行か」を出す（記憶の結び直し用） */
    (quiz && quiz.kind === 'mixed'
      ? '<div class="q-meta">この行は ' + esc(ep.langName) + '「' + esc(ep.title) + '」から出ました。</div>' : '') +
    '<div class="q-meta">' + (isCorrect
      ? 'この行は「できた」で記録しました。' + ((q.type === 'type' || q.type === 'dictation') ? '（入力形式で言えたので2倍の進みです）' : '') + tailNote(q)
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
  if (q.type !== 'order' || !quiz.tiles) return;
  if (countAnswerTiles(quiz.tiles, quiz.picked) !== q.tokens.length) return;
  var isCorrect = checkOrder(q, quiz.tiles, quiz.picked);
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
  if (quiz.kind === 'mixed') {
    /* ミックス復習の回完了ルール：セッション自体は回の完了にならない。
     * ただし「今日が期日の回」から3行以上出て、その半分以上を正解したら、
     * その回のおさらい／テストを完了として記録する。満たさなければ期日のまま残る。 */
    var today = todayStr();
    var byEp = {};
    (quiz.perQ || []).forEach(function (r) {
      if (!byEp[r.epId]) byEp[r.epId] = { n: 0, ok: 0 };
      byEp[r.epId].n++;
      if (r.correct) byEp[r.epId].ok++;
    });
    var doneNames = [];
    Object.keys(byEp).forEach(function (epId) {
      var ep = EP_BY_ID[epId];
      if (!ep) return;
      var kind = episodeDueKind(ep, today);
      if (!kind) return;
      var s = byEp[epId];
      if (s.n >= 3 && s.ok * 2 >= s.n) {
        applyEpisodeMark(kind, epId, 'ok');
        doneNames.push(ep.langName + '「' + ep.title + '」の' + (kind === 'test' ? 'テスト' : 'おさらい'));
      }
    });
    if (doneNames.length) {
      html += '<p>期日の回を完了として記録しました：' + doneNames.map(esc).join('、') + '</p>';
    } else {
      html += '<p class="hint">期日の回の完了条件（その回から3行以上・半分以上正解）には届かなかったので、期日の回はそのまま残ります。</p>';
    }
  }
  if (quiz.correctCount < total) {
    html += '<p class="hint">間違えた行は「まだ」で記録され、明日と3日後に弱い行として先に出ます。</p>';
  }
  html += '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-done">キューに戻る</button></div></div>';
  box.innerHTML = html;
}

/* ---------- v4：言語ミックス復習（今日の復習の本筋） ---------- */
/* 考え方：回ごとに閉じたクイズでは「何が出るか分かっている」ため、本当の確認にならない。
 * そこで今日の復習は「言語だけ選ぶ」形にする。選んだ言語の本棚ぜんぶの行から、
 * 何が出るか分からないように混ぜて出す。できた行も確認のために混ぜる。 */
/* エピソードが今日「おさらい／テスト」の期日かどうか（予習は含めない） */
function episodeDueKind(ep, today) {
  var es = state.eps[ep.id] || {};
  if (!es.recap && recapDue(ep) <= today) return 'recap';
  if (es.recap && !es.test && testDue(ep) <= today) return 'test';
  return null;
}
/* 行のプール分け：期日の分（期日が来た回の行＋弱い行の早出し分＋卒業チェック分）／できた行／その他の行。
 * 1行は1つのプールにだけ入る（優先順位：期日＞できた＞その他）。 */
function classifyLangLines(lang, today) {
  var pools = { due: [], done: [], other: [] };
  EPISODES.forEach(function (ep) {
    if (lang !== 'all' && ep.lang !== lang) return;
    var epDue = !!episodeDueKind(ep, today);
    ep.lines.forEach(function (ln, idx) {
      var ls = peekLine(lineKey(ep.id, idx));
      var weakDue = (ls.weak || []).some(function (w) { return !w.done && w.d <= today; });
      var tailD = !!tailDue(ls, today);
      var entry = { ep: ep, idx: idx };
      if (epDue || weakDue || tailD) pools.due.push(entry);
      else if (ls.status === 'ok') pools.done.push(entry);
      else pools.other.push(entry);
    });
  });
  return pools;
}
/* v5：ロマンス語群（類似度ルールの対象）と、1セッションに登場する言語の上限 */
var ROMANCE_LANGS = { it: 1, fr: 1, pt: 1, la: 1 };
var MAX_SESSION_LANGS = 5;
/* 混ぜ方の目安：期日の分 約50%／できた行の確認 約30%／その他 約20%。
 * プールが足りない分は、残りのプールから比例的に回して埋める。同じ行は1回だけ。 */
function genMixedQuiz(lang, targetLen) {
  targetLen = targetLen || 12;
  var today = todayStr();
  var pools = classifyLangLines(lang, today);
  var quotas = [
    { pool: pools.due, n: Math.round(targetLen * 0.5) },
    { pool: pools.done, n: Math.round(targetLen * 0.3) },
    { pool: pools.other, n: 0 }
  ];
  quotas[2].n = targetLen - quotas[0].n - quotas[1].n;
  quotas.forEach(function (q) { q.pool = shuffle(q.pool); });
  /* v5：類似度ルール（言語を混ぜるセッション＝lang 'all' の時だけ効く）。
   * 干渉が一番強いのは似た言語同士なので、ロマンス語群からは1セッションに1言語だけ。
   * 登場する言語の数も最大5つまでに抑える（1言語あたりの分量が薄くならないように）。
   * 1言語だけのセッションでは今まで通り（ルールは発動しない）。 */
  var selected = [];
  var usedLangs = {};
  var romanceUsed = null;
  function canPick(entry) {
    if (lang !== 'all') return true;
    var L = entry.ep.lang;
    if (ROMANCE_LANGS[L] && romanceUsed && romanceUsed !== L) return false;
    if (!usedLangs[L] && Object.keys(usedLangs).length >= MAX_SESSION_LANGS) return false;
    return true;
  }
  function doPick(entry) {
    usedLangs[entry.ep.lang] = 1;
    if (ROMANCE_LANGS[entry.ep.lang]) romanceUsed = entry.ep.lang;
    selected.push(entry);
  }
  quotas.forEach(function (q) {
    var need = q.n;
    var rest = [];
    q.pool.forEach(function (entry) {
      if (need > 0 && canPick(entry)) { doPick(entry); need--; }
      else rest.push(entry);
    });
    q.pool = rest;
  });
  /* 足りない分は残っているプールから（期日→できた→その他の順に）埋める */
  quotas.forEach(function (q) {
    var i = 0;
    while (selected.length < targetLen && i < q.pool.length) {
      var entry = q.pool[i++];
      if (canPick(entry)) doPick(entry);
    }
  });
  if (!selected.length) return [];
  /* 形式の割り当て：前半は見て分かる形式、中盤は穴埋め、後半は入力／並べ替えを優先。
   * 作れない形式は他の形式で代替し、最後に段階順へ並べ直す（arrangeArc）。 */
  selected = shuffle(selected);
  var n1 = Math.ceil(selected.length * 0.4);
  var n2 = Math.ceil(selected.length * 0.3);
  var questions = [];
  selected.forEach(function (entry, i) {
    var pref = i < n1 ? ['meaning', 'reverse', 'listening']
      : (i < n1 + n2 ? ['fill'] : ['type', 'order', 'dictation']);
    var tries = shuffle(pref).concat(shuffle(QUIZ_FORMATS.filter(function (f) { return pref.indexOf(f) < 0; })));
    for (var k = 0; k < tries.length; k++) {
      var q = makeQuestion(entry.ep, entry.idx, tries[k]);
      if (q) { questions.push(q); break; }
    }
  });
  return arrangeArc(questions);
}
function startMixedQuiz(lang) {
  var qs = genMixedQuiz(lang, 12);
  if (!qs.length) return;
  var name = '全言語';
  if (lang !== 'all') {
    var ep0 = EPISODES.filter(function (e) { return e.lang === lang; })[0];
    if (ep0) name = ep0.langName;
  }
  quiz = {
    title: name + ' ミックス復習',
    kind: 'mixed', lang: lang, epId: null, questions: qs, idx: 0, correctCount: 0,
    answered: false, picked: [], perQ: []
  };
  showQuiz();
}
/* 言語ごとの件数（キューのボタン表示用） */
function langDueCounts(lang, today) {
  var dueEps = 0, weakLines = 0;
  EPISODES.forEach(function (ep) {
    if (ep.lang !== lang) return;
    if (episodeDueKind(ep, today)) dueEps++;
  });
  Object.keys(state.lines).forEach(function (key) {
    var ep = EP_BY_ID[key.split('#')[0]];
    if (!ep || ep.lang !== lang) return;
    var ls = state.lines[key];
    if ((ls.weak || []).some(function (w) { return !w.done && w.d <= today; })) weakLines++;
  });
  return { dueEps: dueEps, weakLines: weakLines };
}
function mixedSectionHtml(today) {
  var langs = [];
  LANG_ORDER.forEach(function (lang) {
    if (EPISODES.some(function (e) { return e.lang === lang; })) langs.push(lang);
  });
  EPISODES.forEach(function (ep) { if (langs.indexOf(ep.lang) < 0) langs.push(ep.lang); });
  var html = '<div class="qitem">' +
    '<div class="q-title">言語を選んでミックス復習</div>' +
    '<div class="q-meta">その言語の本棚ぜんぶから、期日の分・弱い行・「できた」行の確認が混ざって約12問出ます。どの回から出るかは、答えるまで分かりません。</div>';
  langs.forEach(function (lang) {
    var ep0 = EPISODES.filter(function (e) { return e.lang === lang; })[0];
    var c = langDueCounts(lang, today);
    html += '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-mixed" data-lang="' +
      esc(lang) + '">' + esc(ep0.langName) + '（期日 ' + c.dueEps + ' 回／弱い行 ' + c.weakLines + ' 件）</button></div>';
    if (EPISODES.some(function (e) { return e.lang === lang && canLesson(e); })) {
      html += '<div class="q-actions"><button type="button" class="quiz-btn lsn-btn" data-act="lesson-lang" data-lang="' +
        esc(lang) + '">' + esc(ep0.langName) + 'のレッスン（Duolingo式・約10問）</button></div>';
    }
  });
  html += '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-mixed" data-lang="all">全言語ミックス</button></div></div>';
  return html;
}

/* ---------- v4：入力形式の回答 ---------- */
function answerTyped() {
  if (!quiz || quiz.answered) return;
  var q = quiz.questions[quiz.idx];
  if (q.type !== 'type') return;
  var input = document.getElementById('type-input');
  var val = input ? input.value : '';
  var g = gradeTyped(val, q.word, EP_BY_ID[q.epId].lang);
  if (g.result === 'empty') { if (input) input.focus(); return; }
  var isCorrect = (g.result === 'exact' || g.result === 'close');
  gradeCurrent(isCorrect);
  if (input) input.disabled = true;
  document.getElementById('quiz-feedback').innerHTML =
    feedbackHtml(isCorrect, q, { close: g.result === 'close', yours: val });
}
function answerGiveUp() {
  if (!quiz || quiz.answered) return;
  var q = quiz.questions[quiz.idx];
  if (q.type !== 'type') return;
  gradeCurrent(false);
  var input = document.getElementById('type-input');
  if (input) input.disabled = true;
  document.getElementById('quiz-feedback').innerHTML = feedbackHtml(false, q);
}

/* ---------- v5：聞いて打つの回答（文全体を打つ。採点は入力形式と同じ gradeTyped） ---------- */
function answerDictation() {
  if (!quiz || quiz.answered) return;
  var q = quiz.questions[quiz.idx];
  if (q.type !== 'dictation') return;
  var input = document.getElementById('dict-input');
  var val = input ? input.value : '';
  var g = gradeTyped(val, q.text, EP_BY_ID[q.epId].lang);
  if (g.result === 'empty') { if (input) input.focus(); return; }
  var isCorrect = (g.result === 'exact' || g.result === 'close');
  gradeCurrent(isCorrect);
  if (input) input.disabled = true;
  document.getElementById('quiz-feedback').innerHTML =
    feedbackHtml(isCorrect, q, { close: g.result === 'close', yours: val });
}
function answerDictationGiveUp() {
  if (!quiz || quiz.answered) return;
  var q = quiz.questions[quiz.idx];
  if (q.type !== 'dictation') return;
  gradeCurrent(false);
  var input = document.getElementById('dict-input');
  if (input) input.disabled = true;
  document.getElementById('quiz-feedback').innerHTML = feedbackHtml(false, q);
}

/* ---------- v4：ペア合わせ ---------- */
var matchGame = null; // {epId, pairs, left, right, matched, mistakes, selL, selR, wrongL, wrongR}
function genMatching(ep, n) {
  n = n || 6;
  var seenT = {}, seenJ = {}, cand = [];
  ep.lines.forEach(function (ln, idx) {
    if (!ln.ja) return;
    var kt = normalizeAnswer(ln.text, ep.lang);
    var kj = normalizeAnswer(ln.ja, 'ja');
    if (!kt || !kj || seenT[kt] || seenJ[kj]) return;
    seenT[kt] = 1; seenJ[kj] = 1;
    cand.push({ lineIdx: idx, text: ln.text, ja: ln.ja });
  });
  cand = shuffle(cand).slice(0, n);
  if (cand.length < 3) return null;
  return cand;
}
function startMatching(epId) {
  var ep = EP_BY_ID[epId];
  if (!ep) return;
  var pairs = genMatching(ep);
  if (!pairs) return;
  matchGame = {
    epId: epId, pairs: pairs,
    left: shuffle(pairs.map(function (p) { return p.lineIdx; })),
    right: shuffle(pairs.map(function (p) { return p.lineIdx; })),
    matched: {}, mistakes: 0, selL: null, selR: null, wrongL: null, wrongR: null
  };
  quiz = null;
  lesson = null;
  showMatch();
}
function showMatch() {
  stopSpeak();
  ['queue', 'shelf', 'phrases'].forEach(function (t) {
    document.getElementById('view-' + t).hidden = true;
  });
  document.getElementById('view-quiz').hidden = false;
  document.querySelectorAll('.tabbar .tab').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === 'shelf');
  });
  window.scrollTo(0, 0);
  renderMatch();
}
function renderMatch() {
  var box = document.getElementById('quiz-box');
  if (!matchGame) { box.innerHTML = ''; return; }
  var ep = EP_BY_ID[matchGame.epId];
  var doneCount = Object.keys(matchGame.matched).length;
  if (doneCount >= matchGame.pairs.length) { renderMatchSummary(box); return; }
  var byIdx = {};
  matchGame.pairs.forEach(function (p) { byIdx[p.lineIdx] = p; });
  var html = '<div class="quiz-head"><span>ペア合わせ ' + doneCount + ' / ' + matchGame.pairs.length + '</span>' +
    '<span>ミス ' + matchGame.mistakes + '</span>' +
    '<button type="button" class="quiz-quit" data-act="quiz-done">やめる</button></div>' +
    '<div class="quiz-title">' + esc(ep.langName) + '「' + esc(ep.title) + '」</div>' +
    '<div class="q-kind">文と意味のペアをタップで合わせてください</div>' +
    '<div class="match-cols"><div class="match-col">';
  matchGame.left.forEach(function (idx) {
    var cls = 'match-btn';
    if (matchGame.matched[idx]) cls += ' matched';
    else if (matchGame.selL === idx) cls += ' selected';
    else if (matchGame.wrongL === idx) cls += ' wrong';
    html += '<button type="button" class="' + cls + '" data-act="match-left" data-idx="' + idx + '"' +
      (matchGame.matched[idx] ? ' disabled' : '') + '><span dir="auto">' + esc(byIdx[idx].text) + '</span></button>';
  });
  html += '</div><div class="match-col">';
  matchGame.right.forEach(function (idx) {
    var cls = 'match-btn';
    if (matchGame.matched[idx]) cls += ' matched';
    else if (matchGame.selR === idx) cls += ' selected';
    else if (matchGame.wrongR === idx) cls += ' wrong';
    html += '<button type="button" class="' + cls + '" data-act="match-right" data-idx="' + idx + '"' +
      (matchGame.matched[idx] ? ' disabled' : '') + '>' + esc(byIdx[idx].ja) + '</button>';
  });
  html += '</div></div>';
  box.innerHTML = html;
}
function matchPick(side, idx) {
  if (!matchGame || matchGame.matched[idx]) return;
  matchGame.wrongL = null; matchGame.wrongR = null;
  if (side === 'L') matchGame.selL = idx; else matchGame.selR = idx;
  if (matchGame.selL !== null && matchGame.selR !== null) {
    if (matchGame.selL === matchGame.selR) {
      matchGame.matched[matchGame.selL] = true;
      /* 合ったペアの行は、4択の正解と同じく「できた」側へ進める */
      applyLineMark(matchGame.epId, matchGame.selL, 'ok', null);
    } else {
      /* 外したペアはミス回数だけ数える（行を「まだ」にはしない） */
      matchGame.mistakes++;
      matchGame.wrongL = matchGame.selL;
      matchGame.wrongR = matchGame.selR;
    }
    matchGame.selL = null; matchGame.selR = null;
  }
  renderMatch();
}
function renderMatchSummary(box) {
  var ep = EP_BY_ID[matchGame.epId];
  var html = '<div class="card"><h3>ペア合わせ結果</h3>' +
    '<p class="quiz-score">' + matchGame.pairs.length + ' ペア完成</p>' +
    '<p>ミスは ' + matchGame.mistakes + ' 回でした。合わせられた行は「できた」で記録しました。</p>' +
    '<p class="hint">' + esc(ep.langName) + '「' + esc(ep.title) + '」</p>' +
    '<div class="q-actions"><button type="button" class="quiz-btn" data-act="quiz-done">戻る</button></div></div>';
  box.innerHTML = html;
}

/* ---------- v7：Duolingo式レッスン ----------
 * 1回（または1言語の回の束）から約10問のレッスンを組む。形式は5つ：
 *   pairs  ペア合わせ（単語⇔読み。読みの無い言語では単語⇔日本語訳）
 *   spell  文字クイズ（読みを見て、正しい綴りを4択から選ぶ。読みのある言語だけ）
 *   hear   聞いて選ぶ（音声を聞いて、言った文を4択から選ぶ）
 *   horder 聞いて並べる（音声を聞いて、単語タイルで文を組み立てる）
 *   torder 訳して並べる（日本語を見て、外国語の単語タイルで文を組み立てる）
 * 作法：1問ずつ表示、上に進捗バー、下に大きな CHECK ボタン。押すとその場で
 * 正誤＋正解の全文が出る。結果は既存の行の記録（applyLineMark＝「できた／まだ」
 * ＋弱い行フロー＋卒業テール）へ反映する。新しい保存場所は作らない。
 * 音声：行の音声区間（timing）がある行は ep.audio の区間再生、無い行は端末TTS
 * （聞き取り形式と同じ代用。ディクテーション本体の DICTATION_ENABLED には触らない）。
 * 対象外の回：日本語シリーズ（侍言葉）と、4行未満の回（アラビア語ワンフレーズ等）。
 * 入口（回の詳細）で理由が分かるように表示する。 */
var LESSON_LEN = 10;
var lesson = null; // {kind, epId, lang, title, origin, questions, idx, score, answered, lastOk, sel, picked, tiles, hintOn, pair, pairMistakes}

/* レッスンが組める回かどうか。組めない場合は理由の文を返す */
function lessonBlockReason(ep) {
  if (ep.lang === 'ja') return '日本語シリーズのためレッスン対象外です';
  if (ep.lines.length < 4) return '行数が少ないためレッスン対象外です';
  if (epWords(ep).length < 5) return '単語データが少ないためレッスン対象外です';
  return null;
}
function canLesson(ep) { return lessonBlockReason(ep) === null; }

/* 回のグロスから単語の一覧を作る（行と対応づけて重複を除く）。
 * グロスが文と一致する行だけを使う（validateGloss）。 */
function epWords(ep) {
  var out = [], seen = {};
  ep.lines.forEach(function (ln, idx) {
    if (!ln.gloss || !validateGloss(ln.text, ln.gloss)) return;
    ln.gloss.forEach(function (seg) {
      var w = cleanWord(seg.t || '');
      if (w.length < 2) return;
      var key = normalizeAnswer(w, ep.lang);
      if (!key || seen[key]) return;
      seen[key] = 1;
      out.push({ epId: ep.id, lineIdx: idx, word: w, reading: (seg.r || '').trim(), ja: (seg.ja || '').trim() });
    });
  });
  return out;
}
/* 単語プール全体で「読み」が十分にあるか（ペア合わせの面と文字クイズの可否） */
function poolUseReading(words) {
  if (words.length < 5) return false;
  var n = words.filter(function (w) { return !!w.reading; }).length;
  return n >= Math.max(3, Math.ceil(words.length * 0.3));
}
/* 並べ替えのタイル：グロスの区切りを単語として使う（無ければ空白区切り）。
 * 元の文を再構成できる場合だけ採用し、2〜7枚の文に限る。 */
function lineTiles(ep, idx) {
  var ln = ep.lines[idx];
  var toks = null;
  if (ln.gloss && validateGloss(ln.text, ln.gloss)) {
    var gs = ln.gloss.map(function (seg) { return cleanWord(seg.t || ''); })
      .filter(function (w) { return w.length > 0; });
    /* 空白の有無は言語で違う（中国語は空白なし）ので、空白を落としてから照合する */
    var joinedN = normalizeAnswer(gs.join(' '), ep.lang).replace(/\s/g, '');
    var textN = normalizeAnswer(ln.text, ep.lang).replace(/\s/g, '');
    if (gs.length >= 2 && joinedN === textN) toks = gs;
  }
  if (!toks) {
    var st = splitTokens(ln.text).map(function (t) { return cleanWord(t); })
      .filter(function (w) { return w.length > 0; });
    if (st.length >= 2) toks = st;
  }
  if (!toks || toks.length < 2 || toks.length > 7) return null;
  if (toks.every(function (t) { return t === toks[0]; })) return null;
  return toks;
}
function checkTileOrder(q, pickedTiles) {
  if (pickedTiles.length !== q.tokens.length) return false;
  for (var i = 0; i < q.tokens.length; i++) if (pickedTiles[i] !== q.tokens[i]) return false;
  return true;
}

/* ---------- レッスンの問題生成 ---------- */
function makePairsQuestion(entries, allWords, useReading) {
  var pool = allWords.filter(function (w) { return useReading ? !!w.reading : !!w.ja; });
  var seenFace = {}, uniq = [];
  shuffle(pool).forEach(function (w) {
    var face = useReading ? w.reading : w.ja;
    var fk = normalizeAnswer(face, 'ja');
    if (!fk || seenFace[fk]) return;
    seenFace[fk] = 1;
    uniq.push(w);
  });
  var pickedPairs = [], usedLines = {};
  uniq.forEach(function (w) {
    if (pickedPairs.length >= 5) return;
    var k = w.epId + '#' + w.lineIdx;
    if (usedLines[k]) return;
    usedLines[k] = 1;
    pickedPairs.push(w);
  });
  if (pickedPairs.length < 5) {
    uniq.forEach(function (w) {
      if (pickedPairs.length >= 5 || pickedPairs.indexOf(w) >= 0) return;
      pickedPairs.push(w);
    });
  }
  if (pickedPairs.length < 5) return null;
  return {
    type: 'pairs', useReading: useReading,
    pairs: pickedPairs.map(function (w) {
      return { epId: w.epId, lineIdx: w.lineIdx, word: w.word, face: useReading ? w.reading : w.ja };
    })
  };
}
function mutateAccent(word) {
  var nfd = word.normalize('NFD');
  if (/[̀-ͯ]/.test(nfd)) {
    var stripped = nfd.replace(/[̀-ͯ]/g, '').normalize('NFC');
    return stripped !== word ? stripped : null;
  }
  var chars = Array.from(nfd);
  var vowels = 'aeiouAEIOUαεηιουωΑΕΗΙΟΥΩ';
  for (var i = 0; i < chars.length; i++) {
    if (vowels.indexOf(chars[i]) >= 0) {
      chars.splice(i + 1, 0, '́');
      var out = chars.join('').normalize('NFC');
      return out !== word ? out : null;
    }
  }
  return null;
}
/* 綴りの変形（文字クイズの誤答づくり）：アクセントの有無・1文字差し替え・
 * 隣同士の入れ替え・1文字削除・1文字重ね。材料の文字は同じ回の単語から集める。 */
function mutateWord(word, alphabet) {
  var chars = Array.from(word);
  if (chars.length < 2) return null;
  var kinds = ['accent', 'replace', 'swap', 'delete', 'dup'];
  var kind = kinds[Math.floor(Math.random() * kinds.length)];
  if (kind === 'accent') return mutateAccent(word);
  if (kind === 'replace') {
    if (!alphabet.length) return null;
    var i = Math.floor(Math.random() * chars.length);
    var c = alphabet[Math.floor(Math.random() * alphabet.length)];
    if (c === chars[i]) return null;
    chars[i] = c;
    return chars.join('');
  }
  if (kind === 'swap') {
    if (chars.length < 2) return null;
    var j = Math.floor(Math.random() * (chars.length - 1));
    if (chars[j] === chars[j + 1]) return null;
    var t = chars[j]; chars[j] = chars[j + 1]; chars[j + 1] = t;
    return chars.join('');
  }
  if (kind === 'delete') {
    if (chars.length < 3) return null;
    var k = 1 + Math.floor(Math.random() * (chars.length - 1));
    chars.splice(k, 1);
    return chars.join('');
  }
  var m = Math.floor(Math.random() * chars.length);
  chars.splice(m, 0, chars[m]);
  return chars.join('');
}
function epAlphabet(ep) {
  var set = {};
  epWords(ep).forEach(function (w) {
    Array.from(w.word).forEach(function (c) { if (/\p{L}/u.test(c)) set[c] = 1; });
  });
  return Object.keys(set);
}
/* 誤答は3つ：まず同じ回の「実在の似た語」（編集距離1〜2）、足りなければ変形で作る。
 * 正解と完全一致は禁止。正規化で正解と一致する物（アクセントだけ違い）は最大1つまで。 */
function genSpellDistractors(ep, target) {
  var lang = ep.lang;
  var norm = normalizeAnswer(target.word, lang);
  var out = [], usedExact = {};
  usedExact[target.word] = 1;
  var accentOnlyUsed = false;
  function tryAdd(cand) {
    if (out.length >= 3 || !cand) return;
    if (usedExact[cand]) return;
    if (normalizeAnswer(cand, lang) === norm) {
      if (accentOnlyUsed) return;
      accentOnlyUsed = true;
    }
    usedExact[cand] = 1;
    out.push(cand);
  }
  shuffle(epWords(ep)).forEach(function (w) {
    if (w.word === target.word) return;
    var d = editDistance(normalizeAnswer(w.word, lang), norm);
    if (d >= 1 && d <= 2) tryAdd(w.word);
  });
  var alphabet = epAlphabet(ep);
  var tries = 0;
  while (out.length < 3 && tries < 80) {
    tries++;
    tryAdd(mutateWord(target.word, alphabet));
  }
  return out.length >= 3 ? out : null;
}
function makeSpellQuestion(ep, idx) {
  var words = epWords(ep).filter(function (w) {
    return w.lineIdx === idx && w.reading && Array.from(w.word).length >= 2;
  });
  if (!words.length) return null;
  var target = words[Math.floor(Math.random() * words.length)];
  var dis = genSpellDistractors(ep, target);
  if (!dis) return null;
  var options = shuffle([target.word].concat(dis));
  return {
    type: 'spell', epId: ep.id, lineIdx: idx, reading: target.reading, word: target.word,
    options: options, correct: options.indexOf(target.word)
  };
}
function makeHearQuestion(ep, idx) {
  var ln = ep.lines[idx];
  var tiers = lineTiers(ep, function (l) { return l.text; }, idx);
  var q = pickDistractors(ep, ln.text, tiers, { minR: 0.35, maxR: 2.8 });
  if (!q) return null;
  return { type: 'hear', epId: ep.id, lineIdx: idx, text: ln.text, options: q.options, correct: q.correct };
}
/* entries = [{ep, idx}]（1回分、または1言語の複数回分）から約10問を組む */
function genLessonQuestions(entries) {
  if (!entries.length) return [];
  var allWords = [], seenEp = {};
  entries.forEach(function (en) {
    if (seenEp[en.ep.id]) return;
    seenEp[en.ep.id] = 1;
    allWords = allWords.concat(epWords(en.ep));
  });
  var useReading = poolUseReading(allWords);
  var pools = { hear: [], spell: [], horder: [], torder: [] };
  entries.forEach(function (en) {
    var ln = en.ep.lines[en.idx];
    var h = makeHearQuestion(en.ep, en.idx);
    if (h) pools.hear.push(h);
    if (useReading) {
      var s = makeSpellQuestion(en.ep, en.idx);
      if (s) pools.spell.push(s);
    }
    var tk = lineTiles(en.ep, en.idx);
    if (tk) {
      pools.horder.push({ type: 'horder', epId: en.ep.id, lineIdx: en.idx, tokens: tk, text: ln.text, ja: ln.ja || '' });
      pools.torder.push({ type: 'torder', epId: en.ep.id, lineIdx: en.idx, tokens: tk, text: ln.text, ja: ln.ja || '' });
    }
  });
  ['hear', 'spell', 'horder', 'torder'].forEach(function (k) { pools[k] = shuffle(pools[k]); });
  var questions = [], usage = {};
  function usageKey(q) { return q.epId + '#' + q.lineIdx; }
  function take(q) {
    questions.push(q);
    if (q.type === 'pairs') {
      q.pairs.forEach(function (p) { var k = p.epId + '#' + p.lineIdx; usage[k] = (usage[k] || 0) + 1; });
    } else {
      usage[usageKey(q)] = (usage[usageKey(q)] || 0) + 1;
    }
  }
  var pairsQ = makePairsQuestion(entries, allWords, useReading);
  if (pairsQ) take(pairsQ);
  var rotation = ['hear', 'spell', 'torder', 'hear', 'horder', 'spell', 'torder', 'hear', 'horder', 'torder', 'spell', 'hear'];
  rotation.forEach(function (fmt) {
    if (questions.length >= LESSON_LEN) return;
    var cand = null;
    pools[fmt].forEach(function (q) {
      if (cand) return;
      if (questions.indexOf(q) >= 0) return;
      if ((usage[usageKey(q)] || 0) >= 2) return;
      cand = q;
    });
    if (cand) take(cand);
  });
  if (questions.length < LESSON_LEN) {
    var rest = shuffle(pools.hear.concat(pools.spell, pools.horder, pools.torder));
    rest.forEach(function (q) {
      if (questions.length >= LESSON_LEN) return;
      if (questions.indexOf(q) >= 0) return;
      if ((usage[usageKey(q)] || 0) >= 3) return;
      take(q);
    });
  }
  if (questions.length < 5) return [];
  return questions.slice(0, LESSON_LEN);
}

/* ---------- レッスンの音声（区間があれば録音、無ければTTS。ゆっくり再生つき） ---------- */
function speakTextRate(text, lang, rate) {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = LANG_TAGS[lang] || lang || 'en-US';
    u.rate = rate;
    speechSynthesis.speak(u);
  } catch (e) { /* 音声が無くても画面は続く */ }
}
function lessonPlayLine(ep, idx, slow) {
  if (!ep || !ep.lines[idx]) return;
  var tm = lineTiming(ep, idx);
  if (ep.audio && tm) {
    try {
      stopSpeak();
      if (!dictAudio) dictAudio = new Audio();
      try { dictAudio.pause(); } catch (e) { /* 初回は止める物が無い */ }
      dictAudio.src = ep.audio;
      dictAudio.currentTime = tm.start;
      try { dictAudio.playbackRate = slow ? 0.75 : 1; } catch (e) { /* 変えられなくても続く */ }
      var pr = dictAudio.play();
      if (pr && pr.catch) pr.catch(function () { /* 再生できなくても画面は続く */ });
      if (dictTimer) clearTimeout(dictTimer);
      var durMs = Math.max(0, (tm.end - tm.start)) * 1000 / (slow ? 0.75 : 1) + 300;
      dictTimer = setTimeout(function () {
        if (dictAudio) { try { dictAudio.pause(); } catch (e) { /* 何もしない */ } }
      }, durMs);
    } catch (e) { /* 音が出なくても画面は続く */ }
    return;
  }
  speakTextRate(ep.lines[idx].text, ep.lang, slow ? 0.65 : 1);
}

/* ---------- レッスンの開始・終了 ---------- */
function startEpisodeLesson(epId) {
  var ep = EP_BY_ID[epId];
  if (!ep || !canLesson(ep)) return;
  var entries = ep.lines.map(function (ln, idx) { return { ep: ep, idx: idx }; });
  var qs = genLessonQuestions(entries);
  if (!qs.length) return;
  lesson = {
    kind: 'ep', epId: epId, lang: ep.lang,
    title: ep.langName + '「' + ep.title + '」レッスン', origin: 'shelf',
    questions: qs, idx: 0, score: 0, answered: false, lastOk: false,
    sel: null, picked: [], tiles: null, hintOn: false, pair: null, pairMistakes: 0
  };
  showLesson();
}
function startLangLesson(lang) {
  var entries = [];
  EPISODES.forEach(function (ep) {
    if (ep.lang !== lang || !canLesson(ep)) return;
    ep.lines.forEach(function (ln, idx) { entries.push({ ep: ep, idx: idx }); });
  });
  if (!entries.length) return;
  var qs = genLessonQuestions(entries);
  if (!qs.length) return;
  var ep0 = EPISODES.filter(function (e) { return e.lang === lang; })[0];
  lesson = {
    kind: 'lang', epId: null, lang: lang,
    title: (ep0 ? ep0.langName : lang) + ' レッスン', origin: 'queue',
    questions: qs, idx: 0, score: 0, answered: false, lastOk: false,
    sel: null, picked: [], tiles: null, hintOn: false, pair: null, pairMistakes: 0
  };
  showLesson();
}
function showLesson() {
  stopSpeak();
  quiz = null;
  matchGame = null;
  ['queue', 'shelf', 'phrases'].forEach(function (t) {
    document.getElementById('view-' + t).hidden = true;
  });
  document.getElementById('view-quiz').hidden = false;
  document.querySelectorAll('.tabbar .tab').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === (lesson ? lesson.origin : 'shelf'));
  });
  window.scrollTo(0, 0);
  renderLesson();
}
function closeLesson() {
  var origin = lesson ? lesson.origin : 'shelf';
  lesson = null;
  stopSpeak();
  document.getElementById('view-quiz').hidden = true;
  renderAll();
  switchTab(origin === 'queue' ? 'queue' : 'shelf');
}

/* ---------- レッスンの描画 ---------- */
function lessonReady() {
  if (!lesson || lesson.answered) return false;
  var q = lesson.questions[lesson.idx];
  if (q.type === 'spell' || q.type === 'hear') return lesson.sel !== null;
  if (q.type === 'horder' || q.type === 'torder') {
    return !!lesson.tiles && lesson.picked.length === q.tokens.length;
  }
  return false;
}
function renderLesson() {
  hideGlossPop();
  var box = document.getElementById('quiz-box');
  if (!lesson) { box.innerHTML = ''; return; }
  if (lesson.idx >= lesson.questions.length) { renderLessonSummary(box); return; }
  var q = lesson.questions[lesson.idx];
  var pct = Math.round(lesson.idx / lesson.questions.length * 100);
  var html = '<div class="lsn-top">' +
    '<button type="button" class="quiz-quit" data-act="lesson-quit">✕ やめる</button>' +
    '<div class="lsn-progress"><div class="lsn-bar" style="width:' + pct + '%"></div></div>' +
    '<span class="lsn-count">' + (lesson.idx + 1) + ' / ' + lesson.questions.length + '</span></div>' +
    '<div class="quiz-title">' + esc(lesson.title) + '</div>';
  if (q.type === 'pairs') html += lessonPairsHtml(q);
  else if (q.type === 'spell') html += lessonChoiceHtml(q, true);
  else if (q.type === 'hear') html += lessonChoiceHtml(q, false);
  else if (q.type === 'horder' || q.type === 'torder') html += lessonOrderHtml(q);
  html += '<div id="lesson-feedback">';
  if (lesson.answered) html += lessonFeedbackHtml(q);
  html += '</div>';
  if (q.type !== 'pairs' && !lesson.answered) {
    html += '<div class="lsn-foot"><button type="button" class="lsn-check" data-act="lesson-check"' +
      (lessonReady() ? '' : ' disabled') + '>CHECK</button></div>';
  }
  box.innerHTML = html;
  if (q.type === 'horder' || q.type === 'torder') renderLessonTiles();
}
function lessonSoundBtnsHtml() {
  return '<div class="lsn-sound">' +
    '<button type="button" class="lsn-play" data-act="lesson-play" aria-label="聞く">🔊</button>' +
    '<button type="button" class="lsn-play slow" data-act="lesson-play-slow" aria-label="ゆっくり聞く">🐢</button>' +
    '</div>';
}
function lessonChoiceHtml(q, isSpell) {
  var html = '';
  if (isSpell) {
    html += '<div class="q-kind">文字クイズ：この読みの単語はどれ？</div>' +
      '<div class="lsn-reading">' + esc(q.reading) + '</div>';
  } else {
    html += '<div class="q-kind">聞いて選ぶ：音声を聞いて、言った文を選んでください</div>' +
      lessonSoundBtnsHtml();
  }
  html += '<div class="options' + (isSpell ? ' lsn-grid' : '') + '">';
  q.options.forEach(function (opt, i) {
    var cls = 'opt-btn';
    if (lesson.answered) {
      if (i === q.correct) cls += ' correct';
      else if (lesson.sel === i) cls += ' wrong';
    } else if (lesson.sel === i) {
      cls += ' selected';
    }
    html += '<button type="button" class="' + cls + '" data-act="lesson-opt" data-i="' + i + '"' +
      (lesson.answered ? ' disabled' : '') + '><span dir="auto">' + esc(opt) + '</span></button>';
  });
  return html + '</div>';
}
function lessonOrderHtml(q) {
  var html = '';
  if (q.type === 'horder') {
    html += '<div class="q-kind">聞いて並べる：音声を聞いて、文を組み立ててください</div>' +
      lessonSoundBtnsHtml();
  } else {
    var ep = EP_BY_ID[q.epId];
    var ln = ep.lines[q.lineIdx];
    html += '<div class="q-kind">訳して並べる：この文を ' + esc(ep.langName) + ' で組み立ててください</div>' +
      '<div class="lsn-ja-prompt">' + esc(q.ja || ln.ja || '') + '</div>' +
      '<div class="q-actions"><button type="button" class="back-btn" data-act="lesson-hint">' +
      (lesson.hintOn ? 'ヒントを隠す' : '単語ヒントを見る') + '</button></div>';
    if (lesson.hintOn) {
      html += '<div class="lsn-hints">';
      if (ln.gloss && validateGloss(ln.text, ln.gloss)) {
        ln.gloss.forEach(function (seg) {
          var w = cleanWord(seg.t || '');
          if (!w || !seg.ja) return;
          html += '<span class="lsn-hint-chip"><span dir="auto">' + esc(w) + '</span> → ' + esc(seg.ja) + '</span>';
        });
      }
      html += '</div>';
    }
  }
  html += '<div class="order-answer" id="lesson-answer"></div>' +
    '<div class="order-pool" id="lesson-pool"></div>';
  return html;
}
function renderLessonTiles() {
  if (!lesson) return;
  var q = lesson.questions[lesson.idx];
  if (!q || (q.type !== 'horder' && q.type !== 'torder')) return;
  if (!lesson.tiles) {
    lesson.tiles = shuffle(q.tokens.map(function (t) { return { t: t }; }));
  }
  var poolBox = document.getElementById('lesson-pool');
  var ansBox = document.getElementById('lesson-answer');
  if (!poolBox || !ansBox) return;
  var dis = lesson.answered ? ' disabled' : '';
  var poolHtml = '';
  lesson.tiles.forEach(function (tile, i) {
    if (lesson.picked.indexOf(i) >= 0) return;
    poolHtml += '<button type="button" class="chip" data-act="lesson-chip-pick" data-i="' + i + '"' + dis + '><span dir="auto">' + esc(tile.t) + '</span></button>';
  });
  poolBox.innerHTML = poolHtml || '<span class="hint">全部置きました</span>';
  var ansHtml = '';
  lesson.picked.forEach(function (pi, pos) {
    ansHtml += '<button type="button" class="chip placed" data-act="lesson-chip-unpick" data-pos="' + pos + '"' + dis + '><span dir="auto">' + esc(lesson.tiles[pi].t) + '</span></button>';
  });
  ansBox.innerHTML = ansHtml || '<span class="hint">ここに文が組み上がります</span>';
  var chk = document.querySelector ? document.querySelector('#quiz-box .lsn-check') : null;
  if (chk) chk.disabled = !lessonReady();
}
function lessonPairsHtml(q) {
  var st = lessonPairState(q);
  var html = '<div class="q-kind">ペア合わせ：単語と' + (q.useReading ? '読み' : '意味') + 'のペアをタップで合わせてください</div>' +
    '<div class="match-cols"><div class="match-col">';
  st.left.forEach(function (pi) {
    var p = q.pairs[pi];
    var cls = 'match-btn';
    if (st.matched[pi]) cls += ' matched';
    else if (st.selL === pi) cls += ' selected';
    else if (st.wrongL === pi) cls += ' wrong';
    html += '<button type="button" class="' + cls + '" data-act="lesson-pair-left" data-i="' + pi + '"' +
      (st.matched[pi] || lesson.answered ? ' disabled' : '') + '><span dir="auto">' + esc(p.word) + '</span></button>';
  });
  html += '</div><div class="match-col">';
  st.right.forEach(function (pi) {
    var p = q.pairs[pi];
    var cls = 'match-btn';
    if (st.matched[pi]) cls += ' matched';
    else if (st.selR === pi) cls += ' selected';
    else if (st.wrongR === pi) cls += ' wrong';
    html += '<button type="button" class="' + cls + '" data-act="lesson-pair-right" data-i="' + pi + '"' +
      (st.matched[pi] || lesson.answered ? ' disabled' : '') + '>' + esc(p.face) + '</button>';
  });
  return html + '</div></div>';
}
function lessonPairState(q) {
  if (!lesson.pair) {
    lesson.pair = {
      left: shuffle(q.pairs.map(function (p, i) { return i; })),
      right: shuffle(q.pairs.map(function (p, i) { return i; })),
      matched: {}, selL: null, selR: null, wrongL: null, wrongR: null,
      mistakes: 0, wrongLines: {}
    };
  }
  return lesson.pair;
}
function lessonPairPick(side, i) {
  if (!lesson || lesson.answered) return;
  var q = lesson.questions[lesson.idx];
  if (!q || q.type !== 'pairs') return;
  var st = lessonPairState(q);
  if (st.matched[i]) return;
  st.wrongL = null; st.wrongR = null;
  if (side === 'L') st.selL = i; else st.selR = i;
  if (st.selL !== null && st.selR !== null) {
    if (st.selL === st.selR) {
      st.matched[st.selL] = true;
    } else {
      st.mistakes++;
      var a = q.pairs[st.selL], b = q.pairs[st.selR];
      st.wrongLines[a.epId + '#' + a.lineIdx] = 1;
      st.wrongLines[b.epId + '#' + b.lineIdx] = 1;
      st.wrongL = st.selL; st.wrongR = st.selR;
    }
    st.selL = null; st.selR = null;
    if (Object.keys(st.matched).length >= q.pairs.length) {
      /* 記録：ミスに絡んだ行は「まだ」、絡まなかった行は「できた」 */
      q.pairs.forEach(function (p) {
        applyLineMark(p.epId, p.lineIdx, st.wrongLines[p.epId + '#' + p.lineIdx] ? 'mada' : 'ok', null);
      });
      if (st.mistakes === 0) lesson.score++;
      lesson.lastOk = st.mistakes === 0;
      lesson.pairMistakes = st.mistakes;
      lesson.answered = true;
    }
  }
  renderLesson();
}
/* 採点（ペア合わせ以外）。記録は既存クイズと同じ applyLineMark 経由 */
function lessonGrade(isCorrect) {
  var q = lesson.questions[lesson.idx];
  applyLineMark(q.epId, q.lineIdx, isCorrect ? 'ok' : 'mada', null);
  if (isCorrect) lesson.score++;
  lesson.lastOk = isCorrect;
  lesson.answered = true;
}
function lessonCheck() {
  if (!lesson || lesson.answered) return;
  var q = lesson.questions[lesson.idx];
  var isCorrect;
  if (q.type === 'spell' || q.type === 'hear') {
    if (lesson.sel === null) return;
    isCorrect = (lesson.sel === q.correct);
  } else if (q.type === 'horder' || q.type === 'torder') {
    if (!lessonReady()) return;
    var seq = lesson.picked.map(function (pi) { return lesson.tiles[pi].t; });
    isCorrect = checkTileOrder(q, seq);
  } else {
    return;
  }
  lessonGrade(isCorrect);
  renderLesson();
}
function lessonFeedbackHtml(q) {
  var isCorrect = lesson.lastOk;
  var html = '<div class="feedback ' + (isCorrect ? 'good' : 'bad') + '">';
  if (q.type === 'pairs') {
    html += '<div class="fb-msg">' + (isCorrect ? '全ペア正解！' : 'ペア合わせ完了（ミス ' + lesson.pairMistakes + ' 回）') + '</div>' +
      '<div class="q-meta">' + (isCorrect
        ? '合わせた行は「できた」で記録しました。'
        : 'ミスに絡んだ行は「まだ」、合った行は「できた」で記録しました。') + '</div>';
  } else {
    var ep = EP_BY_ID[q.epId];
    var ln = ep.lines[q.lineIdx];
    html += '<div class="fb-msg">' + (isCorrect ? '正解！' : '残念。') + '</div>';
    if (q.type === 'spell') {
      html += '<div class="fb-answer">正解：<span dir="auto">' + esc(q.word) + '</span>（' + esc(q.reading) + '）</div>';
    }
    html += '<div class="fb-line"><span dir="auto">' + lineGlossHtml(ep, q.lineIdx) + '</span> ' +
      '<button type="button" class="speak-btn" data-act="lesson-play" aria-label="正解を聞く">🔊</button>' +
      (ln.ja ? '<div class="ja">' + esc(ln.ja) + '</div>' : '') + '</div>' +
      '<div class="q-meta">' + (isCorrect
        ? 'この行は「できた」で記録しました。'
        : 'この行は「まだ」で記録しました。明日と3日後に、弱い行として先に出ます。') + '</div>';
  }
  html += '<div class="q-actions"><button type="button" class="quiz-btn" data-act="lesson-next">' +
    (lesson.idx + 1 >= lesson.questions.length ? '結果を見る' : '次へ') + '</button></div></div>';
  return html;
}
function lessonNext() {
  if (!lesson) return;
  lesson.idx++;
  lesson.answered = false;
  lesson.lastOk = false;
  lesson.sel = null;
  lesson.picked = [];
  lesson.tiles = null;
  lesson.hintOn = false;
  lesson.pair = null;
  stopSpeak();
  renderLesson();
}
function renderLessonSummary(box) {
  var total = lesson.questions.length;
  var html = '<div class="card"><h3>レッスン結果</h3>' +
    '<p class="quiz-score">' + total + '問中 ' + lesson.score + ' 問正解</p>' +
    '<p>' + esc(lesson.title) + '</p>' +
    '<p class="hint">答えた行は「できた／まだ」で記録しました。間違えた行は、明日と3日後に弱い行として先に出ます。</p>' +
    '<div class="q-actions"><button type="button" class="quiz-btn" data-act="lesson-again">もう一度レッスン</button></div>' +
    '<div class="q-actions"><button type="button" class="quiz-btn" data-act="lesson-done">戻る</button></div></div>';
  box.innerHTML = html;
}

/* ---------- 画面切り替え ---------- */
function switchTab(name) {
  stopSpeak();
  hideGlossPop();
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
    matchGame = null;
    lesson = null;
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
  } else if (act === 'gloss') {
    /* グロスのポップオーバーは pointer イベント側で処理する */
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
  } else if (act === 'quiz-type-check') {
    answerTyped();
  } else if (act === 'quiz-giveup') {
    answerGiveUp();
  } else if (act === 'quiz-dict-play') {
    if (quiz) {
      var qd = quiz.questions[quiz.idx];
      if (qd && qd.type === 'dictation') playDictation(qd);
    }
  } else if (act === 'quiz-dict-check') {
    answerDictation();
  } else if (act === 'quiz-dict-giveup') {
    answerDictationGiveUp();
  } else if (act === 'quiz-hint') {
    var hintEl = document.getElementById('type-hint');
    if (hintEl) {
      hintEl.hidden = !hintEl.hidden;
      el.textContent = hintEl.hidden ? '意味のヒントを見る' : 'ヒントを隠す';
    }
  } else if (act === 'quiz-mixed') {
    startMixedQuiz(el.getAttribute('data-lang'));
  } else if (act === 'quiz-match') {
    startMatching(el.getAttribute('data-ep'));
  } else if (act === 'match-left') {
    matchPick('L', Number(el.getAttribute('data-idx')));
  } else if (act === 'match-right') {
    matchPick('R', Number(el.getAttribute('data-idx')));
  } else if (act === 'lesson-ep') {
    startEpisodeLesson(el.getAttribute('data-ep'));
  } else if (act === 'lesson-lang') {
    startLangLesson(el.getAttribute('data-lang'));
  } else if (act === 'lesson-opt') {
    if (lesson && !lesson.answered) { lesson.sel = Number(el.getAttribute('data-i')); renderLesson(); }
  } else if (act === 'lesson-check') {
    lessonCheck();
  } else if (act === 'lesson-next') {
    lessonNext();
  } else if (act === 'lesson-quit' || act === 'lesson-done') {
    closeLesson();
  } else if (act === 'lesson-again') {
    if (lesson && lesson.kind === 'ep') startEpisodeLesson(lesson.epId);
    else if (lesson) startLangLesson(lesson.lang);
  } else if (act === 'lesson-play' || act === 'lesson-play-slow') {
    if (lesson) {
      var lq = lesson.questions[lesson.idx];
      if (lq && lq.epId) lessonPlayLine(EP_BY_ID[lq.epId], lq.lineIdx, act === 'lesson-play-slow');
    }
  } else if (act === 'lesson-chip-pick') {
    if (lesson && !lesson.answered) { lesson.picked.push(Number(el.getAttribute('data-i'))); renderLessonTiles(); }
  } else if (act === 'lesson-chip-unpick') {
    if (lesson && !lesson.answered) { lesson.picked.splice(Number(el.getAttribute('data-pos')), 1); renderLessonTiles(); }
  } else if (act === 'lesson-pair-left') {
    lessonPairPick('L', Number(el.getAttribute('data-i')));
  } else if (act === 'lesson-pair-right') {
    lessonPairPick('R', Number(el.getAttribute('data-i')));
  } else if (act === 'lesson-hint') {
    if (lesson) { lesson.hintOn = !lesson.hintOn; renderLesson(); }
  } else if (act === 'quiz-next') {
    quiz.idx++;
    quiz.answered = false;
    quiz.picked = [];
    quiz.shuffledTokens = null;
    quiz.tiles = null;
    renderQuiz();
  } else if (act === 'quiz-done' || act === 'quiz-quit') {
    closeQuiz();
  }
});

/* 入力形式で Enter を押したら答え合わせ */
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter' && ev.target && ev.target.id === 'type-input') {
    ev.preventDefault();
    answerTyped();
  }
  if (ev.key === 'Enter' && ev.target && ev.target.id === 'dict-input') {
    ev.preventDefault();
    answerDictation();
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
