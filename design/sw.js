/* Linear Design — service worker: makes the app installable and usable offline.
 *
 * App code and pages are network-first, so an update is picked up the next
 * time you're online and the cached copy is only a fallback. Vendored files
 * (fonts, the background-remover runtime and models, pdf-lib) never change
 * under the same name, so they're cache-first and only downloaded once.
 */
'use strict';
const CACHE = 'linear-design-v3';
const CORE = ['/design/', '/design/core.js', '/design/templates.js', '/design/app.js', '/design/qr.js', '/design/bgremove.js', '/design/pptx.js',
  '/design/vendor/fonts/fonts.css', '/design/assets/icon.png', '/design/manifest.webmanifest', '/photos/assets/logo-white.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('linear-design-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const immutable = url.pathname.startsWith('/design/vendor/') || url.pathname.startsWith('/pdf/vendor/');
  if (immutable) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; })));
    return;
  }
  if (!url.pathname.startsWith('/design/') && url.pathname !== '/photos/assets/logo-white.png') return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req.mode === 'navigate' ? '/design/' : req, copy)); }
    return res;
  }).catch(() => caches.match(req.mode === 'navigate' ? '/design/' : req, { ignoreSearch: true }).then(hit => hit || Response.error())));
});
