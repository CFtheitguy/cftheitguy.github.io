# GuardLock

A content filter that lives inside the browser, works in private windows, and
cannot be switched off without a numeric PIN. Built for Firefox and Edge from
one source tree.

Nothing leaves the machine. There is no account, no server, and no telemetry —
the lists, the PIN hash and the counters all sit in the browser's own storage.

## What it blocks

| Layer | What it catches |
|---|---|
| **Category lists** | ~470 bundled domains across adult, gambling, social, video and games. Subdomains are covered automatically. |
| **Subscribed lists** | Any public hosts file or domain list by URL, refreshed twice a day. This is where real coverage comes from — a good porn blocklist runs to hundreds of thousands of domains. |
| **Address keywords** | Sites nobody has listed yet, caught by weighted words in the URL. |
| **Page-text scan** | Blocks after load when the wording on the page crosses a sensitivity score. |
| **Forced SafeSearch** | Google, Bing, DuckDuckGo, Yahoo, Yandex, Ecosia, Startpage and Brave get pinned to strict mode; YouTube gets Restricted Mode via its request header. |
| **Sub-resources** | Blocked domains are cut off as iframes, scripts, images and XHR too, not only as top-level pages. |

Blocking runs on two independent layers, so a blocked site stays blocked even
when the background worker is asleep:

- `declarativeNetRequest` rules, enforced by the browser's own network stack.
- A `webNavigation` check, which is what produces the friendly block page with
  the reason and the "unlock and allow this site" button.

## The number lock

- 4–12 digit PIN, entered on an on-screen keypad (the physical number row works too).
- Stored as PBKDF2-SHA256, 210,000 iterations, with a random 16-byte salt. The
  digits themselves are never written to disk.
- Three wrong tries starts an exponential lockout: 5s, 10s, 20s … up to 15 minutes.
- Unlocking is temporary. It relocks itself after the timeout you set (5 minutes
  by default), when the browser restarts, and whenever you press **Lock now**.
- A one-time recovery code is issued at setup and shown once. It is the only way
  back in after a forgotten PIN, and it is hashed the same way the PIN is.
- While locked, `about:addons`, `edge://extensions`, `about:config` and friends
  bounce to the block page, so the filter cannot be switched off in three clicks.

## Putting it on a new machine, without the clicking

The install steps below are fine once. They are not fine for the fifth VM this
month. For that, GuardLock reads its whole configuration — including the PIN —
from **browser policy**, so a freshly built machine comes up already filtered
and already locked. No setup wizard, no window where the browser is open and
unfiltered, and nothing to pay per machine.

One command on a fresh Linux box:

```bash
curl -fsSL https://www.linearit.co/filter/guardlock/install/install.sh \
  | sudo bash -s -- --pin 4821 --categories adult,gambling
```

and on Windows, from an elevated PowerShell:

```powershell
& ([scriptblock]::Create((irm https://www.linearit.co/filter/guardlock/install/install.ps1))) -Pin 4821
```

Both scripts hash the PIN locally, write the policy for Edge, Chrome and
Firefox, and drop a copy of the extension in a fixed location. Re-running is
safe, `--uninstall` / `-Uninstall` reverses it, and `--dns` / `-Dns` will also
point the machine at a filtering resolver so it is covered before any browser
starts.

Useful options: `--categories`, `--allow`, `--block`, `--lists`, `--relock`,
`--sensitivity`, `--no-private`. Run with `--help` for the full set.

### What "already locked" means

The policy carries a PBKDF2 hash of the PIN, never the digits. On first launch
the extension adopts it, so:

- the machine is locked from the first frame, with no setup wizard;
- settings the policy pins are greyed out and refuse to change **even for
  someone holding the PIN** — they are changed in the policy, not the browser;
- allow/block entries and list subscriptions from the policy cannot be removed
  locally, though the user may add their own on top;
- a PIN somebody had already set by hand is never overwritten.

Because a provisioned install has no setup step, it also has **no recovery
code**. Keep the PIN somewhere safe.

### Generating the policy yourself

If you would rather bake the policy into a VM image or hand it to your own
tooling than run a script:

```bash
node tools/provision.mjs --pin 4821 --categories adult,gambling,social
```

That writes `policies.json` (Firefox), `guardlock-edge.reg` (Windows),
`guardlock-chromium.json` (Linux/macOS) and the raw managed-storage payload.

### Getting the extension installed without a store

Policy configures GuardLock; something still has to install it.

**Firefox** is the easy one: `ExtensionSettings` force-installs a signed `.xpi`
straight from a URL, and `"private_browsing": true` grants private-window
access without anyone ticking a box. Sign once with a free Mozilla account and
every VM afterwards is hands-off.

**Chromium** (Edge, Chrome) wants an extension id and an update manifest.
Two routes, both free:

1. Publish to the Edge Add-ons store — free, and the store then serves updates.
   Re-run the installer with `--ext-id <id>`.
2. Host it yourself. `node tools/pack-crx.mjs --base-url https://your.site/path`
   generates a signing key, packs a signed `.crx`, and writes the `update.xml`
   to sit beside it. Upload both, then provision with `--ext-id` and
   `--ext-update`. The key it writes to `.crx-key.pem` is the extension's
   identity — back it up, never commit it, and treat it like a password:
   anyone holding it can publish an update your machines will install.

Failing both, the installer still leaves a copy on disk and pre-authorises the
id Chromium will give it, so a single "Load unpacked" is all that is left —
and even then the browser comes up locked and configured, with no wizard.

I have verified the Firefox policy shape, the managed-config path, and the
Linux installer end to end against a real browser. The self-hosted `.crx`
force-install could not be verified in the sandbox this was built in, because
the test browser has its update services stubbed out — treat that one route as
untested until you have run it on a real machine.

## Install

Grab the build for your browser from `dist/`, or build it yourself:

```bash
npm run build            # writes dist/firefox, dist/edge and a zip of each
npm test                 # 197 checks against the real background script
npm run test:e2e         # 33 checks driving the built extension in a real Chromium
sudo npm run test:policy # 15 checks that browser policy really provisions it
```

`npm test` stubs the browser APIs and exercises `background.js` directly. It
runs the whole suite twice — once with Chromium's callback-style APIs and once
with Firefox's promise-style ones, which reject a stray callback argument. A
callback-only extension hangs on its first storage read in Firefox, and that
second pass is what catches it.
`npm run test:e2e` goes further: it loads `dist/edge` into a headless Chromium,
completes the PIN setup by clicking the keypad, and checks that a listed domain,
a keyword address and an explicit page are all really blocked. It needs
`playwright` and `openssl`, and points every hostname at a throwaway local
HTTPS server, so it never touches the network.

`npm run test:policy` writes a real policy file to `/etc/chromium/policies`,
starts a browser against it, and checks the extension comes up locked with the
policy's settings and no wizard. It needs root, and removes the file afterwards.
`tools/e2e-installer.mjs` does the same for whatever `install.sh` actually put
on the current machine.

### Edge (also Chrome, Brave, Opera)

1. Open `edge://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `dist/edge`.
3. Click **Details** on GuardLock and turn on **Allow in InPrivate**.
4. GuardLock opens its setup page. Choose a PIN and save the recovery code.

The extension stays installed across restarts. It can still be removed from
`edge://extensions` by anyone with the computer — see *Making it stick* below.

### Firefox

Firefox will only install a signed add-on permanently. Two routes:

**Temporary (for a look around):** open `about:debugging#/runtime/this-firefox`
→ **Load Temporary Add-on** → pick `dist/firefox/manifest.json`. It disappears
when Firefox closes.

**Permanent:** sign it once with your own Mozilla account, which is free:

```bash
npm install -g web-ext
cd dist/firefox
web-ext sign --channel=unlisted \
  --api-key=YOUR_JWT_ISSUER --api-secret=YOUR_JWT_SECRET
```

That returns a signed `.xpi`. Open it in Firefox to install, then:

1. Open `about:addons` → **Extensions** → GuardLock → **Details**.
2. Set **Run in Private Windows** to **Allow**.

API credentials come from
<https://addons.mozilla.org/developers/addon/api/key/>. `unlisted` means the
add-on is signed for your own distribution and never appears in the public
directory.

## Private windows — read this part

Browsers keep every extension out of private windows until a human allows it by
hand. Nothing in a manifest can override that; it is a deliberate protection
against extensions spying on private browsing. So an installed-but-not-allowed
GuardLock is a filter with the back door propped open.

GuardLock does not let that pass silently. It checks its own private-window
access, shows an amber `!` on the toolbar icon, and puts the fix at the top of
its settings page.

**Firefox:** about:addons → GuardLock → Details → Run in Private Windows → Allow.
**Edge:** edge://extensions → Details → Allow in InPrivate.

The stronger answer, if the computer belongs to someone who should not have the
choice, is to remove private browsing entirely — see the policies below.

## Making it stick

An extension a person installed is an extension that person can remove. On a
computer you administer, browser policy is what closes that gap. The files are
in [`enterprise/`](enterprise/).

**Firefox** — copy `firefox-policies.json` to `policies.json` in:

| OS | Path |
|---|---|
| Windows | `C:\Program Files\Mozilla Firefox\distribution\policies.json` |
| macOS | `/Applications/Firefox.app/Contents/Resources/distribution/policies.json` |
| Linux | `/etc/firefox/policies/policies.json` |

`force_installed` puts GuardLock beyond removal or disabling, and
`"private_browsing": true` grants private-window access without anyone having to
tick the box. `firefox-policies-strict.json` goes further: no private browsing,
no `about:config`, no safe mode, no other extensions.

Point `install_url` at wherever your signed `.xpi` actually lives.

**Edge** — run `edge-guardlock.reg` as an administrator. It switches off
InPrivate and guest mode. Force-installing the extension itself needs a real
extension id, which means publishing to the Edge Add-ons store or hosting a CRX
with an update manifest; the commented block in the `.reg` shows the shape.

## Honest limits

- A browser extension filters that browser. Another browser, a phone, or a
  different user account on the same computer are all outside its reach. Pair it
  with a filtering DNS resolver if that matters.
- Without the policy files, anyone can remove the extension from the browser's
  extensions page. The settings-page guard slows that down; it does not stop
  someone who starts the browser in safe mode or edits the profile directly.
- The page-text scan runs after the page loads. It covers the moment with a
  curtain and then blocks, but the first paint can flash.
- Keyword rules are heuristics. They will occasionally block a medical or news
  page — that is what the allowlist is for. Raise the sensitivity number to
  block less; lower it to block more.

## Layout

```
manifest.chromium.json   Edge / Chrome / Brave / Opera manifest
manifest.firefox.json    Firefox manifest (event page instead of a worker)
build.mjs                assembles dist/<browser> and zips each
src/common.js            storage, PBKDF2, domain matching, SafeSearch rules
src/background.js        rule sync, navigation checks, the lock, messaging
src/sw.js                Chromium service-worker entry point
src/content/scan.js      page-text keyword scan
src/ui/                  popup, settings, block page, keypad
src/data/*.json          bundled category lists and the weighted keyword list
tools/make-icons.mjs     draws the icon PNGs, no image libraries needed
tools/provision.mjs      turns a PIN into policy files for a VM image
tools/pack-crx.mjs       signs a .crx and update.xml for self-hosted installs
tools/test.mjs           runs background.js against stubbed browser APIs
tools/e2e*.mjs           real-browser tests, including the provisioning path
install/install.sh       one-command provisioning for Linux
install/install.ps1      one-command provisioning for Windows
enterprise/              hand-written policy files, if you prefer those
```

MIT licensed.
