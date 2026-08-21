/* GuardLock — page-text keyword scan.
 * Catches pages that are not on any domain list (new sites, search results,
 * image boards). Runs once at load, then re-checks a few times for SPAs. */
(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  if (window.top !== window) return; // top-level documents only

  /* Chromium takes a callback here, Firefox returns a promise and rejects the
     extra argument. Content scripts do not load common.js, so this is a
     trimmed copy of the same shim. */
  function send(msg) {
    return new Promise((resolve) => {
      let ret;
      try {
        ret = api.runtime.sendMessage(msg, (res) => {
          void api.runtime.lastError;   // reading it suppresses the console noise
          resolve(res);
        });
      } catch (_) {
        try { ret = api.runtime.sendMessage(msg); } catch (e) { return resolve(null); }
      }
      if (ret && typeof ret.then === 'function') ret.then(resolve, () => resolve(null));
    });
  }

  let config = null;
  let done = false;

  function visibleText() {
    const body = document.body;
    if (!body) return '';
    // innerText respects display:none, which keeps hidden SEO spam out of the score.
    const text = (document.title || '') + '\n' + (body.innerText || '');
    return text.slice(0, 200000);
  }

  function metaText() {
    let out = '';
    for (const sel of ['meta[name="description"]', 'meta[name="keywords"]', 'meta[property="og:title"]', 'meta[property="og:description"]']) {
      const el = document.querySelector(sel);
      if (el && el.content) out += ' ' + el.content;
    }
    return out;
  }

  function score(text) {
    const hay = text.toLowerCase();
    let total = 0;
    const hits = [];
    for (const { t, w } of config.terms) {
      let from = 0, count = 0;
      while (count < 3) {
        const at = hay.indexOf(t, from);
        if (at === -1) break;
        count++;
        from = at + t.length;
      }
      if (count > 0) {
        total += w * (1 + (count - 1) * 0.5);
        hits.push(t);
      }
    }
    return { total: Math.round(total), hits };
  }

  function curtain() {
    // Hide the content immediately; the background redirect lands a moment later.
    const cover = document.createElement('div');
    cover.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:2147483647', 'background:#101418',
      'color:#e8edf2', 'font:600 18px/1.5 system-ui,Segoe UI,sans-serif',
      'display:flex', 'align-items:center', 'justify-content:center'
    ].join(';'));
    cover.textContent = 'Blocked by GuardLock';
    (document.documentElement || document).appendChild(cover);
  }

  function check() {
    if (done || !config || !config.active) return;
    const { total, hits } = score(visibleText() + metaText());
    if (total >= config.threshold) {
      done = true;
      curtain();
      send({ type: 'keywordVerdict', score: total, hits });
    }
  }

  send({ type: 'getContentConfig' }).then((res) => {
    if (!res || !res.ok || !res.active) return;
    config = res;
    check();
    // Single-page apps swap content without a navigation event.
    let ticks = 0;
    const timer = setInterval(() => {
      if (done || ++ticks > 6) return clearInterval(timer);
      check();
    }, 1500);
  });
})();
