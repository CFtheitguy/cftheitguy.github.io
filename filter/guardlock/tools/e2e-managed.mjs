/* Proves the zero-touch provisioning path in a real browser: lay down a policy
 * file the way the installer does, start Chromium, and check the extension
 * comes up already locked with the policy's settings — no setup wizard, no
 * clicks, filtering live from the first page load.
 *
 *   sudo node tools/e2e-managed.mjs
 *
 * Needs root, because browser policy lives under /etc. */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'dist', 'edge');
const POLICY_DIR = '/etc/chromium/policies/managed';
const POLICY_FILE = join(POLICY_DIR, 'guardlock-test.json');
const PIN = '7391';
const PORT = 8444;

let pass = 0, fail = 0;
const check = (n, c, x) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); }
};

/** Chromium derives an unpacked extension's id from its absolute path. */
function unpackedId(path) {
  const h = createHash('sha256').update(path).digest();
  return [...h.slice(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join('');
}

const extId = unpackedId(EXT);
console.log('\nextension id derived from its path:', extId);

/* ---------------------------- provision, exactly as an operator would ---- */

const provDir = mkdtempSync(join(tmpdir(), 'gl-prov-'));
execFileSync(process.execPath, [
  join(ROOT, 'tools', 'provision.mjs'),
  '--pin', PIN,
  '--categories', 'adult,gambling,social',
  '--allow', 'allowed.example',
  '--block', 'timewaster.example',
  '--out', provDir
], { stdio: 'ignore' });

const config = JSON.parse(readFileSync(join(provDir, 'guardlock-config.json'), 'utf8'));
check('provision.mjs produced a PIN hash, not the PIN',
  !!config.lockHash && !JSON.stringify(config).includes(PIN), Object.keys(config));

mkdirSync(POLICY_DIR, { recursive: true });
writeFileSync(POLICY_FILE, JSON.stringify({
  '3rdparty': { extensions: { [extId]: config } }
}, null, 2));
console.log('policy written to', POLICY_FILE);

/* ------------------------------------------------ a stand-in web server -- */

const tls = mkdtempSync(join(tmpdir(), 'gl-tls-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', join(tls, 'key.pem'), '-out', join(tls, 'cert.pem'),
  '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });

const server = createServer(
  { key: readFileSync(join(tls, 'key.pem')), cert: readFileSync(join(tls, 'cert.pem')) },
  (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Ordinary page</title><h1>Ordinary page</h1>');
  }
);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/* ------------------------------------------------------------ the browser */

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'gl-profile-')), {
  channel: 'chromium',
  headless: true,
  ignoreHTTPSErrors: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--host-resolver-rules=MAP * 127.0.0.1:${PORT}`,
    '--ignore-certificate-errors',
    '--no-proxy-server'
  ]
});

try {
  const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  check('extension loaded', new URL(worker.url()).host === extId, new URL(worker.url()).host);

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/src/ui/options.html`);
  await page.waitForSelector('#statePill', { timeout: 10000 });
  await page.waitForTimeout(1200);

  const send = (msg) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);

  /* This is the whole point: does the browser hand the policy to the extension? */
  const raw = await page.evaluate(() => new Promise((r) => chrome.storage.managed.get(null, r)));
  check('Chromium delivered the policy to the extension',
    raw && raw.lockHash === config.lockHash, raw && Object.keys(raw || {}));

  const st = await send({ type: 'getState' });
  check('the profile is locked on first launch', st.hasPin === true && st.unlocked === false,
    { hasPin: st.hasPin, unlocked: st.unlocked });
  check('no setup wizard is shown', await page.isHidden('#setup'));
  check('the settings page says it is managed', await page.isVisible('#managedCard'));
  check('policy categories are in force',
    st.settings.categories.social === true && st.settings.categories.games === false,
    st.settings.categories);
  check('policy allowlist is in force', st.settings.allowlist.includes('allowed.example'),
    st.settings.allowlist);
  check('the master switch is greyed out by policy', await page.isDisabled('#enabled'));

  /* Filtering must be live before anyone has touched the browser. */
  const bad = await ctx.newPage();
  await bad.goto('https://pornhub.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  for (let i = 0; i < 40 && !bad.url().includes('blocked.html'); i++) await bad.waitForTimeout(200);
  check('filtering is live on a brand-new profile with no interaction',
    bad.url().includes('blocked.html'), bad.url());

  const custom = await ctx.newPage();
  await custom.goto('https://timewaster.example/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  for (let i = 0; i < 40 && !custom.url().includes('blocked.html'); i++) await custom.waitForTimeout(200);
  check('a policy blocklist entry blocks', custom.url().includes('blocked.html'), custom.url());

  const good = await ctx.newPage();
  await good.goto('https://allowed.example/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await good.waitForTimeout(1000);
  check('a policy allowlist entry passes', !good.url().includes('blocked.html'), good.url());

  /* The provisioned PIN is the one that opens it, and policy still wins. */
  check('a wrong PIN is refused', (await send({ type: 'unlock', pin: '0000' })).ok === false);
  check('the provisioned PIN unlocks', (await send({ type: 'unlock', pin: PIN })).ok === true);
  const pinned = await send({ type: 'setSettings', patch: { enabled: false } });
  check('policy-pinned settings hold even for someone with the PIN', pinned.ok === false, pinned);

  console.log(`\n${pass} passed, ${fail} failed\n`);
} finally {
  await ctx.close();
  server.close();
  rmSync(POLICY_FILE, { force: true });
  rmSync(provDir, { recursive: true, force: true });
  console.log('policy file removed');
}

process.exit(fail ? 1 : 0);
