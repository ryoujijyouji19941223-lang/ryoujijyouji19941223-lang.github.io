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
//                            seq, at, ...}; display order is `seq`.
//   entrance_state        : single doc `entrance_state` mirroring the
//                           thinking lock: {thinking: "nitro"|null, ...}.
(function (global) {
  "use strict";

  var ROOMS = {
    nitro: {
      id: "nitro",
      name: "ニトロ",
      roomTitle: "ニトロの部屋",
      collection: "entrance_room_nitro"
    }
    // sakamata is G3 (after the user's contact-resumption decision).
    // The gateway rejects any other room until then, so no room entry
    // is exposed here in production v1.
  };

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

  // entrance_state doc -> who is thinking (room id) or null.
  function lockFromState(data) {
    if (!data || !data.thinking) return null;
    return ROOMS[data.thinking] ? data.thinking : null;
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
    INBOX_COLLECTION: INBOX_COLLECTION,
    STATE_COLLECTION: STATE_COLLECTION,
    STATE_DOC: STATE_DOC,
    SENDER_NAME: SENDER_NAME,
    MAX_MESSAGE_CHARS: MAX_MESSAGE_CHARS,
    jstIso: jstIso,
    buildInboxDoc: buildInboxDoc,
    roomDocToView: roomDocToView,
    lockFromState: lockFromState,
    isOwner: isOwner,
    isConfigReady: isConfigReady
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.EntranceCore = api;
})(typeof window !== "undefined" ? window : globalThis);
