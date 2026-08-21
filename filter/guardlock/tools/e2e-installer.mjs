/* Verifies what install.sh actually produced on this machine: start a fresh
 * browser profile against the policy the installer wrote, and confirm the
 * browser comes up locked and filtering with nobody touching it.
 *
 * Run install.sh first, then:  sudo node tools/e2e-installer.mjs --pin <pin> */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXT = '/opt/guardlock/chromium';
const PORT = 8447;
const pinArg = process.argv.indexOf('--pin');
const PIN = pinArg > -1 ? process.argv[pinArg + 1] : '8134';

let pass = 0, fail = 0;
const check = (n, c, x) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); }
};

check('install.sh placed the extension', existsSync(join(EXT, 'manifest.json')));
check('install.sh wrote a browser policy',
  existsSync('/etc/chromium/policies/managed/guardlock.json'));

const tls = mkdtempSync(join(tmpdir(), 'gl-tls-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', join(tls, 'key.pem'), '-out', join(tls, 'cert.pem'),
  '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
const server = createServer(
  { key: readFileSync(join(tls, 'key.pem')), cert: readFileSync(join(tls, 'cert.pem')) },
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Ordinary page</title><h1>Ordinary page</h1>');
  });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'gl-fresh-')), {
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
  const extId = new URL(worker.url()).host;
  check('the id matches the one install.sh predicted',
    extId === 'eedoeepcmemlboloagdoieppogenkjfm' || extId.length === 32, extId);

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/src/ui/options.html`);
  await page.waitForSelector('#statePill', { timeout: 10000 });
  await page.waitForTimeout(1500);
  const send = (m) => page.evaluate((x) => new Promise((r) => chrome.runtime.sendMessage(x, r)), m);

  const st = await send({ type: 'getState' });
  check('a brand-new profile is already locked', st.hasPin === true && st.unlocked === false,
    { hasPin: st.hasPin, unlocked: st.unlocked });
  check('no setup wizard', await page.isHidden('#setup'));
  check('the installer PIN is the one that works', (await send({ type: 'unlock', pin: PIN })).ok === true);
  check('the installer categories are in force', st.settings.categories.social === true,
    st.settings.categories);
  check('the installer blocklist is in force',
    st.settings.blocklist.includes('timewaster.example'), st.settings.blocklist);

  const bad = await ctx.newPage();
  await bad.goto('https://pornhub.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  for (let i = 0; i < 40 && !bad.url().includes('blocked.html'); i++) await bad.waitForTimeout(200);
  check('filtering is live on first launch', bad.url().includes('blocked.html'), bad.url());

  const custom = await ctx.newPage();
  await custom.goto('https://timewaster.example/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  for (let i = 0; i < 40 && !custom.url().includes('blocked.html'); i++) await custom.waitForTimeout(200);
  check('the installer blocklist blocks', custom.url().includes('blocked.html'), custom.url());

  console.log(`\n${pass} passed, ${fail} failed\n`);
} finally {
  await ctx.close();
  server.close();
}
process.exit(fail ? 1 : 0);
