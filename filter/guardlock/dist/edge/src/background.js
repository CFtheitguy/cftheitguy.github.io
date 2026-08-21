/* GuardLock — background logic (Chromium service worker / Firefox event page). */
(function () {
  'use strict';

  const {
    api, CATEGORIES, callApi, getLocal, setLocal, getSettings, saveSettings,
    randomHex, hashSecret, safeEqual, hostOf, setMatchesHost, normalizeDomain, isDnrDomain,
    isFilterableUrl, scoreText, safeSearchUrl
  } = globalThis.GL;

  const BLOCKED_PAGE = 'src/ui/blocked.html';
  const CHUNK = 1000;            // domains per declarativeNetRequest rule
  const MAX_DOMAINS = 300000;    // hard cap so rule sync stays inside browser limits
  const RULE_IDS = {
    allowStart: 1,
    mainStart: 1000,
    subStart: 50000,
    youtube: 99001
  };
  const SUB_RESOURCES = [
    'sub_frame', 'script', 'image', 'media', 'xmlhttprequest',
    'font', 'stylesheet', 'object', 'ping', 'websocket', 'other'
  ];

  /* Pages that would let someone switch the filter off. */
  const SETTINGS_PAGES = /^(chrome|edge|brave|opera|vivaldi):\/\/(extensions|settings\/content)|^about:(addons|debugging|config|profiles|support)/i;

  /* ------------------------------------------------------- in-memory state */

  let matcher = { block: new Set(), allow: new Set(), byDomain: new Map(), keywords: [] };
  let ready = null;
  const lastAttempt = new Map();   // tabId -> {url, reason, category, at}

  /* -------------------------------------------------------- session unlock */

  const memSession = {};
  const hasSessionStore = !!(api.storage && api.storage.session);

  async function sessionGet(key) {
    if (!hasSessionStore) return memSession[key];
    const o = await callApi(api.storage.session, 'get', key);
    return (o || {})[key];
  }
  async function sessionSet(key, value) {
    if (!hasSessionStore) { memSession[key] = value; return; }
    return callApi(api.storage.session, 'set', { [key]: value });
  }
  async function sessionClear(key) {
    if (!hasSessionStore) { delete memSession[key]; return; }
    return callApi(api.storage.session, 'remove', key);
  }

  async function isUnlocked() {
    const until = await sessionGet('unlockedUntil');
    if (!until) return false;
    if (Date.now() > until) { await sessionClear('unlockedUntil'); return false; }
    return true;
  }

  async function beginUnlock() {
    const s = await getSettings();
    const ms = Math.max(1, Number(s.unlockMinutes) || 5) * 60000;
    await sessionSet('unlockedUntil', Date.now() + ms);
    api.alarms.create('gl-relock', { when: Date.now() + ms + 1000 });
    await refreshBadge();
    return ms;
  }

  async function lockNow() {
    await sessionClear('unlockedUntil');
    api.alarms.clear('gl-relock');
    await refreshBadge();
  }

  /* -------------------------------------------------------------- the lock */

  async function getLock() {
    const { lock } = await getLocal('lock');
    return lock || null;
  }

  async function hasPin() {
    return !!(await getLock());
  }

  /** Exponential backoff after wrong PINs: 5s, 10s, 20s ... capped at 15 min. */
  async function lockoutRemaining() {
    const { attempts } = await getLocal('attempts');
    const a = attempts || { count: 0, until: 0 };
    return a.until > Date.now() ? a.until - Date.now() : 0;
  }

  async function noteFailure() {
    const { attempts } = await getLocal('attempts');
    const a = attempts || { count: 0, until: 0 };
    a.count += 1;
    if (a.count >= 3) {
      const backoff = Math.min(15 * 60000, 5000 * Math.pow(2, a.count - 3));
      a.until = Date.now() + backoff;
    }
    await setLocal({ attempts: a });
    return a;
  }

  async function clearFailures() {
    await setLocal({ attempts: { count: 0, until: 0 } });
  }

  async function verifyPin(pin) {
    const lock = await getLock();
    if (!lock) return { ok: false, error: 'No PIN is set yet.' };
    const waitMs = await lockoutRemaining();
    if (waitMs > 0) {
      return { ok: false, error: `Too many wrong tries. Wait ${Math.ceil(waitMs / 1000)}s.`, waitMs };
    }
    const hash = await hashSecret(String(pin), lock.salt, lock.iterations);
    if (!safeEqual(hash, lock.hash)) {
      const a = await noteFailure();
      const again = await lockoutRemaining();
      return {
        ok: false,
        error: again > 0
          ? `Wrong PIN. Locked out for ${Math.ceil(again / 1000)}s.`
          : `Wrong PIN. ${Math.max(0, 3 - a.count)} tries left before a lockout.`,
        waitMs: again
      };
    }
    await clearFailures();
    return { ok: true };
  }

  async function setPin(newPin, currentPin) {
    if (!/^\d{4,12}$/.test(String(newPin || ''))) {
      return { ok: false, error: 'PIN must be 4 to 12 digits.' };
    }
    const existing = await getLock();
    if (existing) {
      const unlocked = await isUnlocked();
      if (!unlocked) {
        const check = await verifyPin(currentPin);
        if (!check.ok) return check;
      }
    }
    const salt = randomHex(16);
    const iterations = globalThis.GL.PBKDF2_ITERATIONS;
    const hash = await hashSecret(String(newPin), salt, iterations);

    // A one-time recovery code, shown once, so a forgotten PIN is not fatal.
    const recovery = randomHex(5).toUpperCase().match(/.{1,5}/g).join('-');
    const rSalt = randomHex(16);
    const rHash = await hashSecret(recovery, rSalt, iterations);

    await setLocal({
      lock: { salt, hash, iterations, createdAt: Date.now() },
      recovery: { salt: rSalt, hash: rHash, iterations }
    });
    await clearFailures();
    await beginUnlock();
    return { ok: true, recovery };
  }

  async function useRecovery(code, newPin) {
    const { recovery } = await getLocal('recovery');
    if (!recovery) return { ok: false, error: 'No recovery code on file.' };
    const waitMs = await lockoutRemaining();
    if (waitMs > 0) return { ok: false, error: `Locked out. Wait ${Math.ceil(waitMs / 1000)}s.` };
    const hash = await hashSecret(String(code || '').trim().toUpperCase(), recovery.salt, recovery.iterations);
    if (!safeEqual(hash, recovery.hash)) {
      await noteFailure();
      return { ok: false, error: 'That recovery code does not match.' };
    }
    await clearFailures();
    await sessionSet('unlockedUntil', Date.now() + 10 * 60000);
    const result = await setPin(newPin, null);
    return result;
  }

  /* ------------------------------------------------------ building the set */

  async function loadBundled(file) {
    try {
      const res = await fetch(api.runtime.getURL(file));
      return await res.json();
    } catch (e) {
      console.warn('GuardLock: could not load', file, e);
      return { domains: [], terms: [] };
    }
  }

  async function rebuildMatcher() {
    const settings = await getSettings();
    const block = new Set();
    const byDomain = new Map();

    if (settings.enabled) {
      for (const cat of CATEGORIES) {
        if (!settings.categories[cat.id]) continue;
        const data = await loadBundled(cat.file);
        for (const d of data.domains || []) {
          if (block.size >= MAX_DOMAINS) break;
          block.add(d);
          if (!byDomain.has(d)) byDomain.set(d, cat.id);
        }
      }
      const { remoteData } = await getLocal('remoteData');
      for (const entry of settings.remoteLists || []) {
        if (!entry.enabled) continue;
        for (const d of (remoteData || {})[entry.url] || []) {
          if (block.size >= MAX_DOMAINS) break;
          block.add(d);
          if (!byDomain.has(d)) byDomain.set(d, 'custom');
        }
      }
      for (const d of settings.blocklist || []) {
        block.add(d);
        byDomain.set(d, 'custom');
      }
    }

    const allow = new Set(settings.allowlist || []);
    for (const d of allow) block.delete(d);

    const kw = await loadBundled('src/data/keywords.json');

    matcher = { block, allow, byDomain, keywords: kw.terms || [] };
    await syncRules(settings, block, allow);
    await refreshBadge();
    return matcher;
  }

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  /** Mirrors the matcher into declarativeNetRequest so blocking survives a sleeping worker. */
  async function syncRules(settings, block, allow) {
    if (!api.declarativeNetRequest) return;
    let existing = [];
    try {
      existing = (await callApi(api.declarativeNetRequest, 'getDynamicRules')) || [];
    } catch (e) {
      console.warn('GuardLock: getDynamicRules failed', e);
    }
    const removeRuleIds = existing.map((r) => r.id);
    const addRules = [];

    if (settings.enabled) {
      // IP literals are matched at navigation time instead; feeding one to
      // updateDynamicRules rejects the whole batch.
      chunk([...allow].filter(isDnrDomain), CHUNK).forEach((domains, i) => {
        addRules.push({
          id: RULE_IDS.allowStart + i,
          priority: 100,
          action: { type: 'allow' },
          condition: { requestDomains: domains }
        });
      });

      const blocked = [...block].filter(isDnrDomain);
      chunk(blocked, CHUNK).forEach((domains, i) => {
        addRules.push({
          id: RULE_IDS.mainStart + i,
          priority: 10,
          action: { type: 'redirect', redirect: { extensionPath: '/' + BLOCKED_PAGE } },
          condition: { requestDomains: domains, resourceTypes: ['main_frame'] }
        });
        addRules.push({
          id: RULE_IDS.subStart + i,
          priority: 10,
          action: { type: 'block' },
          condition: { requestDomains: domains, resourceTypes: SUB_RESOURCES }
        });
      });

      // YouTube Restricted Mode is a request header, so it needs no redirect.
      if (settings.safeSearch) {
        addRules.push({
          id: RULE_IDS.youtube,
          priority: 20,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'YouTube-Restrict', operation: 'set', value: 'Strict' }]
          },
          condition: {
            requestDomains: ['youtube.com', 'youtube-nocookie.com', 'youtu.be'],
            resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest']
          }
        });
      }
    }

    try {
      await callApi(api.declarativeNetRequest, 'updateDynamicRules', { removeRuleIds, addRules });
    } catch (e) {
      // Rule limits differ between browsers; degrade to the navigation-time check.
      console.warn('GuardLock: rule sync failed, falling back to live checks', e);
      try {
        await callApi(api.declarativeNetRequest, 'updateDynamicRules',
          { removeRuleIds, addRules: addRules.slice(0, 400) });
      } catch (_) { /* live checks still cover navigation */ }
    }
  }

  /* -------------------------------------------------------------- verdicts */

  /** Decides whether a top-level URL may load. */
  function judge(url, settings) {
    const host = hostOf(url);
    if (!host) return { block: false };

    if (setMatchesHost(matcher.allow, host)) return { block: false, allowed: true };

    const hit = setMatchesHost(matcher.block, host);
    if (hit) {
      return { block: true, reason: 'domain', category: matcher.byDomain.get(hit) || 'custom', matched: hit };
    }

    if (settings.urlKeywordsEnabled && matcher.keywords.length) {
      // Only the path and query — a bare hostname match is handled above.
      let probe = url;
      try {
        const u = new URL(url);
        probe = decodeURIComponent(u.hostname + u.pathname + u.search);
      } catch (_) { /* use the raw string */ }
      const { score, hits } = scoreText(probe, matcher.keywords, 1.5);
      if (score >= settings.keywordThreshold) {
        return { block: true, reason: 'keyword', category: 'keyword', matched: hits.slice(0, 4).join(', '), score };
      }
    }
    return { block: false };
  }

  function blockedUrl(info) {
    const p = new URLSearchParams({
      u: info.url || '',
      r: info.reason || 'domain',
      c: info.category || '',
      m: info.matched || ''
    });
    return api.runtime.getURL(BLOCKED_PAGE) + '?' + p.toString();
  }

  async function sendToBlockPage(tabId, info) {
    lastAttempt.set(tabId, Object.assign({ at: Date.now() }, info));
    try {
      await callApi(api.tabs, 'update', tabId, { url: blockedUrl(info) });
    } catch (e) { /* tab closed mid-navigation */ }
  }

  /* ----------------------------------------------------------- navigation */

  async function onBeforeNavigate(details) {
    if (details.frameId !== 0) return;
    await ready;
    const settings = await getSettings();

    if (SETTINGS_PAGES.test(details.url || '')) {
      if (settings.enabled && settings.guardSettingsPage !== false && !(await isUnlocked())) {
        await sendToBlockPage(details.tabId, {
          url: details.url, reason: 'settings', category: 'protected', matched: 'browser settings'
        });
      }
      return;
    }

    if (!settings.enabled || !isFilterableUrl(details.url)) return;

    const verdict = judge(details.url, settings);
    if (verdict.block) {
      await sendToBlockPage(details.tabId, Object.assign({ url: details.url }, verdict));
      await bumpCount();
      return;
    }

    if (settings.safeSearch) {
      const safe = safeSearchUrl(details.url);
      if (safe) {
        try { await callApi(api.tabs, 'update', details.tabId, { url: safe }); } catch (_) {}
      }
    }
  }

  async function bumpCount() {
    const { stats } = await getLocal('stats');
    const s = stats || { blocked: 0, since: Date.now() };
    s.blocked += 1;
    await setLocal({ stats: s });
  }

  /* ---------------------------------------------------------- remote lists */

  /** Parses hosts files, plain domain lists, and simple adblock-style lines. */
  function parseList(text) {
    const out = new Set();
    for (const raw of String(text).split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      line = line.split('#')[0].trim();
      // hosts file: "0.0.0.0 bad.example"
      const hosts = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+(\S+)/);
      if (hosts) line = hosts[1];
      // adblock: "||bad.example^"
      const abp = line.match(/^\|\|([^\^/$]+)/);
      if (abp) line = abp[1];
      const d = normalizeDomain(line);
      if (d && d !== 'localhost' && d !== 'local') out.add(d);
      if (out.size >= MAX_DOMAINS) break;
    }
    return [...out];
  }

  async function refreshRemoteLists() {
    const settings = await getSettings();
    const lists = settings.remoteLists || [];
    if (!lists.length) return { ok: true, updated: 0 };
    const { remoteData } = await getLocal('remoteData');
    const store = remoteData || {};
    let updated = 0;
    for (const entry of lists) {
      if (!entry.enabled) continue;
      try {
        const res = await fetch(entry.url, { cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const domains = parseList(await res.text());
        if (domains.length) {
          store[entry.url] = domains;
          entry.count = domains.length;
          entry.updated = Date.now();
          entry.error = '';
          updated++;
        } else {
          entry.error = 'List was empty or unparseable.';
        }
      } catch (e) {
        entry.error = String(e.message || e);
      }
    }
    await setLocal({ remoteData: store });
    await saveSettings({ remoteLists: lists });
    await rebuildMatcher();
    return { ok: true, updated };
  }

  /* ----------------------------------------------------------------- badge */

  async function isAllowedInPrivate() {
    try {
      if (api.extension && api.extension.isAllowedIncognitoAccess) {
        return !!(await callApi(api.extension, 'isAllowedIncognitoAccess'));
      }
    } catch (_) {}
    return false;
  }

  async function refreshBadge() {
    if (!api.action) return;
    const settings = await getSettings();
    const priv = await isAllowedInPrivate();
    let text = '';
    let color = '#1f7a3f';
    if (!settings.enabled) { text = 'OFF'; color = '#b00020'; }
    else if (!priv) { text = '!'; color = '#c77700'; }
    else if (await isUnlocked()) { text = 'ᴜ'; color = '#0b5fb0'; }
    try {
      await callApi(api.action, 'setBadgeText', { text });
      await callApi(api.action, 'setBadgeBackgroundColor', { color });
    } catch (_) {}
  }

  /* --------------------------------------------------------------- messages */

  const MUTATING = new Set([
    'setSettings', 'addAllow', 'removeAllow', 'addBlock', 'removeBlock',
    'addRemoteList', 'removeRemoteList', 'setUnlockMinutes'
  ]);

  async function handle(msg, sender) {
    await ready;
    const type = msg && msg.type;

    if (MUTATING.has(type) && !(await isUnlocked())) {
      return { ok: false, error: 'Locked. Enter the PIN first.' };
    }

    switch (type) {
      case 'getState': {
        const settings = await getSettings();
        const { stats } = await getLocal('stats');
        return {
          ok: true,
          settings,
          hasPin: await hasPin(),
          unlocked: await isUnlocked(),
          privateAllowed: await isAllowedInPrivate(),
          blockedCount: matcher.block.size,
          stats: stats || { blocked: 0, since: Date.now() },
          lockoutMs: await lockoutRemaining()
        };
      }
      case 'unlock': {
        const res = await verifyPin(msg.pin);
        if (res.ok) await beginUnlock();
        return res;
      }
      case 'lock':
        await lockNow();
        return { ok: true };
      case 'setPin':
        return await setPin(msg.newPin, msg.currentPin);
      case 'useRecovery':
        return await useRecovery(msg.code, msg.newPin);
      case 'setSettings': {
        await saveSettings(msg.patch || {});
        await rebuildMatcher();
        return { ok: true, settings: await getSettings() };
      }
      case 'addAllow':
      case 'addBlock': {
        const key = type === 'addAllow' ? 'allowlist' : 'blocklist';
        const d = normalizeDomain(msg.domain);
        if (!d) return { ok: false, error: 'That does not look like a domain.' };
        const s = await getSettings();
        const list = new Set(s[key]);
        list.add(d);
        await saveSettings({ [key]: [...list].sort() });
        await rebuildMatcher();
        return { ok: true, settings: await getSettings() };
      }
      case 'removeAllow':
      case 'removeBlock': {
        const key = type === 'removeAllow' ? 'allowlist' : 'blocklist';
        const s = await getSettings();
        await saveSettings({ [key]: (s[key] || []).filter((x) => x !== msg.domain) });
        await rebuildMatcher();
        return { ok: true, settings: await getSettings() };
      }
      case 'addRemoteList': {
        const url = String(msg.url || '').trim();
        if (!/^https:\/\//i.test(url)) return { ok: false, error: 'Use an https:// URL.' };
        const s = await getSettings();
        const lists = (s.remoteLists || []).filter((l) => l.url !== url);
        lists.push({ url, enabled: true, count: 0, updated: 0, error: '' });
        await saveSettings({ remoteLists: lists });
        await refreshRemoteLists();
        return { ok: true, settings: await getSettings() };
      }
      case 'removeRemoteList': {
        const s = await getSettings();
        const { remoteData } = await getLocal('remoteData');
        const store = remoteData || {};
        delete store[msg.url];
        await setLocal({ remoteData: store });
        await saveSettings({ remoteLists: (s.remoteLists || []).filter((l) => l.url !== msg.url) });
        await rebuildMatcher();
        return { ok: true, settings: await getSettings() };
      }
      case 'refreshLists':
        return await refreshRemoteLists();
      case 'getContentConfig': {
        const settings = await getSettings();
        const host = hostOf(sender && sender.url);
        const allowed = !!setMatchesHost(matcher.allow, host);
        return {
          ok: true,
          active: settings.enabled && settings.keywordsEnabled && !allowed,
          threshold: settings.keywordThreshold,
          terms: matcher.keywords
        };
      }
      case 'keywordVerdict': {
        const settings = await getSettings();
        if (!settings.enabled || !settings.keywordsEnabled) return { ok: true, block: false };
        const tabId = sender && sender.tab && sender.tab.id;
        const url = (sender && sender.url) || '';
        const host = hostOf(url);
        if (setMatchesHost(matcher.allow, host)) return { ok: true, block: false };
        if (typeof tabId === 'number') {
          await sendToBlockPage(tabId, {
            url, reason: 'keyword', category: 'page text',
            matched: (msg.hits || []).slice(0, 4).join(', '), score: msg.score
          });
          await bumpCount();
        }
        return { ok: true, block: true };
      }
      case 'getAttempt': {
        const tabId = msg.tabId != null ? msg.tabId : (sender && sender.tab && sender.tab.id);
        return { ok: true, attempt: lastAttempt.get(tabId) || null };
      }
      case 'openOptions':
        api.runtime.openOptionsPage();
        return { ok: true };
      default:
        return { ok: false, error: 'Unknown request.' };
    }
  }

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handle(msg, sender)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async response
  });

  /* ----------------------------------------------------------------- wiring */

  api.webNavigation.onBeforeNavigate.addListener((d) => { onBeforeNavigate(d); });
  api.webNavigation.onCommitted.addListener((d) => { onBeforeNavigate(d); });
  api.webNavigation.onHistoryStateUpdated.addListener((d) => { onBeforeNavigate(d); });

  api.tabs.onRemoved.addListener((tabId) => lastAttempt.delete(tabId));

  api.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'gl-relock') await lockNow();
    if (alarm.name === 'gl-refresh-lists') await refreshRemoteLists();
  });

  api.runtime.onInstalled.addListener(async (details) => {
    await getSettings();
    const s = await getSettings();
    if (!s.installedAt) await saveSettings({ installedAt: Date.now() });
    await rebuildMatcher();
    api.alarms.create('gl-refresh-lists', { periodInMinutes: 60 * 12 });
    if (details.reason === 'install' || !(await hasPin())) {
      api.tabs.create({ url: api.runtime.getURL('src/ui/options.html?welcome=1') });
    }
  });

  api.runtime.onStartup && api.runtime.onStartup.addListener(async () => {
    await lockNow();
    await rebuildMatcher();
  });

  ready = rebuildMatcher();
})();
