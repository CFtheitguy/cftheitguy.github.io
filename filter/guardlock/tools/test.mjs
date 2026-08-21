/* Runs the real background script against stubbed browser APIs.
 *
 * The whole suite runs twice: once with Chromium-style callback APIs, once
 * with Firefox-style promise APIs. Firefox's browser.* namespace rejects the
 * extra callback argument outright, so a callback-only extension hangs on the
 * first storage read — running both shapes is what catches that.
 *
 *   node tools/test.mjs */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInThisContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0, mode = 'callback', managedConfig = null;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* ------------------------------------------------------------- fake browser */

const local = {};
const session = {};
const calls = { tabUpdates: [], badges: [], created: [] };
let dnrRules = [];
const listeners = { nav: [], msg: [], alarm: [] };

/** Wraps a plain function in whichever calling convention `mode` asks for.
 *  In promise mode the extra callback argument throws, exactly as Firefox does. */
function shape(fn, arity) {
  if (mode === 'promise') {
    return (...args) => {
      if (args.length > arity) throw new TypeError('Incorrect argument types');
      return Promise.resolve(fn(...args));
    };
  }
  return (...args) => {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const value = fn(...args);
    if (cb) cb(value);
  };
}

function store(bag) {
  const read = (keys) => {
    const out = {};
    const list = keys == null ? Object.keys(bag) : (Array.isArray(keys) ? keys : [keys]);
    for (const k of list) if (k in bag) out[k] = structuredClone(bag[k]);
    return out;
  };
  return {
    get: shape(read, 1),
    set: shape((obj) => { Object.assign(bag, structuredClone(obj)); }, 1),
    remove: shape((keys) => { for (const k of [].concat(keys)) delete bag[k]; }, 1)
  };
}

function buildApi() {
globalThis.chrome = {
  runtime: {
    getURL: (p) => 'moz-extension://test/' + p,
    onMessage: { addListener: (fn) => listeners.msg.push(fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    openOptionsPage: () => {},
    lastError: null
  },
  storage: {
    local: store(local),
    session: store(session),
    // Chromium resolves to {} with no policy; Firefox rejects. Both are covered.
    managed: {
      get: shape(() => {
        if (managedConfig === null) {
          if (mode === 'promise') throw new Error('Managed storage manifest not found');
          return {};
        }
        return structuredClone(managedConfig);
      }, 1)
    },
    onChanged: { addListener: () => {} }
  },
  webNavigation: {
    onBeforeNavigate: { addListener: (fn) => listeners.nav.push(fn) },
    onCommitted: { addListener: () => {} },
    onHistoryStateUpdated: { addListener: () => {} }
  },
  tabs: {
    update: shape((id, props) => { calls.tabUpdates.push({ id, url: props.url }); }, 2),
    create: (props) => calls.created.push(props),
    onRemoved: { addListener: () => {} }
  },
  alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: (fn) => listeners.alarm.push(fn) } },
  action: {
    setBadgeText: shape((o) => { calls.badges.push(o.text); }, 1),
    setBadgeBackgroundColor: shape(() => {}, 1)
  },
  extension: { isAllowedIncognitoAccess: shape(() => false, 0) },
  declarativeNetRequest: {
    getDynamicRules: shape(() => dnrRules, 0),
    updateDynamicRules: shape(({ removeRuleIds, addRules }) => {
      dnrRules = dnrRules.filter((r) => !removeRuleIds.includes(r.id)).concat(addRules || []);
    }, 1)
  }
};
}

const REMOTE_FIXTURE = `# a hosts-style list
0.0.0.0 badsite.example
0.0.0.0 www.other.example
127.0.0.1 localhost
||abpstyle.example^
plain.example
! comment line
not-a-domain
`;

globalThis.fetch = async (url) => {
  if (String(url).startsWith('https://')) {
    if (String(url).includes('fail')) throw new Error('network down');
    return { ok: true, text: async () => REMOTE_FIXTURE };
  }
  const rel = String(url).replace('moz-extension://test/', '');
  const text = readFileSync(join(ROOT, rel), 'utf8');
  return { ok: true, json: async () => JSON.parse(text), text: async () => text };
};

/** Wipes all state and loads the extension exactly as a browser would load a
 *  classic script, so each run starts from a fresh profile. */
function loadExtension(which, policy) {
  mode = which;
  managedConfig = policy === undefined ? null : policy;
  for (const k of Object.keys(local)) delete local[k];
  for (const k of Object.keys(session)) delete session[k];
  dnrRules = [];
  listeners.nav.length = 0;
  listeners.msg.length = 0;
  listeners.alarm.length = 0;
  calls.tabUpdates.length = 0;
  calls.badges.length = 0;
  calls.created.length = 0;
  delete globalThis.GL;
  buildApi();
  for (const f of ['src/common.js', 'src/background.js']) {
    runInThisContext(readFileSync(join(ROOT, f), 'utf8'), { filename: f });
  }
}

/* These read listeners[...] at call time, so they follow each fresh load. */
const send = (msg, sender = {}) =>
  new Promise((resolve) => listeners.msg[0](msg, sender, resolve));
const navigate = (url, tabId = 7) =>
  listeners.nav[0]({ frameId: 0, tabId, url });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSuite(which) {
  loadExtension(which);

/* -------------------------------------------------------------------- tests */

const GL = globalThis.GL;

if (mode === 'promise') {
  let threw = false;
  try { globalThis.chrome.storage.local.get('x', () => {}); } catch (_) { threw = true; }
  console.log('\nharness');
  check('the promise-mode stub refuses a callback, exactly as Firefox does', threw);
}

console.log('\nurl helpers');
eq('hostOf strips www', GL.hostOf('https://www.Example.com/a?b'), 'example.com');
eq('hostOf rejects junk', GL.hostOf('not a url'), '');
eq('normalizeDomain from url', GL.normalizeDomain('HTTPS://www.Bad.Example.com/path'), 'bad.example.com');
eq('normalizeDomain from wildcard', GL.normalizeDomain('*.bad.com'), 'bad.com');
eq('normalizeDomain rejects bare word', GL.normalizeDomain('localhost'), '');
eq('domainChain', GL.domainChain('a.b.co.uk'), ['a.b.co.uk', 'b.co.uk', 'co.uk']);
check('setMatchesHost matches parent', GL.setMatchesHost(new Set(['bad.com']), 'cdn.x.bad.com') === 'bad.com');
check('setMatchesHost no false positive', GL.setMatchesHost(new Set(['bad.com']), 'notbad.com') === false);
check('isFilterableUrl skips about:', GL.isFilterableUrl('about:addons') === false);

console.log('\nsafe search');
check('google gets safe=active',
  GL.safeSearchUrl('https://www.google.com/search?q=x').includes('safe=active'));
check('already-safe google returns null (no redirect loop)',
  GL.safeSearchUrl('https://www.google.com/search?q=x&safe=active') === null);
check('bing gets adlt=strict',
  GL.safeSearchUrl('https://www.bing.com/search?q=x').includes('adlt=strict'));
check('duckduckgo gets kp=1',
  GL.safeSearchUrl('https://duckduckgo.com/?q=x').includes('kp=1'));
check('non-search site untouched', GL.safeSearchUrl('https://news.ycombinator.com/') === null);
check('google.co.uk handled', GL.safeSearchUrl('https://www.google.co.uk/search?q=x') !== null);

await sleep(50); // let the initial rebuildMatcher settle

console.log('\ndefault state');
let st = await send({ type: 'getState' });
check('state loads', st.ok, st);
check('bundled lists loaded (>300 domains)', st.blockedCount > 300, st.blockedCount);
check('no PIN initially', st.hasPin === false);
check('locked initially', st.unlocked === false);
eq('adult + gambling on by default',
  [st.settings.categories.adult, st.settings.categories.gambling, st.settings.categories.social],
  [true, true, false]);

console.log('\nblocking');
calls.tabUpdates.length = 0;
await navigate('https://www.pornhub.com/video?x=1');
await sleep(20);
check('known adult domain is blocked',
  calls.tabUpdates.some((u) => u.url.includes('blocked.html')), calls.tabUpdates);
check('block page carries the original url',
  decodeURIComponent(calls.tabUpdates[0].url).includes('pornhub.com'));

calls.tabUpdates.length = 0;
await navigate('https://cdn.media.xvideos.com/thing');
await sleep(20);
check('subdomain of a listed domain is blocked', calls.tabUpdates.length === 1, calls.tabUpdates);

calls.tabUpdates.length = 0;
await navigate('https://en.wikipedia.org/wiki/Cat');
await sleep(20);
check('ordinary site is not blocked', calls.tabUpdates.length === 0, calls.tabUpdates);

calls.tabUpdates.length = 0;
await navigate('https://example.com/free-porn-videos-xxx/');
await sleep(20);
check('url keywords block an unlisted site',
  calls.tabUpdates.some((u) => u.url.includes('r=keyword')), calls.tabUpdates);

calls.tabUpdates.length = 0;
await navigate('https://www.google.com/search?q=hello');
await sleep(20);
check('search is redirected to SafeSearch',
  calls.tabUpdates.length === 1 && calls.tabUpdates[0].url.includes('safe=active'), calls.tabUpdates);

calls.tabUpdates.length = 0;
await navigate('https://www.google.com/search?q=hello&safe=active');
await sleep(20);
check('safe search does not loop', calls.tabUpdates.length === 0, calls.tabUpdates);

console.log('\ndeclarativeNetRequest rules');
check('rules were installed', dnrRules.length > 0, dnrRules.length);
check('rule ids are unique', new Set(dnrRules.map((r) => r.id)).size === dnrRules.length);
check('every rule has a condition + action',
  dnrRules.every((r) => r.condition && r.action && r.id > 0));
check('main_frame rules redirect to the block page',
  dnrRules.some((r) => r.action.type === 'redirect' &&
    r.condition.resourceTypes && r.condition.resourceTypes[0] === 'main_frame'));
check('sub-resources are blocked outright',
  dnrRules.some((r) => r.action.type === 'block'));
check('youtube restricted-mode header rule present',
  dnrRules.some((r) => r.action.type === 'modifyHeaders'));
check('rule count is inside browser limits (5000)', dnrRules.length < 5000, dnrRules.length);

console.log('\nthe lock');
let r = await send({ type: 'setSettings', patch: { enabled: false } });
check('settings refuse to change while locked', r.ok === false, r);

r = await send({ type: 'setPin', newPin: '12' });
check('short PIN rejected', r.ok === false, r);

r = await send({ type: 'setPin', newPin: '4821' });
check('PIN accepted', r.ok === true, r);
check('recovery code issued', /^[0-9A-F]{5}-[0-9A-F]{5}$/.test(r.recovery || ''), r.recovery);
const recovery = r.recovery;
check('PIN is not stored in the clear',
  !JSON.stringify(local).includes('4821'), Object.keys(local));

st = await send({ type: 'getState' });
check('unlocked right after setup', st.unlocked === true);

r = await send({ type: 'setSettings', patch: { enabled: false } });
check('settings change once unlocked', r.ok === true, r);
await send({ type: 'setSettings', patch: { enabled: true } });

await send({ type: 'lock' });
st = await send({ type: 'getState' });
check('lock takes effect', st.unlocked === false);

r = await send({ type: 'unlock', pin: '9999' });
check('wrong PIN refused', r.ok === false, r);
r = await send({ type: 'unlock', pin: '4821' });
check('right PIN unlocks', r.ok === true, r);

await send({ type: 'lock' });
for (let i = 0; i < 3; i++) await send({ type: 'unlock', pin: '0000' });
r = await send({ type: 'unlock', pin: '4821' });
check('lockout blocks even the correct PIN', r.ok === false && r.waitMs > 0, r);

console.log('\nrecovery');
local.attempts = { count: 0, until: 0 };
r = await send({ type: 'useRecovery', code: 'AAAAA-AAAAA', newPin: '5555' });
check('bad recovery code refused', r.ok === false, r);
local.attempts = { count: 0, until: 0 };
r = await send({ type: 'useRecovery', code: recovery, newPin: '5555' });
check('good recovery code resets the PIN', r.ok === true, r);
await send({ type: 'lock' });
r = await send({ type: 'unlock', pin: '5555' });
check('new PIN works', r.ok === true, r);

console.log('\nallow / block lists');
r = await send({ type: 'addBlock', domain: 'https://www.timewaster.example/x' });
check('custom block accepts a full url', r.ok === true, r);
check('…and stores the bare domain', r.settings.blocklist.includes('timewaster.example'), r.settings.blocklist);
calls.tabUpdates.length = 0;
await navigate('https://timewaster.example/');
await sleep(20);
check('custom blocked domain is blocked', calls.tabUpdates.length === 1, calls.tabUpdates);

r = await send({ type: 'addAllow', domain: 'pornhub.com' });
check('allow entry added', r.ok === true, r);
calls.tabUpdates.length = 0;
await navigate('https://www.pornhub.com/');
await sleep(20);
check('allowlist beats the category list', calls.tabUpdates.length === 0, calls.tabUpdates);
check('allowed domain left the dnr block set',
  !dnrRules.some((r2) => r2.action.type === 'block' &&
    (r2.condition.requestDomains || []).includes('pornhub.com')));
await send({ type: 'removeAllow', domain: 'pornhub.com' });
calls.tabUpdates.length = 0;
await navigate('https://www.pornhub.com/');
await sleep(20);
check('removing the allow entry restores the block', calls.tabUpdates.length === 1, calls.tabUpdates);

r = await send({ type: 'addAllow', domain: 'nonsense' });
check('junk domain rejected', r.ok === false, r);
r = await send({ type: 'addAllow', domain: '192.168.1.50' });
check('ip address accepted', r.ok === true, r);
check('ip address kept out of the dnr rules',
  !dnrRules.some((r2) => (r2.condition.requestDomains || []).includes('192.168.1.50')));
r = await send({ type: 'addAllow', domain: '999.1.1.1' });
check('impossible ip rejected', r.ok === false, r);
await send({ type: 'removeAllow', domain: '192.168.1.50' });

console.log('\nsettings-page guard');
calls.tabUpdates.length = 0;
await send({ type: 'lock' });
await navigate('about:addons');
await sleep(20);
check('about:addons is bounced while locked',
  calls.tabUpdates.some((u) => u.url.includes('r=settings')), calls.tabUpdates);

calls.tabUpdates.length = 0;
await navigate('edge://extensions');
await sleep(20);
check('edge://extensions is bounced while locked', calls.tabUpdates.length === 1, calls.tabUpdates);

calls.tabUpdates.length = 0;
await send({ type: 'unlock', pin: '5555' });
await navigate('about:addons');
await sleep(20);
check('about:addons opens once unlocked', calls.tabUpdates.length === 0, calls.tabUpdates);

console.log('\nkeyword page scan');
r = await send({ type: 'getContentConfig' }, { url: 'https://example.com/' });
check('content script gets its config', r.ok && r.active === true && r.terms.length > 0, { active: r.active });
calls.tabUpdates.length = 0;
r = await send({ type: 'keywordVerdict', score: 40, hits: ['porn'] }, { url: 'https://sketchy.example/', tab: { id: 9 } });
check('page-text verdict blocks the tab', r.block === true && calls.tabUpdates.length === 1, calls.tabUpdates);

console.log('\nsubscribed blocklists');
r = await send({ type: 'addRemoteList', url: 'http://insecure.example/list.txt' });
check('plain http list refused', r.ok === false, r);
r = await send({ type: 'addRemoteList', url: 'https://lists.example/porn.txt' });
check('https list accepted', r.ok === true, r);
const sub = r.settings.remoteLists[0];
eq('parsed every supported line format', sub.count, 4);
calls.tabUpdates.length = 0;
await navigate('https://badsite.example/');
await sleep(20);
check('hosts-file entry blocks', calls.tabUpdates.length === 1, calls.tabUpdates);
calls.tabUpdates.length = 0;
await navigate('https://deep.abpstyle.example/x');
await sleep(20);
check('||domain^ entry blocks', calls.tabUpdates.length === 1, calls.tabUpdates);
calls.tabUpdates.length = 0;
await navigate('https://www.other.example/');
await sleep(20);
check('www. is stripped from list entries', calls.tabUpdates.length === 1, calls.tabUpdates);
r = await send({ type: 'addRemoteList', url: 'https://lists.example/fail.txt' });
check('a failing download does not throw', r.ok === true, r);
check('…and is recorded as an error',
  (r.settings.remoteLists.find((l) => l.url.includes('fail')) || {}).error, r.settings.remoteLists);
r = await send({ type: 'removeRemoteList', url: 'https://lists.example/porn.txt' });
calls.tabUpdates.length = 0;
await navigate('https://badsite.example/');
await sleep(20);
check('removing a subscription drops its domains', calls.tabUpdates.length === 0, calls.tabUpdates);
await send({ type: 'removeRemoteList', url: 'https://lists.example/fail.txt' });

console.log('\nmaster switch');
await send({ type: 'setSettings', patch: { enabled: false } });
calls.tabUpdates.length = 0;
await navigate('https://www.pornhub.com/');
await sleep(20);
check('nothing is blocked when filtering is off', calls.tabUpdates.length === 0, calls.tabUpdates);
check('dnr rules are cleared when filtering is off', dnrRules.length === 0, dnrRules.length);
await send({ type: 'setSettings', patch: { enabled: true } });
check('rules come back when filtering is on', dnrRules.length > 0, dnrRules.length);


}


/* ------------------------------------------------------ provisioned by policy */

async function runManaged(which) {
  console.log(`\n===== provisioned by policy (${which} APIs) =====`);

  // Exactly what tools/provision.mjs emits.
  const PIN = '7391';
  const saltHex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await webcrypto.subtle.importKey(
    'raw', new TextEncoder().encode(PIN), 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, key, 256);
  const hashHex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');

  const policy = {
    lockSalt: saltHex,
    lockHash: hashHex,
    lockIterations: 210000,
    enabled: true,
    safeSearch: true,
    guardSettingsPage: true,
    categories: { adult: true, gambling: true, social: true, video: false, games: false },
    allowlist: ['wikipedia.org'],
    blocklist: ['timewaster.example'],
    remoteLists: ['https://lists.example/porn.txt']
  };

  loadExtension(which, policy);
  await sleep(150);

  let st = await send({ type: 'getState' });
  check('a provisioned profile is locked on first run', st.hasPin === true && st.unlocked === false, st);
  check('no setup tab is opened on a provisioned machine', calls.created.length === 0, calls.created);
  check('policy is reported to the UI', st.managed && st.managed.active === true, st.managed);
  check('policy categories are applied',
    st.settings.categories.social === true && st.settings.categories.games === false,
    st.settings.categories);
  check('policy allowlist is applied', st.settings.allowlist.includes('wikipedia.org'), st.settings.allowlist);
  check('policy blocklist is applied', st.settings.blocklist.includes('timewaster.example'), st.settings.blocklist);
  check('policy subscription is applied',
    (st.settings.remoteLists || []).some((l) => l.url === 'https://lists.example/porn.txt'),
    st.settings.remoteLists);

  // The filter is live before anyone touches the browser.
  calls.tabUpdates.length = 0;
  await navigate('https://www.pornhub.com/');
  await sleep(20);
  check('filtering is already live before any human interaction', calls.tabUpdates.length === 1, calls.tabUpdates);

  calls.tabUpdates.length = 0;
  await navigate('https://timewaster.example/');
  await sleep(20);
  check('a policy blocklist entry blocks', calls.tabUpdates.length === 1, calls.tabUpdates);

  calls.tabUpdates.length = 0;
  await navigate('https://en.wikipedia.org/wiki/Cat');
  await sleep(20);
  check('a policy allowlist entry passes', calls.tabUpdates.length === 0, calls.tabUpdates);

  // The provisioned PIN is the one that works.
  let r = await send({ type: 'unlock', pin: '0000' });
  check('a wrong PIN is refused on a provisioned machine', r.ok === false, r);
  r = await send({ type: 'unlock', pin: PIN });
  check('the provisioned PIN unlocks', r.ok === true, r);

  // Policy-pinned settings stay pinned even for someone holding the PIN.
  r = await send({ type: 'setSettings', patch: { enabled: false } });
  check('policy-pinned settings refuse changes even when unlocked', r.ok === false, r);
  check('…and the refusal names the setting', /enabled/.test(r.error || ''), r.error);
  r = await send({ type: 'setSettings', patch: { categories: { social: false } } });
  check('policy-pinned categories cannot be switched off', r.ok === false, r);

  r = await send({ type: 'removeAllow', domain: 'wikipedia.org' });
  check('policy allowlist entries cannot be removed', r.ok === false, r);
  r = await send({ type: 'removeBlock', domain: 'timewaster.example' });
  check('policy blocklist entries cannot be removed', r.ok === false, r);
  r = await send({ type: 'removeRemoteList', url: 'https://lists.example/porn.txt' });
  check('policy subscriptions cannot be removed', r.ok === false, r);

  // Anything policy does not pin is still the owner's to change.
  r = await send({ type: 'addAllow', domain: 'example.org' });
  check('the owner can still add their own allow entries', r.ok === true, r);
  check('…alongside the policy ones', r.settings.allowlist.includes('wikipedia.org'), r.settings.allowlist);
  r = await send({ type: 'setSettings', patch: { keywordThreshold: 20 } });
  check('unpinned settings remain editable', r.ok === true, r);

  // A machine that already has its own PIN must not have it overwritten.
  loadExtension(which);
  await sleep(120);
  await send({ type: 'setPin', newPin: '1234' });
  await send({ type: 'lock' });
  managedConfig = policy;
  await send({ type: 'getState' });
  const owner = await send({ type: 'unlock', pin: '1234' });
  check('a PIN set by the owner survives a later policy', owner.ok === true, owner);
}

for (const which of ['callback', 'promise']) {
  console.log(`\n===== ${which === 'callback' ? 'Chromium-style callback' : 'Firefox-style promise'} APIs =====`);
  await runSuite(which);
}

await runManaged('callback');
await runManaged('promise');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
