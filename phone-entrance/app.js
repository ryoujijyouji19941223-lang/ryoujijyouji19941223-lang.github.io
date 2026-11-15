// phone-entrance (production) wiring: Firebase Auth (owner only) +
// Firestore against the production entrance collections.
//
// Data path (design: PHONE_ENTRANCE_DESIGN §3, gateway g2-1.0):
//   send  -> add doc to entrance_inbox {room:"nitro", status:"queued", ...}
//   read  -> entrance_room_nitro (order by seq), written back by gateway
//   lock  -> entrance_state/entrance_state {thinking:"nitro"|null}
// The phone talks to Firestore only; the mini-PC gateway does the rest.
(function () {
  "use strict";

  var Core = window.EntranceCore;
  var ROOM_ID = "nitro";
  var ROOM = Core.ROOMS[ROOM_ID];
  var LS_DRAFT = "phoneEntrance.draft.nitro.v1";

  var els = {
    title: document.getElementById("header-title"),
    signoutBtn: document.getElementById("signout-btn"),
    offlineBanner: document.getElementById("offline-banner"),
    lockBanner: document.getElementById("lock-banner"),
    setupView: document.getElementById("setup-view"),
    loginView: document.getElementById("login-view"),
    signinBtn: document.getElementById("signin-btn"),
    loginError: document.getElementById("login-error"),
    deniedView: document.getElementById("denied-view"),
    deniedSignoutBtn: document.getElementById("denied-signout-btn"),
    chatView: document.getElementById("chat-view"),
    messages: document.getElementById("messages"),
    typingRow: document.getElementById("typing-row"),
    typingLabel: document.getElementById("typing-label"),
    composerNote: document.getElementById("composer-note"),
    composer: document.getElementById("composer"),
    input: document.getElementById("input"),
    sendBtn: document.getElementById("send-btn")
  };

  function show(view) {
    [els.setupView, els.loginView, els.deniedView, els.chatView].forEach(function (v) {
      v.hidden = v !== view;
    });
    els.signoutBtn.hidden = view !== els.chatView;
    if (view === els.chatView) els.title.textContent = ROOM.roomTitle;
    else els.title.textContent = "ふたりの部屋";
    if (view !== els.chatView) {
      els.lockBanner.hidden = true;
      els.typingRow.hidden = true;
    }
  }

  // ---- config gate: never attempt a connection on placeholder values ----
  if (!Core.isConfigReady(window.FIREBASE_CONFIG, window.ENTRANCE_OWNER_EMAIL)) {
    show(els.setupView);
    return;
  }

  firebase.initializeApp(window.FIREBASE_CONFIG);
  var auth = firebase.auth();
  var db = firebase.firestore();

  // ---- state ----
  var messages = [];          // view models from entrance_room_nitro
  var thinkingWho = null;     // from entrance_state
  var ownTurn = null;         // {ref, status} of this session's latest send
  var notes = [];             // in-memory system notes (timeout etc.)
  var notedTimeouts = {};
  var unsubscribers = [];

  function fmtTime(atMs) {
    if (!atMs) return "";
    var d = new Date(atMs);
    return d.getHours().toString().padStart(2, "0") + ":" +
      d.getMinutes().toString().padStart(2, "0");
  }

  function isOffline() { return !navigator.onLine; }

  function ownPending() {
    return !!(ownTurn && (ownTurn.status === "queued" || ownTurn.status === "sent"));
  }

  function renderMessages() {
    var nearBottom = els.messages.scrollHeight - els.messages.scrollTop -
      els.messages.clientHeight < 120;
    els.messages.innerHTML = "";
    messages.forEach(function (m) {
      var div = document.createElement("div");
      div.className = "msg " + (m.from === "user" ? "user" : m.from);
      if (m.from !== "user") {
        var who = document.createElement("span");
        who.className = "who";
        who.textContent = ROOM.name + (m.at ? " ・ " + fmtTime(m.at) : "");
        div.appendChild(who);
      }
      div.appendChild(document.createTextNode(m.text));
      els.messages.appendChild(div);
    });
    notes.forEach(function (n) {
      var row = document.createElement("div");
      row.className = "sys-note";
      row.textContent = n;
      els.messages.appendChild(row);
    });
    if (nearBottom) els.messages.scrollTop = els.messages.scrollHeight;
  }

  // Thinking-lock presentation (design §3.3), same feel as the prototype:
  // banner naming who is thinking, typing indicator in the room, send
  // disabled while locked — drafts stay editable and are kept.
  function renderLock() {
    var locked = !!thinkingWho || ownPending();
    if (thinkingWho) {
      els.lockBanner.hidden = false;
      els.lockBanner.textContent = ROOM.name +
        "が考え中です。返事が届くまで、新しく送ることはできません。";
    } else {
      els.lockBanner.hidden = true;
      els.lockBanner.textContent = "";
    }
    els.typingRow.hidden = thinkingWho !== ROOM_ID;
    if (thinkingWho === ROOM_ID) {
      els.typingLabel.textContent = ROOM.name + "が考え中…";
    }
    els.sendBtn.disabled = locked || isOffline();
    if (isOffline()) {
      els.composerNote.hidden = false;
      els.composerNote.textContent = "オフラインのため送れません（下書きはそのまま残ります）。";
    } else if (thinkingWho) {
      els.composerNote.hidden = false;
      els.composerNote.textContent = "考え中です。返事が届いてから送ってください。";
    } else if (ownPending()) {
      els.composerNote.hidden = false;
      els.composerNote.textContent = "送信済みです。返事を待っています。";
    } else {
      els.composerNote.hidden = true;
      els.composerNote.textContent = "";
    }
  }

  function renderOffline() {
    els.offlineBanner.hidden = !isOffline();
    renderLock();
  }
  window.addEventListener("online", renderOffline);
  window.addEventListener("offline", renderOffline);

  // ---- Firestore subscriptions (owner only; started after sign-in) ----
  function startSubscriptions() {
    var roomQuery = db.collection(ROOM.collection)
      .orderBy("seq", "desc").limit(200);
    unsubscribers.push(roomQuery.onSnapshot(function (snap) {
      var list = [];
      snap.forEach(function (doc) { list.push(Core.roomDocToView(ROOM_ID, doc.data())); });
      list.reverse();
      messages = list;
      renderMessages();
    }, function (err) { console.error("room listen failed", err); }));

    unsubscribers.push(
      db.collection(Core.STATE_COLLECTION).doc(Core.STATE_DOC)
        .onSnapshot(function (doc) {
          thinkingWho = Core.lockFromState(doc.exists ? doc.data() : null);
          renderLock();
        }, function (err) { console.error("state listen failed", err); }));
  }

  function stopSubscriptions() {
    unsubscribers.forEach(function (u) { try { u(); } catch (e) {} });
    unsubscribers = [];
  }

  function watchOwnTurn(ref) {
    var unsub = ref.onSnapshot(function (doc) {
      if (!doc.exists) return;
      var status = doc.data().status;
      if (ownTurn && ownTurn.ref.id === ref.id) ownTurn.status = status;
      if (status === "timeout" && !notedTimeouts[ref.id]) {
        notedTimeouts[ref.id] = true;
        notes.push("返事が時間内に届きませんでした。もう一度送ることができます。");
        renderMessages();
      }
      if (status === "rejected" && !notedTimeouts[ref.id]) {
        notedTimeouts[ref.id] = true;
        notes.push("この送信は受け付けられませんでした。");
        renderMessages();
      }
      if (status === "replied" || status === "timeout" || status === "rejected") {
        unsub();
      }
      renderLock();
    }, function (err) { console.error("inbox watch failed", err); });
  }

  // ---- send ----
  els.composer.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var text = els.input.value.trim();
    if (!text || thinkingWho || ownPending() || isOffline()) { renderLock(); return; }
    if (text.length > Core.MAX_MESSAGE_CHARS) {
      notes.push("メッセージが長すぎます（" + Core.MAX_MESSAGE_CHARS + "文字まで）。");
      renderMessages();
      return;
    }
    var doc = Core.buildInboxDoc(ROOM_ID, text, new Date());
    db.collection(Core.INBOX_COLLECTION).add(doc).then(function (ref) {
      ownTurn = { ref: ref, status: "queued" };
      try { localStorage.removeItem(LS_DRAFT); } catch (e) {}
      els.input.value = "";
      watchOwnTurn(ref);
      renderLock();
    }).catch(function (err) {
      console.error("send failed", err);
      notes.push("送信できませんでした。接続を確認してもう一度お試しください。");
      renderMessages();
    });
  });

  // ---- drafts (kept across the lock, like the prototype) ----
  try { els.input.value = localStorage.getItem(LS_DRAFT) || ""; } catch (e) {}
  els.input.addEventListener("input", function () {
    try { localStorage.setItem(LS_DRAFT, els.input.value); } catch (e) {}
  });

  // ---- auth flow ----
  function doSignOut() { auth.signOut(); }
  els.signoutBtn.addEventListener("click", doSignOut);
  els.deniedSignoutBtn.addEventListener("click", doSignOut);
  els.signinBtn.addEventListener("click", function () {
    els.loginError.hidden = true;
    var provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(function (err) {
      if (err && (err.code === "auth/popup-blocked" ||
                  err.code === "auth/popup-closed-by-user" ||
                  err.code === "auth/operation-not-supported-in-this-environment")) {
        auth.signInWithRedirect(provider);
        return;
      }
      els.loginError.hidden = false;
      els.loginError.textContent = "サインインできませんでした。もう一度お試しください。";
      console.error("sign-in failed", err);
    });
  });

  auth.onAuthStateChanged(function (user) {
    stopSubscriptions();
    if (!user) { show(els.loginView); return; }
    if (!Core.isOwner(user, window.ENTRANCE_OWNER_EMAIL)) {
      show(els.deniedView);
      return;
    }
    show(els.chatView);
    startSubscriptions();
    renderMessages();
    renderOffline();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () { /* http/local use */ });
  }
})();
