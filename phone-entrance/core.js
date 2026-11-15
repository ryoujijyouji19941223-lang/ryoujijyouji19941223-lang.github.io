// phone-entrance (production) core: pure helpers shared by the browser app
// and the Node test. No DOM, no Firebase calls here — app.js owns those.
//
// The Firestore shapes below are the gateway's contract, taken from the
// production gateway (nightless-inventory/g2_gateway/gateway.py, g2-1.0)
// and the G2 live test (PHONE_G2_RESULT_2026-11-14):
//   entrance_inbox        : PWA creates {room, message, status:"queued",
//                           created_iso, ...}; the gateway assigns qseq,
//                           then drives status queued -> sent -> replied
//                           (or timeout / rejected) and stamps turn_id.
//   entrance_room_nitro   : gateway write-back only. Docs carry
//                           {kind:"user"|"reply", sender, message, turn_id,
//                            seq, at, ...}; the app displays them newest
//                           first (seq descending, see orderForDisplay).
//   entrance_state        : single doc `entrance_state` mirroring the
//                           thinking lock: {thinking: "nitro"|"sakamata"
//                           |null, updated_iso, thinking_since_iso, ...}.
//                           Written by gateway g3-1.0 (both rooms).
(function (global) {
  "use strict";

  var ROOMS = {
    nitro: {
      id: "nitro",
      name: "ニトロ",
      roomTitle: "ニトロの部屋",
      collection: "entrance_room_nitro"
    },
    sakamata: {
      id: "sakamata",
      name: "サカマタ",
      roomTitle: "サカマタの部屋",
      collection: "entrance_room_sakamata"
    }
    // G3 (2026-11-15, user's instruction): Sakamata's room is connected
    // in the same shape as Nitro's. Until the G3 Firestore rules are
    // applied in the console, reads of entrance_room_sakamata and
    // sakamata inbox creates are denied by the G2 ruleset; the app
    // treats that room as "being prepared" instead of failing.
  };
  var ROOM_ORDER = ["nitro", "sakamata"];

  var INBOX_COLLECTION = "entrance_inbox";
  var STATE_COLLECTION = "entrance_state";
  var STATE_DOC = "entrance_state";
  var SENDER_NAME = "Ryouji"; // gateway DEFAULT_SENDER / G2 test doc value
  var MAX_MESSAGE_CHARS = 4000;

  // ISO 8601 with +09:00 offset, matching the gateway's now_iso() format.
  function jstIso(date) {
    var d = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    function p(n, w) { return String(n).padStart(w || 2, "0"); }
    return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
      "T" + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) +
      "." + p(d.getUTCMilliseconds(), 3) + "+09:00";
  }

  // The exact document the PWA writes into the inbox. The gateway only
  // requires room / message / status=="queued"; created_iso is its
  // ordering fallback, sender matches the G2 production test document.
  function buildInboxDoc(room, message, date) {
    return {
      room: room,
      message: message,
      status: "queued",
      created_iso: jstIso(date || new Date()),
      sender: SENDER_NAME,
      client: "pwa"
    };
  }

  // entrance_room_* doc -> view model for the message list.
  function roomDocToView(roomId, data) {
    var atMs = data.at ? Date.parse(data.at) : null;
    return {
      from: data.kind === "user" ? "user" : roomId,
      kind: data.kind || "reply",
      text: data.message || "",
      at: isNaN(atMs) ? null : atMs,
      seq: typeof data.seq === "number" ? data.seq : null,
      turnId: data.turn_id || null
    };
  }

  // How many room-history docs the app loads per room: the newest
  // ROOM_HISTORY_LIMIT by seq (the Firestore query in app.js is
  // orderBy("seq","desc").limit(ROOM_HISTORY_LIMIT)). Older history
  // stays in Firestore — the gateway only ever appends room docs and
  // never deletes them — it is simply outside the app's read window.
  var ROOM_HISTORY_LIMIT = 200;

  // View models -> display order: NEWEST FIRST (2026-11-16, user's
  // request). The chat screen shows the latest exchange at the top so
  // entering a room needs no scrolling; older messages flow downward.
  // Storage order in app.js stays oldest-first; only the render order
  // changes. Pure: returns a new array, never mutates the input.
  // Ordering: seq descending; docs without a seq (never produced by
  // the gateway, which always stamps seq) go last; ties and seq-less
  // docs break on `at` descending (missing `at` counts as oldest).
  function orderForDisplay(views) {
    return views.slice().sort(function (a, b) {
      var aSeq = typeof a.seq === "number" ? a.seq : null;
      var bSeq = typeof b.seq === "number" ? b.seq : null;
      if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return bSeq - aSeq;
      if (aSeq !== null && bSeq === null) return -1;
      if (aSeq === null && bSeq !== null) return 1;
      var aAt = typeof a.at === "number" ? a.at : null;
      var bAt = typeof b.at === "number" ? b.at : null;
      if (aAt === bAt) return 0;
      if (aAt === null) return 1;
      if (bAt === null) return -1;
      return bAt - aAt;
    });
  }

  // A live turn can hold the lock for at most the gateway's reply
  // timeout (420 s). A state doc whose thinking started longer ago
  // than this cannot describe a live turn — it is a leftover the
  // gateway failed to clear (e.g. the process died mid-turn, or
  // Firestore was unreachable when the clear was attempted). Ignoring
  // such stale locks is display-side defence in depth only: the
  // gateway remains the owner of lock release (design section 3.3)
  // and resets the state on every startup.
  var STALE_LOCK_MS = 600000; // 10 min > 420 s gateway timeout

  // entrance_state doc -> who is thinking (room id) or null.
  // nowMs is injectable for tests; defaults to Date.now().
  //
  // Staleness is judged from thinking_since_iso — the moment the
  // current turn started — which is what gateway g3 added that field
  // for. updated_iso is only a fallback for docs without a usable
  // thinking_since_iso. (The pre-fix guard read updated_iso alone,
  // so a doc whose updated_iso stayed fresh kept a long-dead turn on
  // screen forever; see PHONE_THINKING_BUG_REPRO_2026-11-15 S3/S6.)
  // A doc with NO usable timestamp at all is treated as invalid and
  // does not lock (fail-closed; the pre-fix code trusted such docs
  // unconditionally — repro S2).
  function lockFromState(data, nowMs) {
    if (!data || !data.thinking) return null;
    if (!ROOMS[data.thinking]) return null;
    var since = data.thinking_since_iso ? Date.parse(data.thinking_since_iso) : NaN;
    var updated = data.updated_iso ? Date.parse(data.updated_iso) : NaN;
    var stamp = !isNaN(since) ? since : updated;
    if (isNaN(stamp)) return null; // fail-closed: no usable timestamp
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    if (now - stamp > STALE_LOCK_MS) return null; // stale leftover
    return data.thinking;
  }

  // Client-side owner gate (display only; Firestore rules enforce).
  function isOwner(user, ownerEmail) {
    if (!user || !ownerEmail) return false;
    return user.emailVerified === true &&
      typeof user.email === "string" &&
      user.email.toLowerCase() === String(ownerEmail).toLowerCase();
  }

  // True only when firebase-config.js has been filled with real values.
  function isConfigReady(cfg, ownerEmail) {
    if (!cfg) return false;
    var fields = ["apiKey", "authDomain", "projectId", "appId"];
    for (var i = 0; i < fields.length; i++) {
      var v = cfg[fields[i]];
      if (!v || String(v).indexOf("REPLACE_") === 0) return false;
    }
    if (!ownerEmail || String(ownerEmail).indexOf("REPLACE_") === 0) return false;
    return true;
  }

  var api = {
    ROOMS: ROOMS,
    ROOM_ORDER: ROOM_ORDER,
    STALE_LOCK_MS: STALE_LOCK_MS,
    INBOX_COLLECTION: INBOX_COLLECTION,
    STATE_COLLECTION: STATE_COLLECTION,
    STATE_DOC: STATE_DOC,
    SENDER_NAME: SENDER_NAME,
    MAX_MESSAGE_CHARS: MAX_MESSAGE_CHARS,
    ROOM_HISTORY_LIMIT: ROOM_HISTORY_LIMIT,
    jstIso: jstIso,
    buildInboxDoc: buildInboxDoc,
    roomDocToView: roomDocToView,
    orderForDisplay: orderForDisplay,
    lockFromState: lockFromState,
    isOwner: isOwner,
    isConfigReady: isConfigReady
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.EntranceCore = api;
})(typeof window !== "undefined" ? window : globalThis);
