// App-shell cache for installability (production).
// Same-origin GETs only: Firebase SDK (gstatic) and Firestore traffic are
// never intercepted, so auth and realtime data always go to the network.
var CACHE = "phone-entrance-v1";
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
