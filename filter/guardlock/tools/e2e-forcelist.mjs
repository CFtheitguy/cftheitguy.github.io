/* The whole zero-touch chain, end to end, with nothing pre-installed:
 *
 *   policy on disk  →  browser fetches update.xml  →  downloads the signed crx
 *   →  installs it  →  reads its managed config  →  comes up locked and filtering
 *
 * This is what a freshly built VM does on first boot. Nothing here uses
 * --load-extension: the browser installs GuardLock by itself, from a web
 * server, because policy told it to.
 *
 *   sudo node tools/e2e-forcelist.mjs     (root: browser policy lives in /etc) */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const POLICY_DIR = '/etc/chromium/policies/managed';
const POLICY_FILE = join(POLICY_DIR, 'guardlock-forcelist-test.json');
const PIN = '5502';
const PORT = 8445;
const HOST = 'updates.example';

let pass = 0, fail = 0;
const check = (n, c, x) => {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  → ' + JSON.stringify(x) : '')); }
};

/* --------------------------------------- pack and provision, as an operator */

const keyPath = join(mkdtempSync(join(tmpdir(), 'gl-key-')), 'crx-key.pem');
const packOut = execFileSync(process.execPath, [
  join(ROOT, 'tools', 'pack-crx.mjs'),
  '--key', keyPath,
  '--base-url', `https://${HOST}`
], { encoding: 'utf8' });

const extId = (packOut.match(/extension id\s+(\w+)/) || [])[1];
check('pack-crx produced an extension id', /^[a-p]{32}$/.test(extId || ''), extId);

const crx = readFileSync(join(DIST, 'guardlock.crx'));
check('the crx has a CRX3 header',
  crx.subarray(0, 4).toString('ascii') === 'Cr24' && crx.readUInt32LE(4) === 3,
  { magic: crx.subarray(0, 4).toString('ascii'), version: crx.readUInt32LE(4) });

const provDir = mkdtempSync(join(tmpdir(), 'gl-prov-'));
execFileSync(process.execPath, [
  join(ROOT, 'tools', 'provision.mjs'),
  '--pin', PIN,
  '--categories', 'adult,gambling',
  '--edge-id', extId,
  '--edge-update', `https://${HOST}/update.xml`,
  '--out', provDir
], { stdio: 'ignore' });

const policy = JSON.parse(readFileSync(join(provDir, 'guardlock-chromium.json'), 'utf8'));
check('provision.mjs wrote a force-install entry',
  (policy.ExtensionInstallForcelist || []).some((e) => e.startsWith(extId)),
  policy.ExtensionInstallForcelist);
check('provision.mjs wrote the managed config alongside it',
  !!(policy['3rdparty'] && policy['3rdparty'].extensions[extId].lockHash));

mkdirSync(POLICY_DIR, { recursive: true });
writeFileSync(POLICY_FILE, JSON.stringify(policy, null, 2));

/* ------------------------------------------------ the server hosting the crx */

const tls = mkdtempSync(join(tmpdir(), 'gl-tls-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', join(tls, 'key.pem'), '-out', join(tls, 'cert.pem'),
  '-days', '1', '-subj', `/CN=${HOST}`], { stdio: 'ignore' });

const served = [];
const server = createServer(
  { key: readFileSync(join(tls, 'key.pem')), cert: readFileSync(join(tls, 'cert.pem')) },
  (req, res) => {
    const path = req.url.split('?')[0];
    served.push(path);
    if (path === '/update.xml') {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(readFileSync(join(DIST, 'update.xml')));
    } else if (path === '/guardlock.crx') {
      res.writeHead(200, { 'content-type': 'application/x-chrome-extension' });
      res.end(crx);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Ordinary page</title><h1>Ordinary page</h1>');
    }
  }
);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/* ------------------------------------------------------- a brand-new browser */

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'gl-vm-')), {
  channel: 'chromium',
  headless: true,
  ignoreHTTPSErrors: true,
  // Playwright disables background networking by default, which is exactly the
  // channel the extension installer uses. A real VM has it on.
  ignoreDefaultArgs: ['--disable-background-networking', '--disable-component-update'],
  args: [
    `--host-resolver-rules=MAP * 127.0.0.1:${PORT}`,
    '--ignore-certificate-errors',
    '--no-proxy-server',
    // Chromium's first policy-install check is delayed by up to a minute on a
    // real machine. A VM can wait; a test should not.
    '--extensions-update-frequency=5'
  ]
});

try {
  console.log('\nwaiting for the browser to install GuardLock on its own…');
  let worker = null;
  for (let i = 0; i < 240 && !worker; i++) {
    worker = ctx.serviceWorkers().find((w) => w.url().includes(extId)) || null;
    if (!worker) await ctx.pages()[0].waitForTimeout(500);
    if (i && i % 60 === 0) console.log('  …still waiting; served so far:', [...new Set(served)].join(' '));
  }

  check('the browser fetched the update manifest', served.includes('/update.xml'), served.slice(0, 5));
  check('the browser downloaded the crx', served.includes('/guardlock.crx'), served.slice(0, 5));
  check('the browser installed GuardLock with no human involved', !!worker,
    ctx.serviceWorkers().map((w) => w.url()));

  if (worker) {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/src/ui/options.html`);
    await page.waitForSelector('#statePill', { timeout: 15000 });
    await page.waitForTimeout(1500);

    const send = (m) => page.evaluate((x) => new Promise((r) => chrome.runtime.sendMessage(x, r)), m);
    const st = await send({ type: 'getState' });

    check('it came up locked, with no setup wizard', st.hasPin === true && st.unlocked === false,
      { hasPin: st.hasPin, unlocked: st.unlocked });
    check('it knows it is policy-managed', st.managed && st.managed.active === true);
    check('the provisioned PIN is the one that opens it',
      (await send({ type: 'unlock', pin: PIN })).ok === true);

    const bad = await ctx.newPage();
    await bad.goto('https://pornhub.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    for (let i = 0; i < 40 && !bad.url().includes('blocked.html'); i++) await bad.waitForTimeout(200);
    check('filtering was live from the first page load', bad.url().includes('blocked.html'), bad.url());
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
} finally {
  await ctx.close();
  server.close();
  rmSync(POLICY_FILE, { force: true });
  rmSync(provDir, { recursive: true, force: true });
}

process.exit(fail ? 1 : 0);
