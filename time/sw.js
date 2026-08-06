/* Linear Time — service worker
 * -----------------------------------------------------------------------------
 * Two small jobs:
 *   1. Keep the app shell available offline (so it opens instantly at login even
 *      on a flaky connection). HTML is network-first; other assets cache-first.
 *   2. Show + handle the 30-minute check-in notifications the page fires.
 * It only ever touches same-origin GETs inside /time/ — never the /api calls.
 */
var CACHE = "linear-time-v1";
var SHELL = [
  "/time/",
  "/time/index.html",
  "/time/app.js",
  "/time/manifest.webmanifest",
  "/time/assets/icon.png",
  "/time/assets/logo-white.png",
  "/time/assets/logo-dark.png",
  "/time/assets/pattern.png",
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;         // let API / cross-origin pass through
  if (url.pathname.indexOf("/time/") !== 0 && url.pathname !== "/") return;

  // HTML: network-first (so a new deploy shows up), fall back to cache offline.
  if (req.mode === "navigate" || (req.headers.get("accept") || "").indexOf("text/html") !== -1) {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put("/time/index.html", copy); });
        return res;
      }).catch(function () { return caches.match("/time/index.html").then(function (m) { return m || caches.match("/time/"); }); })
    );
    return;
  }

  // Other assets: cache-first, then network (and cache it).
  e.respondWith(
    caches.match(req).then(function (m) {
      return m || fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === "basic") {
          var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});

// Focus (or open) the app when a reminder is tapped.
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf("/time") !== -1 && "focus" in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/time/");
    })
  );
});
