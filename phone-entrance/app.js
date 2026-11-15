// phone-entrance (production) wiring: Firebase Auth (owner only) +
// Firestore against the production entrance collections.
//
// Data path (design: PHONE_ENTRANCE_DESIGN §3, gateway g3-1.0):
//   rooms -> room list (§3.2), each room an independent chat screen;
//            history and unread are kept per room; moving between
//            rooms is always free, and drafts/history stay available
//            while the other room is thinking.
//   send  -> add doc to entrance_inbox {room, status:"queued", ...}
//   read  -> entrance_room_<room> (newest ROOM_HISTORY_LIMIT by seq),
//            written by gateway; the chat displays them newest first
//            (2026-11-16: latest exchange at the top, no scrolling
//            needed when entering a room)
//   lock  -> entrance_state/entrance_state {thinking: room|null}
//            One generation at a time across BOTH rooms (§3.3): while
//            anyone is thinking, sending is disabled everywhere; the
//            thinking room shows the typing indicator, the other room
//            and the room list show the "X is thinking" band.
// The phone talks to Firestore only; the mini-PC gateway does the rest.
//
// G3 note: until the G3 Firestore rules are applied in the console,
// the sakamata room collection is still denied by the G2 ruleset.
// That room is shown as "being prepared" (its listener error is
// caught per-room) and sending to it is refused by the rules; Nitro's
// room is unaffected.
(function () {
  "use strict";

  var Core = window.EntranceCore;

  var els = {
    title: document.getElementById("header-title"),
    backBtn: document.getElementById("back-btn"),
    signoutBtn: document.getElementById("signout-btn"),
    offlineBanner: document.getElementById("offline-banner"),
    lockBanner: document.getElementById("lock-banner"),
    setupView: document.getElementById("setup-view"),
    loginView: document.getElementById("login-view"),
    signinBtn: document.getElementById("signin-btn"),
    loginError: document.getElementById("login-error"),
    deniedView: document.getElementById("denied-view"),
    deniedSignoutBtn: document.getElementById("denied-signout-btn"),
    roomsView: document.getElementById("rooms-view"),
    roomList: document.getElementById("room-list"),
    chatView: document.getElementById("chat-view"),
    roomNote: document.getElementById("room-note"),
    messages: document.getElementById("messages"),
    typingRow: document.getElementById("typing-row"),
    typingLabel: document.getElementById("typing-label"),
    composerNote: document.getElementById("composer-note"),
    composer: document.getElementById("composer"),
    input: document.getElementById("input"),
    sendBtn: document.getElementById("send-btn")
  };

  var VIEWS = [els.setupView, els.loginView, els.deniedView,
               els.roomsView, els.chatView];
  var currentView = null;
  var currentRoom = null; // room id while in chat view, else null

  function show(view) {
    currentView = view;
    VIEWS.forEach(function (v) { v.hidden = v !== view; });
    var inApp = view === els.roomsView || view === els.chatView;
    els.signoutBtn.hidden = !inApp;
    els.backBtn.hidden = view !== els.chatView;
    if (view === els.chatView && currentRoom) {
      els.title.textContent = Core.ROOMS[currentRoom].roomTitle;
    } else {
      els.title.textContent = "ふたりの部屋";
    }
    if (!inApp) {
      els.lockBanner.hidden = true;
      els.typingRow.hidden = true;
    }
    renderLock();
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
  var roomData = {};      // roomId -> {messages:[], error:null|code}
  Core.ROOM_ORDER.forEach(function (id) {
    roomData[id] = { messages: [], error: null };
  });
  var stateData = null;   // raw entrance_state doc (lock computed live)
  var ownTurn = null;     // {room, ref, status} of this session's send
  var notes = {};         // roomId -> [system notes] (timeout etc.)
  var notedTimeouts = {};
  var unsubscribers = [];

  function thinkingWho() {
    // Computed at render time so a stale lock expires on screen even
    // if no new snapshot arrives (core.js STALE_LOCK_MS guard).
    return Core.lockFromState(stateData, Date.now());
  }

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

  // ---- per-room seen markers (unread counts on the room list) ----
  function seenKey(room) { return "phoneEntrance.seen." + room + ".v1"; }
  function getSeen(room) {
    try { return parseInt(localStorage.getItem(seenKey(room)) || "0", 10) || 0; }
    catch (e) { return 0; }
  }
  function setSeen(room, seq) {
    try { localStorage.setItem(seenKey(room), String(seq)); } catch (e) {}
  }
  function maxSeq(room) {
    var ms = roomData[room].messages;
    return ms.length ? (ms[ms.length - 1].seq || 0) : 0;
  }
  function unreadCount(room) {
    if (currentRoom === room && currentView === els.chatView) return 0;
    var seen = getSeen(room);
    return roomData[room].messages.filter(function (m) {
      return m.kind === "reply" && (m.seq || 0) > seen;
    }).length;
  }
  function markSeen(room) { setSeen(room, Math.max(getSeen(room), maxSeq(room))); }

  // ---- room list (§3.2) ----
  function renderRooms() {
    if (currentView !== els.roomsView) return;
    els.roomList.innerHTML = "";
    Core.ROOM_ORDER.forEach(function (id) {
      var room = Core.ROOMS[id];
      var data = roomData[id];
      var card = document.createElement("button");
      card.type = "button";
      card.className = "room-card room-" + id;
      var head = document.createElement("div");
      head.className = "room-card-head";
      var name = document.createElement("span");
      name.className = "room-card-name";
      name.textContent = room.roomTitle;
      head.appendChild(name);
      if (thinkingWho() === id) {
        var th = document.createElement("span");
        th.className = "room-thinking";
        th.textContent = "考え中…";
        head.appendChild(th);
      }
      var unread = unreadCount(id);
      if (unread > 0) {
        var badge = document.createElement("span");
        badge.className = "unread-badge";
        badge.textContent = String(unread);
        head.appendChild(badge);
      }
      card.appendChild(head);
      var preview = document.createElement("div");
      preview.className = "room-card-preview";
      if (data.error) {
        preview.textContent = id === "sakamata"
          ? "接続の準備中です"
          : "履歴を読み込めませんでした";
      } else if (data.messages.length) {
        var last = data.messages[data.messages.length - 1];
        var who = last.kind === "user" ? "あなた" : room.name;
        preview.textContent = who + "：" + last.text +
          (last.at ? "　" + fmtTime(last.at) : "");
      } else {
        preview.textContent = "まだ会話がありません";
      }
      card.appendChild(preview);
      card.addEventListener("click", function () { openRoom(id); });
      els.roomList.appendChild(card);
    });
  }

  // ---- chat view ----
  // Display order is NEWEST FIRST (2026-11-16): the latest exchange
  // sits at the top of the list, so entering a room shows it with no
  // scrolling and older messages flow downward. Storage stays
  // oldest-first (see the snapshot handler); Core.orderForDisplay
  // produces the render order. System notes describe the latest
  // activity, so they render above the messages, newest note first.
  // The typing row likewise lives above the list (index.html), next
  // to the just-sent message it belongs to.
  // Scroll handling mirrors the order: while the user is near the
  // top, stay pinned to the top so new arrivals are visible at once;
  // if they have scrolled down into older history, shift by the
  // height the new top content added so their reading position does
  // not jump.
  function renderMessages() {
    if (currentView !== els.chatView || !currentRoom) return;
    var room = Core.ROOMS[currentRoom];
    var data = roomData[currentRoom];
    var nearTop = els.messages.scrollTop < 120;
    var prevTop = els.messages.scrollTop;
    var prevHeight = els.messages.scrollHeight;
    els.messages.innerHTML = "";
    (notes[currentRoom] || []).slice().reverse().forEach(function (n) {
      var row = document.createElement("div");
      row.className = "sys-note";
      row.textContent = n;
      els.messages.appendChild(row);
    });
    Core.orderForDisplay(data.messages).forEach(function (m) {
      var div = document.createElement("div");
      div.className = "msg " + (m.from === "user" ? "user" : m.from);
      if (m.from !== "user") {
        var who = document.createElement("span");
        who.className = "who";
        who.textContent = room.name + (m.at ? " ・ " + fmtTime(m.at) : "");
        div.appendChild(who);
      }
      div.appendChild(document.createTextNode(m.text));
      els.messages.appendChild(div);
    });
    if (data.error) {
      els.roomNote.hidden = false;
      els.roomNote.textContent = currentRoom === "sakamata"
        ? "この部屋は接続の準備中です。設定が完了するまで、履歴の表示と送信はできません。"
        : "履歴を読み込めませんでした。接続を確認してください。";
    } else {
      els.roomNote.hidden = true;
      els.roomNote.textContent = "";
    }
    if (nearTop) {
      els.messages.scrollTop = 0;
    } else {
      els.messages.scrollTop = Math.max(0,
        prevTop + (els.messages.scrollHeight - prevHeight));
    }
  }

  // Thinking-lock presentation (design §3.3): while anyone thinks,
  // sending is disabled in both rooms; the thinking room shows the
  // typing indicator; the other room and the list show the band.
  // Drafts stay editable everywhere.
  function renderLock() {
    var who = thinkingWho();
    var inApp = currentView === els.roomsView || currentView === els.chatView;
    if (!inApp) { els.lockBanner.hidden = true; els.typingRow.hidden = true; return; }
    if (who && !(currentView === els.chatView && currentRoom === who)) {
      els.lockBanner.hidden = false;
      els.lockBanner.textContent = Core.ROOMS[who].name +
        "が考え中です。返事が届くまで、新しく送ることはできません。";
    } else {
      els.lockBanner.hidden = true;
      els.lockBanner.textContent = "";
    }
    var hereThinking = currentView === els.chatView && who === currentRoom;
    els.typingRow.hidden = !hereThinking;
    if (hereThinking) {
      els.typingLabel.textContent = Core.ROOMS[who].name + "が考え中…";
    }
    if (currentView === els.chatView) {
      var locked = !!who || ownPending();
      els.sendBtn.disabled = locked || isOffline() ||
        !!(currentRoom && roomData[currentRoom].error);
      if (isOffline()) {
        els.composerNote.hidden = false;
        els.composerNote.textContent = "オフラインのため送れません（下書きはそのまま残ります）。";
      } else if (who && who !== currentRoom) {
        els.composerNote.hidden = false;
        els.composerNote.textContent = Core.ROOMS[who].name +
          "が考え中です。返事が届いてから送ってください（下書きは残ります）。";
      } else if (who === currentRoom || ownPending()) {
        els.composerNote.hidden = false;
        els.composerNote.textContent = "考え中です。返事が届いてから送ってください。";
      } else {
        els.composerNote.hidden = true;
        els.composerNote.textContent = "";
      }
    }
    renderRooms();
  }

  function renderOffline() {
    els.offlineBanner.hidden = !isOffline();
    renderLock();
  }
  window.addEventListener("online", renderOffline);
  window.addEventListener("offline", renderOffline);
  // Re-evaluate the lock periodically so a stale lock clears on
  // screen even without a new snapshot (core.js stale guard).
  setInterval(function () { if (stateData) renderLock(); }, 30000);
  // Re-evaluate immediately when the app returns to the foreground:
  // the 30 s timer does not run while backgrounded, so without this a
  // lock that expired in the background could still be on screen when
  // the user comes back (2026-11-15 thinking-bug fix).
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && stateData) renderLock();
  });

  // ---- navigation ----
  function draftKey(room) { return "phoneEntrance.draft." + room + ".v1"; }
  function loadDraft(room) {
    try { els.input.value = localStorage.getItem(draftKey(room)) || ""; }
    catch (e) { els.input.value = ""; }
  }
  function openRoom(room) {
    currentRoom = room;
    markSeen(room);
    loadDraft(room);
    show(els.chatView);
    renderMessages();
    // Newest first: entering a room always starts at the top, where
    // the latest exchange is (2026-11-16).
    els.messages.scrollTop = 0;
    renderLock();
  }
  function backToRooms() {
    if (currentRoom) markSeen(currentRoom);
    currentRoom = null;
    show(els.roomsView);
    renderRooms();
    renderLock();
  }
  els.backBtn.addEventListener("click", backToRooms);

  // ---- Firestore subscriptions (owner only; started after sign-in) ----
  function startSubscriptions() {
    Core.ROOM_ORDER.forEach(function (id) {
      var room = Core.ROOMS[id];
      // Read window: the newest ROOM_HISTORY_LIMIT docs by seq.
      // Firestore keeps the full history (the gateway never deletes
      // room docs); older docs are simply not loaded by the app.
      var q = db.collection(room.collection).orderBy("seq", "desc")
        .limit(Core.ROOM_HISTORY_LIMIT);
      unsubscribers.push(q.onSnapshot(function (snap) {
        var list = [];
        snap.forEach(function (doc) { list.push(Core.roomDocToView(id, doc.data())); });
        // Storage stays oldest-first; renderMessages displays the
        // same list newest-first via Core.orderForDisplay.
        list.reverse();
        roomData[id].messages = list;
        roomData[id].error = null;
        if (currentRoom === id && currentView === els.chatView) markSeen(id);
        renderMessages();
        renderRooms();
      }, function (err) {
        // Per-room failure (e.g. sakamata before the G3 rules are
        // applied) must not take the other room down with it.
        console.error("room listen failed", id, err);
        roomData[id].error = (err && err.code) || "error";
        renderMessages();
        renderRooms();
      }));
    });

    unsubscribers.push(
      db.collection(Core.STATE_COLLECTION).doc(Core.STATE_DOC)
        .onSnapshot(function (doc) {
          stateData = doc.exists ? doc.data() : null;
          renderLock();
        }, function (err) {
          // Listener failure: the lock state is unknown from here on.
          // Clear the display instead of holding a possibly-dead
          // "thinking" indicator indefinitely (2026-11-15 thinking-bug
          // fix; the pre-fix handler only logged and kept stateData).
          console.error("state listen failed", err);
          stateData = null;
          renderLock();
        }));
  }

  function stopSubscriptions() {
    unsubscribers.forEach(function (u) { try { u(); } catch (e) {} });
    unsubscribers = [];
  }

  function watchOwnTurn(room, ref) {
    var unsub = ref.onSnapshot(function (doc) {
      if (!doc.exists) return;
      var status = doc.data().status;
      if (ownTurn && ownTurn.ref.id === ref.id) ownTurn.status = status;
      if ((status === "timeout" || status === "rejected") && !notedTimeouts[ref.id]) {
        notedTimeouts[ref.id] = true;
        notes[room] = notes[room] || [];
        notes[room].push(status === "timeout"
          ? "返事が時間内に届きませんでした。もう一度送ることができます。"
          : "この送信は受け付けられませんでした。");
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
    if (!currentRoom) return;
    var room = currentRoom;
    var text = els.input.value.trim();
    if (!text || thinkingWho() || ownPending() || isOffline() ||
        roomData[room].error) { renderLock(); return; }
    if (text.length > Core.MAX_MESSAGE_CHARS) {
      notes[room] = notes[room] || [];
      notes[room].push("メッセージが長すぎます（" + Core.MAX_MESSAGE_CHARS + "文字まで）。");
      renderMessages();
      return;
    }
    var doc = Core.buildInboxDoc(room, text, new Date());
    db.collection(Core.INBOX_COLLECTION).add(doc).then(function (ref) {
      ownTurn = { room: room, ref: ref, status: "queued" };
      try { localStorage.removeItem(draftKey(room)); } catch (e) {}
      els.input.value = "";
      watchOwnTurn(room, ref);
      renderLock();
    }).catch(function (err) {
      console.error("send failed", err);
      notes[room] = notes[room] || [];
      notes[room].push("送信できませんでした。接続を確認してもう一度お試しください。");
      renderMessages();
    });
  });

  // ---- drafts (kept per room, across the lock, like the prototype) ----
  els.input.addEventListener("input", function () {
    if (!currentRoom) return;
    try { localStorage.setItem(draftKey(currentRoom), els.input.value); } catch (e) {}
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
    currentRoom = null;
    if (!user) { show(els.loginView); return; }
    if (!Core.isOwner(user, window.ENTRANCE_OWNER_EMAIL)) {
      show(els.deniedView);
      return;
    }
    show(els.roomsView);
    startSubscriptions();
    renderRooms();
    renderOffline();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () { /* http/local use */ });
  }
})();
