/* Linear Time — service worker
 * -----------------------------------------------------------------------------
 * Jobs:
 *   1. Keep the app shell available offline (so it opens instantly at login).
 *   2. Receive background pushes from the Worker's cron and show the reminder,
 *      even when the app window is closed. The push carries no payload — the SW
 *      asks /api/push/pending what to show, using the token the page stashed.
 *   3. Handle taps on a reminder (focus / open the app).
 * It only touches same-origin GETs inside /time/ — never the /api calls (except
 * the one push/pending fetch, which is a POST it makes itself).
 */
var CACHE = "linear-time-v2";
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
      return Promise.all(keys.map(function (k) { return (k === CACHE || k === "lt-auth") ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // let API / cross-origin pass through
  if (url.pathname.indexOf("/time/") !== 0 && url.pathname !== "/") return;
  if (url.pathname === "/time/__auth") return;               // internal token stash, never cache-serve

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

  // Other assets: stale-while-revalidate (instant from cache, refresh for next time).
  e.respondWith(
    caches.match(req).then(function (cached) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === "basic") {
          var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || net;
    })
  );
});

/* ---- Background reminders ---------------------------------------------------
 * The push has no body; we ask the API what (if anything) to show right now. */
self.addEventListener("push", function (e) { e.waitUntil(onPush()); });

async function onPush() {
  var auth = await readAuth();
  var title = "Linear Time", body = "Open Linear Time.";
  if (auth && auth.token) {
    try {
      var r = await fetch((auth.base || "") + "/api/push/pending", {
        method: "POST",
        headers: { "Authorization": "Bearer " + auth.token, "Content-Type": "application/json" },
      });
      var d = await r.json();
      if (!d || !d.show) return;          // nothing due anymore (user already acted)
      title = d.title || title;
      body = d.body || body;
    } catch (_) { /* fall through to the generic prompt */ }
  }
  await self.registration.showNotification(title, {
    body: body, icon: "/time/assets/icon.png", badge: "/time/assets/icon.png",
    tag: "linear-time", renotify: true, data: { url: "/time/" },
  });
}

async function readAuth() {
  try {
    var c = await caches.open("lt-auth");
    var res = await c.match("/time/__auth");
    if (res) return await res.json();
  } catch (_) {}
  return null;
}

/* Focus (or open) the app when a reminder is tapped. */
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
