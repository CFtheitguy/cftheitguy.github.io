/* Turns a PIN and a set of choices into browser policy files, so a freshly
 * built VM comes up already filtered and already locked.
 *
 *   node tools/provision.mjs --pin 4821 [options]
 *
 * The PIN is hashed here and only the hash travels. Nothing in the generated
 * files reveals the digits, so the policy is safe to keep in a build image. */
import { webcrypto as crypto } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PBKDF2_ITERATIONS = 210000;
const GECKO_ID = 'guardlock@cftheitguy.github.io';

/* ------------------------------------------------------------------- args */

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) { args[key] = next; i++; }
  else args[key] = true;
}

if (args.help || !args.pin) {
  console.log(`Usage: node tools/provision.mjs --pin <4-12 digits> [options]

  --pin <digits>         required, the PIN that will unlock settings on the VM
  --out <dir>            where to write (default: dist/provision)
  --categories <list>    comma-separated: adult,gambling,social,video,games
                         (default: adult,gambling)
  --allow <list>         comma-separated domains that always pass
  --block <list>         comma-separated domains that never pass
  --lists <urls>         comma-separated https blocklist URLs to subscribe to
  --relock <minutes>     minutes before the settings relock (default 5)
  --sensitivity <n>      keyword score needed to block (default 12)
  --edge-id <id>         extension id, once GuardLock is in the Edge/Chrome store
  --edge-update <url>    update manifest url (default: the Edge Add-ons store)
  --xpi <url>            url of your signed Firefox .xpi
  --no-private           also switch private browsing off entirely
`);
  process.exit(args.help ? 0 : 1);
}

if (!/^\d{4,12}$/.test(String(args.pin))) {
  console.error('The PIN must be 4 to 12 digits.');
  process.exit(1);
}

const list = (v, fallback) =>
  (v === undefined ? fallback : String(v).split(',').map((x) => x.trim()).filter(Boolean));

const OUT = args.out ? String(args.out) : join(ROOT, 'dist', 'provision');
const CATEGORIES = ['adult', 'gambling', 'social', 'video', 'games'];
const on = list(args.categories, ['adult', 'gambling']);
const categories = Object.fromEntries(CATEGORIES.map((c) => [c, on.includes(c)]));

/* ------------------------------------------------------------------ hashing */

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const salt = crypto.getRandomValues(new Uint8Array(16));
const saltHex = toHex(salt);

const key = await crypto.subtle.importKey(
  'raw', new TextEncoder().encode(String(args.pin)), 'PBKDF2', false, ['deriveBits']
);
const bits = await crypto.subtle.deriveBits(
  { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256
);
const hashHex = toHex(bits);

/* ------------------------------------------------------------- the payload */

const config = {
  lockSalt: saltHex,
  lockHash: hashHex,
  lockIterations: PBKDF2_ITERATIONS,
  enabled: true,
  safeSearch: true,
  keywordsEnabled: true,
  urlKeywordsEnabled: true,
  guardSettingsPage: true,
  keywordThreshold: Number(args.sensitivity) || 12,
  unlockMinutes: Number(args.relock) || 5,
  categories,
  allowlist: list(args.allow, []),
  blocklist: list(args.block, []),
  remoteLists: list(args.lists, [])
};

const edgeId = args['edge-id'] ? String(args['edge-id']) : null;
const edgeUpdate = args['edge-update']
  ? String(args['edge-update'])
  : 'https://edge.microsoft.com/extensionwebstorebase/v1/crx';
const xpi = args.xpi
  ? String(args.xpi)
  : 'https://www.linearit.co/filter/guardlock/dist/guardlock-firefox.xpi';
const killPrivate = args['no-private'] === true || args['no-private'] === 'true';

mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ firefox */

const ffExtension = {
  installation_mode: 'force_installed',
  install_url: xpi,
  private_browsing: true,
  default_area: 'navbar'
};

const policies = {
  policies: {
    ExtensionSettings: { [GECKO_ID]: ffExtension, '*': { installation_mode: 'allowed' } },
    '3rdparty': { Extensions: { [GECKO_ID]: config } },
    BlockAboutConfig: true,
    BlockAboutProfiles: true,
    DisableSafeMode: true,
    DisableProfileImport: true
  }
};
if (killPrivate) policies.policies.DisablePrivateBrowsing = true;

writeFileSync(join(OUT, 'policies.json'), JSON.stringify(policies, null, 2) + '\n');

/* ------------------------------------- chromium: registry + managed json */

/** Registry strings need backslashes and quotes escaped. */
const reg = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

const lines = [
  'Windows Registry Editor Version 5.00',
  '',
  '; GuardLock provisioning for Microsoft Edge.',
  '; Generated by tools/provision.mjs — the PIN is not recoverable from this file.',
  '; Apply as administrator, then restart Edge.',
  ''
];

for (const browser of ['Microsoft\\Edge', 'Google\\Chrome']) {
  const base = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\${browser}`;
  lines.push(`[${base}]`);
  if (killPrivate) {
    lines.push('"IncognitoModeAvailability"=dword:00000001');
    lines.push('"BrowserGuestModeEnabled"=dword:00000000');
  }
  lines.push('');
  if (edgeId) {
    lines.push(`[${base}\\ExtensionInstallForcelist]`);
    lines.push(`"1"=${reg(`${edgeId};${edgeUpdate}`)}`);
    lines.push('');
    lines.push(`[${base}\\3rdparty\\extensions\\${edgeId}\\policy]`);
    for (const [k, v] of Object.entries(config)) {
      if (typeof v === 'number') lines.push(`"${k}"=dword:${v.toString(16).padStart(8, '0')}`);
      else if (typeof v === 'boolean') lines.push(`"${k}"=dword:${v ? '00000001' : '00000000'}`);
      else if (typeof v === 'string') lines.push(`"${k}"=${reg(v)}`);
      else lines.push(`"${k}"=${reg(JSON.stringify(v))}`);
    }
    lines.push('');
  }
}
if (!edgeId) {
  lines.push('; No --edge-id was given, so the force-install and managed-config keys');
  lines.push('; are not here. Publish GuardLock to the Edge Add-ons store (free), then');
  lines.push('; re-run provision.mjs with --edge-id <id> for a fully hands-off install.');
}
writeFileSync(join(OUT, 'guardlock-edge.reg'), lines.join('\r\n') + '\r\n');

/* Linux/macOS Chromium read policy from JSON files instead of the registry. */
const chromiumPolicy = {};
if (killPrivate) {
  chromiumPolicy.IncognitoModeAvailability = 1;
  chromiumPolicy.BrowserGuestModeEnabled = false;
}
if (edgeId) {
  chromiumPolicy.ExtensionInstallForcelist = [`${edgeId};${edgeUpdate}`];
  chromiumPolicy['3rdparty'] = { extensions: { [edgeId]: config } };
}
writeFileSync(join(OUT, 'guardlock-chromium.json'), JSON.stringify(chromiumPolicy, null, 2) + '\n');

/* The raw config, for anyone wiring this into their own tooling. */
writeFileSync(join(OUT, 'guardlock-config.json'), JSON.stringify(config, null, 2) + '\n');

console.log(`Wrote provisioning files to ${OUT}

  policies.json             → Firefox (see README for where it goes)
  guardlock-edge.reg        → Edge and Chrome on Windows
  guardlock-chromium.json   → Edge and Chrome on Linux/macOS
  guardlock-config.json     → the raw managed-storage payload

  PIN hash    ${hashHex.slice(0, 24)}…
  salt        ${saltHex}
  categories  ${on.join(', ')}
  firefox xpi ${xpi}
  edge id     ${edgeId || '(not set — see the note in the .reg file)'}

The PIN itself is nowhere in these files. Keep a note of it somewhere safe;
a VM provisioned this way has no setup wizard and no recovery code.`);
