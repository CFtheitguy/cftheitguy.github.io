/* Loads the built extension into a real Chromium and drives it end to end.
 *
 *   node tools/e2e.mjs
 *
 * Needs playwright and openssl. A throwaway HTTPS server stands in for the
 * whole web: --host-resolver-rules points every hostname at it, so the test
 * can use real-looking domains (pornhub.com, google.com) without ever leaving
 * the machine. HTTPS rather than HTTP because Chromium force-upgrades the
 * HSTS-preloaded domains this test relies on. */
import { chromium } from 'playwright';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'dist', 'edge');

const SHOTS = process.env.SHOTS || mkdtempSync(join(tmpdir(), 'gl-shots-'));
const PORT = 8443;
const PIN = '2468';

let pass = 0, fail = 0;
const check = (n, c, x) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); }
};

/* ------------------------------------------------------ the stand-in web */

const tmp = mkdtempSync(join(tmpdir(), 'gl-tls-'));
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem'),
  '-days', '1', '-subj', '/CN=localhost'
], { stdio: 'ignore' });

const PAGES = {
  '/': '<title>Ordinary page</title><h1>Ordinary page</h1><p>Nothing to see here.</p>',
  '/free-porn-videos-xxx/': '<title>Blocked by url</title><h1>Should never be visible</h1>',
  '/article': '<title>Just an article</title><h1>Quarterly results</h1><p>Revenue rose.</p>',
  '/explicit': '<title>Innocent looking title</title>' +
    '<p>hardcore sex blowjob cumshot gangbang live sex cam. blowjob deepthroat. ' +
    'free sex, sex chat, hardcore sex, cumshot, blowjob.</p>',
  '/search': '<title>Search results</title><h1>Results</h1>'
};

const server = createServer(
  { key: readFileSync(join(tmp, 'key.pem')), cert: readFileSync(join(tmp, 'cert.pem')) },
  (req, res) => {
    const path = req.url.split('?')[0];
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html>' + (PAGES[path] || PAGES['/']));
  }
);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/* ------------------------------------------------------------- the browser */

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'gl-profile-')), {
  channel: 'chromium',        // new headless mode; the old one cannot load extensions
  headless: true,
  ignoreHTTPSErrors: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--host-resolver-rules=MAP * 127.0.0.1:${PORT}`,
    '--ignore-certificate-errors',
    '--no-proxy-server'   // this box has an outbound HTTPS proxy; bypass it
  ]
});

const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(worker.url()).host;
console.log('\nextension loaded as', extId);
check('service worker started', !!extId);

const errors = [];
ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(String(e))));

const extPage = (name) => `chrome-extension://${extId}/src/ui/${name}`;

/** Polls page.url() until it matches. waitForURL is unreliable here because the
 *  filter aborts the navigation mid-flight, leaving the page in an error state
 *  that its own navigation tracking never recovers from. */
async function settleOn(page, re, wait = 8000) {
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    if (re.test(page.url())) break;
    await page.waitForTimeout(200);
  }
  return page.url();
}

/** Navigates and reports where the browser actually ended up. The filter
 *  cancels the navigation, which surfaces as ERR_ABORTED — that abort is the
 *  block working, so swallow it and read the final url. */
async function land(page, url, wait = 8000) {
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await settleOn(page, /blocked\.html/, wait);
  await page.waitForTimeout(400);
  return page.url();
}

/* ------------------------------------------------------------- setup flow */

console.log('\nsetup flow');
const page = await ctx.newPage();
await page.goto(extPage('options.html'));
await page.waitForSelector('#setup:not([hidden])', { timeout: 10000 });
check('setup card shown when no PIN is set', true);

async function typePin(target, pin, root = '') {
  for (const d of pin) await target.click(`${root} .keys button[data-k="${d}"]`);
  await target.click(`${root} .keys button[data-k="go"]`);
}
await typePin(page, PIN);
await page.waitForTimeout(400);
await typePin(page, PIN);
await page.waitForSelector('#recoveryBox:not([hidden])', { timeout: 10000 });
const recovery = (await page.textContent('#recoveryCode')).trim();
check('recovery code displayed once', /^[0-9A-F]{5}-[0-9A-F]{5}$/.test(recovery), recovery);
check('finish is gated on confirming you saved it', await page.isDisabled('#finishSetup'));
await page.screenshot({ path: join(SHOTS, 'shot-setup.png') });

await page.click('#savedRecovery');
await page.click('#finishSetup');
await page.waitForSelector('#main:not([hidden])', { timeout: 10000 });
check('settings unlocked right after setup', await page.isVisible('#enabled'));
check('adult category on by default', await page.isChecked('#cat-adult'));
check('social category off by default', !(await page.isChecked('#cat-social')));
check('private-window warning is shown', await page.isVisible('.notice.bad'));
await page.screenshot({ path: join(SHOTS, 'shot-settings.png'), fullPage: true });

/* --------------------------------------------------------- live filtering */

console.log('\nlive filtering');
const ok = await ctx.newPage();
await ok.goto('https://safe.example/', { waitUntil: 'domcontentloaded' });
check('ordinary page loads untouched', (await ok.title()) === 'Ordinary page', await ok.title());

const listed = await ctx.newPage();
let landed = await land(listed, 'https://pornhub.com/some/video');
check('a domain from the bundled list is blocked', landed.includes('blocked.html'), landed);
check('block page names the category',
  (await listed.textContent('#reason')).includes('adult'), await listed.textContent('#reason'));
await listed.close();

const sub = await ctx.newPage();
landed = await land(sub, 'https://cdn.videos.xvideos.com/x');
check('subdomains of a listed domain are blocked too', landed.includes('blocked.html'), landed);
await sub.close();

const kw = await ctx.newPage();
landed = await land(kw, 'https://neutral.example/free-porn-videos-xxx/');
check('keyword in the address is blocked', landed.includes('blocked.html'), landed);
check('block page explains it was the address',
  (await kw.textContent('#reason')).includes('web address'), await kw.textContent('#reason'));
check('block page shows the attempted address',
  (await kw.textContent('#site')).includes('free-porn'), await kw.textContent('#site'));
await kw.screenshot({ path: join(SHOTS, 'shot-blocked.png') });

const text = await ctx.newPage();
landed = await land(text, 'https://plainname.example/explicit', 10000);
check('explicit page text is blocked even with a clean address',
  landed.includes('blocked.html'), landed);
check('block page explains it was the page text',
  (await text.textContent('#reason')).includes('page text'), await text.textContent('#reason'));
await text.close();

const article = await ctx.newPage();
await article.goto('https://plainname.example/article', { waitUntil: 'domcontentloaded' });
await article.waitForTimeout(2500);
check('an ordinary article is not caught by the text scan',
  !article.url().includes('blocked.html'), article.url());
await article.close();

// Not google.com: Chromium pins Google certificates, so a stand-in server
// cannot answer for it. Ecosia exercises the same code path.
const search = await ctx.newPage();
await search.goto('https://www.ecosia.org/search?q=hello', { waitUntil: 'domcontentloaded' }).catch(() => {});
await settleOn(search, /safeSearch=1/);
check('search is pinned to SafeSearch', search.url().includes('safeSearch=1'), search.url());
const settled = search.url();
await search.waitForTimeout(1500);
check('SafeSearch redirect does not loop', search.url() === settled, [settled, search.url()]);
await search.close();

/* -------------------------------------------- unlock and allow from a block */

console.log('\nunlock and allow');
await kw.click('#allowBtn');
await kw.waitForSelector('#allowPad .keys');
await typePin(kw, PIN, '#allowPad');
await kw.waitForTimeout(1800);
check('allowing the site navigates back to it', !kw.url().includes('blocked.html'), kw.url());
check('the allowed page really loads', (await kw.title()) === 'Blocked by url', await kw.title());
await kw.close();

/* ------------------------------------------------------------- the lock */

console.log('\nthe lock');
await page.goto(extPage('options.html'));
await page.waitForSelector('#main:not([hidden])');
const send = (msg) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);

check('lock message accepted', (await send({ type: 'lock' })).ok === true);
await page.reload();
await page.waitForSelector('#unlockCard:not([hidden])', { timeout: 10000 });
check('settings ask for the PIN again after locking', true);
check('settings cannot be changed while locked',
  (await send({ type: 'setSettings', patch: { enabled: false } })).ok === false);
check('a wrong PIN is refused', (await send({ type: 'unlock', pin: '1111' })).ok === false);
await page.screenshot({ path: join(SHOTS, 'shot-locked.png') });

const guarded = await ctx.newPage();
await guarded.goto('chrome://extensions/').catch(() => {});
await guarded.waitForTimeout(1200);
check('the extensions page is bounced while locked',
  guarded.url().includes('blocked.html'), guarded.url());
await guarded.close();

check('the right PIN unlocks', (await send({ type: 'unlock', pin: PIN })).ok === true);
await page.reload();
await page.waitForSelector('#main:not([hidden])', { timeout: 10000 });
check('settings usable again after unlocking',
  (await send({ type: 'setSettings', patch: { keywordThreshold: 14 } })).ok === true);

/* ------------------------------------------------------------------ popup */

console.log('\npopup');
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 320, height: 480 });
await popup.goto(extPage('popup.html'));
await popup.waitForSelector('#statePill');
await popup.waitForTimeout(600);
check('popup shows the protecting state',
  (await popup.textContent('#statePill')).trim() === 'Protecting', await popup.textContent('#statePill'));
check('popup counts the filtered domains',
  Number((await popup.textContent('#domCount')).replace(/,/g, '')) > 300, await popup.textContent('#domCount'));
check('popup counts what it has blocked',
  Number((await popup.textContent('#hitCount')).replace(/,/g, '')) >= 4, await popup.textContent('#hitCount'));
await popup.screenshot({ path: join(SHOTS, 'shot-popup.png') });

check('no uncaught page errors anywhere', errors.length === 0, errors);

console.log(`\n${pass} passed, ${fail} failed\n`);
await ctx.close();
server.close();
process.exit(fail ? 1 : 0);
