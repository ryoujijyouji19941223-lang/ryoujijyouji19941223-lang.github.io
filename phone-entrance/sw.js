// App-shell cache for installability (production).
// Same-origin GETs only: Firebase SDK (gstatic) and Firestore traffic are
// never intercepted, so auth and realtime data always go to the network.
//
// RELEASE RULE (mandatory since 2026-11-15, thinking-bug fix): whenever
// any shell file (index.html / style.css / firebase-config.js / core.js /
// app.js) changes, bump CACHE below (v2 -> v3 -> ...). This file is
// cache-first with no revalidation, and an installed phone only picks up
// a new shell when sw.js's own bytes change — a release that forgets the
// bump silently leaves phones running the old build forever.
// History: v2 = G3 release (2026-11-15). v3 = thinking-lock staleness fix
// (core.js judges from thinking_since_iso and fails closed on missing
// timestamps; app.js clears the lock display on listener error and
// re-evaluates on foreground return), 2026-11-15.
var CACHE = "phone-entrance-v3";
var SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./firebase-config.js",
  "./core.js",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", function (ev) {
  ev.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (ev) {
  ev.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (ev) {
  if (ev.request.method !== "GET") return;
  var url = new URL(ev.request.url);
  if (url.origin !== self.location.origin) return; // Firebase etc.: pass through
  ev.respondWith(
    caches.match(ev.request).then(function (hit) {
      return hit || fetch(ev.request);
    })
  );
});
