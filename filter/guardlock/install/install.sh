#!/usr/bin/env bash
# GuardLock — provision a Linux machine so its browsers come up filtered and
# PIN-locked, with no clicking. Safe to re-run; it overwrites its own files and
# touches nothing else.
#
#   curl -fsSL https://www.linearit.co/filter/guardlock/install/install.sh \
#     | sudo bash -s -- --pin 4821
#
# Undo with:  sudo bash install.sh --uninstall

set -euo pipefail

BASE_URL="${GUARDLOCK_BASE_URL:-https://www.linearit.co/filter/guardlock}"
PREFIX="/opt/guardlock"
PIN=""
CATEGORIES="adult,gambling"
ALLOW=""
BLOCK=""
LISTS=""
RELOCK=5
SENSITIVITY=12
SET_DNS=0
NO_PRIVATE=0
UNINSTALL=0
XPI_URL=""
EXT_ID=""
EXT_UPDATE=""

die() { echo "error: $*" >&2; exit 1; }
info() { echo "  $*"; }

usage() {
  cat <<'USAGE'
Usage: sudo bash install.sh --pin <4-12 digits> [options]

  --pin <digits>        required unless --uninstall
  --categories <list>   adult,gambling,social,video,games   (default: adult,gambling)
  --allow <list>        comma-separated domains that always pass
  --block <list>        comma-separated domains that never pass
  --lists <urls>        comma-separated https blocklist URLs to subscribe to
  --relock <minutes>    minutes before the settings relock  (default: 5)
  --sensitivity <n>     keyword score needed to block       (default: 12)
  --xpi <url>           your signed Firefox .xpi
  --ext-id <id>         Chromium extension id, if you force-install it
  --ext-update <url>    Chromium update manifest url
  --dns                 also point this machine at a filtering DNS resolver
  --no-private          switch private browsing off entirely
  --uninstall           remove everything this script installed
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pin) PIN="${2:-}"; shift 2 ;;
    --categories) CATEGORIES="${2:-}"; shift 2 ;;
    --allow) ALLOW="${2:-}"; shift 2 ;;
    --block) BLOCK="${2:-}"; shift 2 ;;
    --lists) LISTS="${2:-}"; shift 2 ;;
    --relock) RELOCK="${2:-}"; shift 2 ;;
    --sensitivity) SENSITIVITY="${2:-}"; shift 2 ;;
    --xpi) XPI_URL="${2:-}"; shift 2 ;;
    --ext-id) EXT_ID="${2:-}"; shift 2 ;;
    --ext-update) EXT_UPDATE="${2:-}"; shift 2 ;;
    --dns) SET_DNS=1; shift ;;
    --no-private) NO_PRIVATE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

[ "$(id -u)" = "0" ] || die "run this with sudo — browser policy lives under /etc"

CHROMIUM_POLICY_DIRS=(
  /etc/chromium/policies/managed
  /etc/chromium-browser/policies/managed
  /etc/opt/chrome/policies/managed
  /etc/opt/edge/policies/managed
  /etc/opt/microsoft/msedge/policies/managed
)
FIREFOX_POLICY_DIRS=(
  /etc/firefox/policies
  /usr/lib/firefox/distribution
  /usr/lib64/firefox/distribution
  /opt/firefox/distribution
)
POLICY_NAME="guardlock.json"

# ----------------------------------------------------------------- uninstall

if [ "$UNINSTALL" = "1" ]; then
  echo "Removing GuardLock provisioning…"
  for d in "${CHROMIUM_POLICY_DIRS[@]}"; do rm -f "$d/$POLICY_NAME"; done
  for d in "${FIREFOX_POLICY_DIRS[@]}"; do rm -f "$d/policies.json"; done
  rm -rf "$PREFIX"
  rm -f /usr/share/chromium/extensions/*.json 2>/dev/null || true
  info "policies and $PREFIX removed"
  info "DNS was left as it is; change it back by hand if you set it with --dns"
  echo "Done. Restart the browsers."
  exit 0
fi

[ -n "$PIN" ] || { usage; die "--pin is required"; }
case "$PIN" in (*[!0-9]*|"") die "the PIN must be digits only" ;; esac
[ "${#PIN}" -ge 4 ] && [ "${#PIN}" -le 12 ] || die "the PIN must be 4 to 12 digits"

command -v python3 >/dev/null || die "python3 is needed to hash the PIN"
DOWNLOADER=""
command -v curl >/dev/null && DOWNLOADER="curl -fsSL -o"
[ -z "$DOWNLOADER" ] && command -v wget >/dev/null && DOWNLOADER="wget -qO"
[ -n "$DOWNLOADER" ] || die "curl or wget is needed"

echo "GuardLock provisioning"
info "source     $BASE_URL"

# --------------------------------------------------------- fetch the extension

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

info "downloading the extension…"
$DOWNLOADER "$TMP/edge.zip" "$BASE_URL/dist/guardlock-edge.zip" \
  || die "could not download the extension from $BASE_URL"

command -v unzip >/dev/null || die "unzip is needed"
rm -rf "$PREFIX"
mkdir -p "$PREFIX/chromium"
unzip -qo "$TMP/edge.zip" -d "$PREFIX/chromium"
VERSION="$(python3 -c "import json;print(json.load(open('$PREFIX/chromium/manifest.json'))['version'])")"
info "installed $PREFIX/chromium (version $VERSION)"

# Chromium derives an unpacked extension's id from its absolute path, and that
# path is fixed here — so the policy can address it even before it is loaded.
UNPACKED_ID="$(python3 -c "
import hashlib
h = hashlib.sha256('$PREFIX/chromium'.encode()).digest()[:16]
print(''.join(chr(97+(b>>4))+chr(97+(b&15)) for b in h))
")"
info "unpacked id $UNPACKED_ID"

# ------------------------------------------------------------ build the config

# The PIN is hashed here; only the hash is written to disk.
CONFIG="$(python3 - "$PIN" "$CATEGORIES" "$ALLOW" "$BLOCK" "$LISTS" "$RELOCK" "$SENSITIVITY" <<'PY'
import hashlib, json, os, sys
pin, cats, allow, block, lists, relock, sens = sys.argv[1:8]
salt = os.urandom(16)
iters = 210000
digest = hashlib.pbkdf2_hmac('sha256', pin.encode(), salt, iters, 32)
split = lambda s: [x.strip() for x in s.split(',') if x.strip()]
on = split(cats)
print(json.dumps({
    "lockSalt": salt.hex(),
    "lockHash": digest.hex(),
    "lockIterations": iters,
    "enabled": True,
    "safeSearch": True,
    "keywordsEnabled": True,
    "urlKeywordsEnabled": True,
    "guardSettingsPage": True,
    "keywordThreshold": int(sens),
    "unlockMinutes": int(relock),
    "categories": {c: (c in on) for c in
                   ["adult", "gambling", "social", "video", "games"]},
    "allowlist": split(allow),
    "blocklist": split(block),
    "remoteLists": split(lists),
}))
PY
)"

# --------------------------------------------------------------- chromium policy

CHROMIUM_JSON="$(CONFIG="$CONFIG" EXT_ID="$EXT_ID" EXT_UPDATE="$EXT_UPDATE" \
  UNPACKED_ID="$UNPACKED_ID" NO_PRIVATE="$NO_PRIVATE" python3 - <<'PY'
import json, os
cfg = json.loads(os.environ["CONFIG"])
out = {}
if os.environ["NO_PRIVATE"] == "1":
    out["IncognitoModeAvailability"] = 1
    out["BrowserGuestModeEnabled"] = False
# Address both identities: the one a store or self-hosted crx installs under,
# and the one the copy in /opt gets when loaded unpacked. Whichever ends up
# installed finds its configuration already waiting.
extensions = {os.environ["UNPACKED_ID"]: cfg}
ext_id = os.environ["EXT_ID"]
if ext_id:
    update = os.environ["EXT_UPDATE"] or "https://clients2.google.com/service/update2/crx"
    out["ExtensionInstallForcelist"] = ["%s;%s" % (ext_id, update)]
    extensions[ext_id] = cfg
out["3rdparty"] = {"extensions": extensions}
print(json.dumps(out, indent=2))
PY
)"

WROTE_CHROMIUM=0
for d in "${CHROMIUM_POLICY_DIRS[@]}"; do
  parent="$(dirname "$(dirname "$d")")"
  # only drop policy where that browser family plausibly lives
  if [ -d "$parent" ] || [ -d "$d" ]; then
    mkdir -p "$d"
    printf '%s\n' "$CHROMIUM_JSON" > "$d/$POLICY_NAME"
    info "policy → $d/$POLICY_NAME"
    WROTE_CHROMIUM=1
  fi
done
if [ "$WROTE_CHROMIUM" = "0" ]; then
  mkdir -p /etc/chromium/policies/managed
  printf '%s\n' "$CHROMIUM_JSON" > "/etc/chromium/policies/managed/$POLICY_NAME"
  info "policy → /etc/chromium/policies/managed/$POLICY_NAME"
fi

# ---------------------------------------------------------------- firefox policy

[ -n "$XPI_URL" ] || XPI_URL="$BASE_URL/dist/guardlock-firefox.xpi"

FIREFOX_JSON="$(CONFIG="$CONFIG" XPI="$XPI_URL" NO_PRIVATE="$NO_PRIVATE" python3 - <<'PY'
import json, os
cfg = json.loads(os.environ["CONFIG"])
gecko = "guardlock@cftheitguy.github.io"
policies = {
    "ExtensionSettings": {
        gecko: {
            "installation_mode": "force_installed",
            "install_url": os.environ["XPI"],
            "private_browsing": True,
            "default_area": "navbar",
        },
        "*": {"installation_mode": "allowed"},
    },
    "3rdparty": {"Extensions": {gecko: cfg}},
    "BlockAboutConfig": True,
    "BlockAboutProfiles": True,
    "DisableSafeMode": True,
}
if os.environ["NO_PRIVATE"] == "1":
    policies["DisablePrivateBrowsing"] = True
print(json.dumps({"policies": policies}, indent=2))
PY
)"

for d in "${FIREFOX_POLICY_DIRS[@]}"; do
  if [ -d "$(dirname "$d")" ]; then
    mkdir -p "$d"
    printf '%s\n' "$FIREFOX_JSON" > "$d/policies.json"
    info "policy → $d/policies.json"
  fi
done

# --------------------------------------------------------------------- dns

if [ "$SET_DNS" = "1" ]; then
  # Cloudflare for Families: blocks malware and adult content at the resolver,
  # so the machine is filtered before any browser starts.
  if [ -d /etc/systemd/resolved.conf.d ] || command -v systemd-resolve >/dev/null 2>&1 \
     || systemctl is-active systemd-resolved >/dev/null 2>&1; then
    mkdir -p /etc/systemd/resolved.conf.d
    cat > /etc/systemd/resolved.conf.d/guardlock.conf <<'CONF'
[Resolve]
DNS=1.1.1.3 1.0.0.3 2606:4700:4700::1113 2606:4700:4700::1003
Domains=~.
DNSStubListener=yes
CONF
    systemctl restart systemd-resolved 2>/dev/null || true
    info "DNS → Cloudflare for Families (systemd-resolved)"
  else
    cp -n /etc/resolv.conf /etc/resolv.conf.guardlock-backup 2>/dev/null || true
    printf 'nameserver 1.1.1.3\nnameserver 1.0.0.3\n' > /etc/resolv.conf
    info "DNS → Cloudflare for Families (/etc/resolv.conf, backup kept)"
  fi
fi

# ------------------------------------------------------------------- report

cat <<EOF

Done. Restart any open browser.

  Firefox   installs GuardLock by itself and unlocks it in private windows.
            This needs a signed .xpi at:
              $XPI_URL
EOF

if [ -n "$EXT_ID" ]; then
  cat <<EOF
  Chromium  force-installs $EXT_ID from
              ${EXT_UPDATE:-the Chrome Web Store}
EOF
else
  cat <<EOF
  Chromium  the settings and PIN are provisioned, but nothing force-installs
            the extension yet. Either publish it to the Edge Add-ons store
            (free) and re-run with --ext-id <id>, or load it once by hand from
              $PREFIX/chromium
            Once loaded, it picks up the policy immediately — still no setup
            wizard, still locked.
EOF
fi

cat <<EOF

  The PIN is not stored anywhere on this machine, only its hash. There is no
  recovery code on a provisioned install, so keep the PIN somewhere safe.
EOF
