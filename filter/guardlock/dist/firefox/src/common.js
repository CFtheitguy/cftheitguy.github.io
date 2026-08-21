/* GuardLock — shared helpers.
 * Loaded as a classic script by the background context (via sw.js on Chromium,
 * via background.scripts on Firefox) and by every extension page.
 * Everything hangs off globalThis.GL so it works without ES modules,
 * which Firefox MV3 event pages do not reliably support.
 */
(function () {
  'use strict';

  const api = globalThis.browser || globalThis.chrome;

  const CATEGORIES = [
    { id: 'adult',    file: 'src/data/adult.json',    label: 'Adult content',      defaultOn: true },
    { id: 'gambling', file: 'src/data/gambling.json', label: 'Gambling & betting', defaultOn: true },
    { id: 'social',   file: 'src/data/social.json',   label: 'Social media',       defaultOn: false },
    { id: 'video',    file: 'src/data/video.json',    label: 'Video & streaming',  defaultOn: false },
    { id: 'games',    file: 'src/data/games.json',    label: 'Games',              defaultOn: false }
  ];

  const DEFAULTS = {
    enabled: true,
    categories: { adult: true, gambling: true, social: false, video: false, games: false },
    allowlist: [],           // domains that always pass
    blocklist: [],           // extra domains the owner added
    keywordsEnabled: true,
    keywordThreshold: 12,    // page-text score needed to block
    urlKeywordsEnabled: true,
    safeSearch: true,        // force SafeSearch / Restricted Mode
    guardSettingsPage: true, // bounce navigations to the browser's extensions page while locked
    remoteLists: [],         // [{url, enabled, count, updated}]
    unlockMinutes: 5,        // auto-relock after N minutes
    installedAt: 0
  };

  /* -------------------------------------------------------------- api shims */

  /**
   * Chromium's extension APIs take a callback; Firefox's `browser.*` return a
   * promise and reject the extra argument outright. Everything here goes
   * through one wrapper so the rest of the code can just await.
   */
  function callApi(obj, method, ...args) {
    return new Promise((resolve, reject) => {
      let ret;
      try {
        ret = obj[method](...args, (value) => {
          const err = api.runtime && api.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(value);
        });
      } catch (_) {
        // Firefox: the callback was not part of the signature — retry without it.
        try { ret = obj[method](...args); } catch (e) { return reject(e); }
      }
      if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
    });
  }

  /** Messages the background script. Resolves to a plain error object rather
   *  than throwing, because every caller renders the failure in the UI. */
  function sendMessage(msg) {
    return callApi(api.runtime, 'sendMessage', msg)
      .then((res) => res || { ok: false, error: 'No response from GuardLock.' })
      .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  }

  /* ---------------------------------------------------------------- storage */

  function getLocal(keys) {
    return callApi(api.storage.local, 'get', keys).then((r) => r || {});
  }
  function setLocal(obj) {
    return callApi(api.storage.local, 'set', obj);
  }
  function removeLocal(keys) {
    return callApi(api.storage.local, 'remove', keys);
  }

  async function getSettings() {
    const { settings } = await getLocal('settings');
    const merged = Object.assign({}, DEFAULTS, settings || {});
    merged.categories = Object.assign({}, DEFAULTS.categories, (settings || {}).categories || {});
    return merged;
  }
  async function saveSettings(patch) {
    const current = await getSettings();
    const next = Object.assign({}, current, patch);
    if (patch && patch.categories) {
      next.categories = Object.assign({}, current.categories, patch.categories);
    }
    await setLocal({ settings: next });
    return next;
  }

  /* ----------------------------------------------------------------- crypto */

  const PBKDF2_ITERATIONS = 210000;

  function toHex(buf) {
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function randomHex(bytes) {
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return toHex(a);
  }

  async function hashSecret(secret, saltHex, iterations) {
    const iters = iterations || PBKDF2_ITERATIONS;
    const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, key, 256
    );
    return toHex(bits);
  }

  /** Constant-time-ish comparison for equal-length hex strings. */
  function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /* ------------------------------------------------------------------- urls */

  /** Hostname without a leading "www.", lowercased. Returns '' when unparseable. */
  function hostOf(url) {
    try {
      const h = new URL(url).hostname.toLowerCase();
      return h.startsWith('www.') ? h.slice(4) : h;
    } catch (_) {
      return '';
    }
  }

  /** example.co.uk -> ["example.co.uk", "co.uk", "uk"] */
  function domainChain(host) {
    const out = [];
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'));
    return out;
  }

  /** True when host, or any parent domain of it, is in the set. */
  function setMatchesHost(set, host) {
    if (!host || !set || set.size === 0) return false;
    for (const candidate of domainChain(host)) {
      if (set.has(candidate)) return candidate;
    }
    return false;
  }

  const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

  /** Accepts "https://a.com/x", "a.com", "*.a.com", "10.0.0.5" — or '' if unusable. */
  function normalizeDomain(input) {
    let s = String(input || '').trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z]+:\/\//, '').replace(/^\*\./, '').replace(/^www\./, '');
    s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
    if (IPV4.test(s)) return s.split('.').every((o) => Number(o) < 256) ? s : '';
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return '';
    return s;
  }

  /** declarativeNetRequest only takes real domain names, not IP literals. */
  function isDnrDomain(d) {
    return !IPV4.test(d);
  }

  /** Only http(s) pages are filterable; skip about:, moz-extension:, etc. */
  function isFilterableUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  /* --------------------------------------------------------------- keywords */

  /**
   * Scores text against the weighted term list.
   * `multiplier` lets callers weigh URL hits heavier than body-text hits.
   */
  function scoreText(text, terms, multiplier) {
    const hay = String(text || '').toLowerCase();
    if (!hay) return { score: 0, hits: [] };
    const mult = multiplier || 1;
    let score = 0;
    const hits = [];
    for (const { t, w } of terms) {
      let from = 0, count = 0;
      while (count < 3) {
        const at = hay.indexOf(t, from);
        if (at === -1) break;
        count++;
        from = at + t.length;
      }
      if (count > 0) {
        score += w * mult * (1 + (count - 1) * 0.5);
        hits.push(t);
      }
    }
    return { score: Math.round(score), hits };
  }

  /* ------------------------------------------------------------ safe search */

  /** Search engines we can pin into a safe mode, and how. */
  const SAFE_SEARCH = [
    { match: /^(www\.)?google\.[a-z.]{2,}$/, params: { safe: 'active' } },
    { match: /^(www\.)?bing\.com$/,          params: { adlt: 'strict' } },
    { match: /^(www\.)?duckduckgo\.com$/,    params: { kp: '1' } },
    { match: /^(www\.)?search\.yahoo\.com$/, params: { vm: 'r' } },
    { match: /^(www\.)?yandex\.[a-z.]{2,}$/, params: { fyandex: '1' } },
    { match: /^(www\.)?ecosia\.org$/,        params: { safeSearch: '1' } },
    { match: /^(www\.)?startpage\.com$/,     params: { qadf: 'heavy' } },
    { match: /^(www\.)?brave\.com$/,         params: { safesearch: 'strict' } },
    { match: /^search\.brave\.com$/,         params: { safesearch: 'strict' } }
  ];

  /**
   * Returns a corrected URL string when SafeSearch params are missing,
   * or null when the URL is already safe / not a search engine.
   * Returning null is what stops redirect loops.
   */
  function safeSearchUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch (_) { return null; }
    const host = u.hostname.toLowerCase();
    const rule = SAFE_SEARCH.find((r) => r.match.test(host));
    if (!rule) return null;
    let changed = false;
    for (const [k, v] of Object.entries(rule.params)) {
      if (u.searchParams.get(k) !== v) {
        u.searchParams.set(k, v);
        changed = true;
      }
    }
    return changed ? u.toString() : null;
  }

  globalThis.GL = {
    api, CATEGORIES, DEFAULTS, PBKDF2_ITERATIONS,
    callApi, sendMessage, getLocal, setLocal, removeLocal, getSettings, saveSettings,
    toHex, randomHex, hashSecret, safeEqual,
    hostOf, domainChain, setMatchesHost, normalizeDomain, isDnrDomain, isFilterableUrl,
    scoreText, safeSearchUrl
  };
})();
