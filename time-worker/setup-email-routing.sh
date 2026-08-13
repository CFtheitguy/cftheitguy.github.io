#!/usr/bin/env bash
#
# Point task@todo.linearit.co at the linear-time Worker — without disturbing the
# Microsoft 365 mail that linearit.co depends on.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# The apex of linearit.co receives company mail through Microsoft 365. Cloudflare's
# "enable Email Routing" action on a zone apex *replaces and locks* the apex MX
# records, which would silently stop that mail. This script therefore NEVER calls
# the enable endpoint. It only ever:
#
#   * reads,
#   * writes DNS records whose name is the intake subdomain, and
#   * creates one routing rule.
#
# It snapshots the apex MX before it starts and checks it again at the end, and
# it aborts outright if anything it is about to write targets the apex.
#
# USAGE
#   export CF_API_TOKEN=...        # see the scopes listed below
#   ./setup-email-routing.sh       # add --apply to make changes; default is a dry run
#
# TOKEN SCOPES (My Profile -> API Tokens -> Create Token -> Custom token)
#   Zone / Email Routing / Edit     -- limited to the linearit.co zone
#   Zone / DNS        / Edit        -- limited to the linearit.co zone
#   Zone / Zone       / Read        -- limited to the linearit.co zone
# Nothing else. Delete the token when this finishes.

set -uo pipefail

ZONE_NAME="${ZONE_NAME:-linearit.co}"
SUBDOMAIN="${SUBDOMAIN:-todo}"
LOCAL_PART="${LOCAL_PART:-task}"
WORKER="${WORKER:-linear-time}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

INTAKE="${LOCAL_PART}@${SUBDOMAIN}.${ZONE_NAME}"
API="https://api.cloudflare.com/client/v4"
red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { red "ABORT: $*"; exit 1; }

[ -n "${CF_API_TOKEN:-}" ] || die "CF_API_TOKEN is not set."
command -v jq >/dev/null || die "jq is required (brew install jq / apt install jq)."

cf() { # cf METHOD PATH [JSON]
  local m="$1" p="$2" d="${3:-}"
  if [ -n "$d" ]; then
    curl -sS -X "$m" "$API$p" -H "Authorization: Bearer $CF_API_TOKEN" \
         -H "Content-Type: application/json" --data "$d"
  else
    curl -sS -X "$m" "$API$p" -H "Authorization: Bearer $CF_API_TOKEN"
  fi
}
ok() { jq -e '.success == true' >/dev/null 2>&1; }

bold "1. Checking the token"
V=$(cf GET /user/tokens/verify)
echo "$V" | ok || die "token rejected: $(echo "$V" | jq -r '.errors[0].message // "unknown"')"
grn "   token is valid"

bold "2. Finding the zone"
Z=$(cf GET "/zones?name=$ZONE_NAME")
ZID=$(echo "$Z" | jq -r '.result[0].id // empty')
[ -n "$ZID" ] || die "cannot see the zone $ZONE_NAME with this token."
grn "   $ZONE_NAME -> $ZID"

# ---------------------------------------------------------------------------
# The safety net. Whatever else happens, these apex records must not change.
# ---------------------------------------------------------------------------
bold "3. Snapshotting the apex mail records (the ones that must NOT change)"
apex_mx() {
  cf GET "/zones/$ZID/dns_records?type=MX&name=$ZONE_NAME" \
    | jq -r '[.result[] | "\(.priority) \(.content)"] | sort | join(" | ")'
}
BEFORE=$(apex_mx)
[ -n "$BEFORE" ] || ylw "   (no apex MX visible — check the token has DNS read)"
echo "   apex MX: $BEFORE"
echo "$BEFORE" > ./apex-mx-before.txt
grn "   saved to apex-mx-before.txt"

bold "4. Email Routing status on this zone"
ST=$(cf GET "/zones/$ZID/email/routing")
echo "   enabled: $(echo "$ST" | jq -r '.result.enabled // "unknown"')   name: $(echo "$ST" | jq -r '.result.name // "-"')"
ylw "   NOTE: this script never calls /email/routing/enable — that is the call"
ylw "         that would replace and lock the apex MX records."

bold "5. DNS records Cloudflare wants for routing"
DNS=$(cf GET "/zones/$ZID/email/routing/dns")
echo "$DNS" | jq -r '.result[]? | "   \(.type)\t\(.name)\t\(.content)\tpriority=\(.priority // "-")"' 2>/dev/null \
  || echo "   (none returned)"

# Any record whose name is the bare apex is refused outright.
BAD=$(echo "$DNS" | jq -r --arg z "$ZONE_NAME" '[.result[]? | select(.name == $z)] | length' 2>/dev/null || echo 0)
if [ "${BAD:-0}" != "0" ]; then
  ylw "   Cloudflare proposes $BAD record(s) on the APEX. Those are NOT applied here."
  ylw "   Apply only the ones named $SUBDOMAIN.$ZONE_NAME."
fi

bold "6. Intake subdomain: $SUBDOMAIN.$ZONE_NAME"
SUB_MX=$(cf GET "/zones/$ZID/dns_records?type=MX&name=$SUBDOMAIN.$ZONE_NAME" | jq -r '.result | length')
echo "   existing MX records on the subdomain: $SUB_MX"
if [ "$SUB_MX" = "0" ]; then
  ylw "   The subdomain has no MX records yet."
  ylw "   Enabling Email Routing for a subdomain is a dashboard action:"
  ylw "     Cloudflare -> Compute -> Email Service -> Email Routing -> $ZONE_NAME"
  ylw "     -> Settings -> Subdomains -> enter '$SUBDOMAIN' -> submit"
  ylw "   Accept ONLY the records named $SUBDOMAIN.$ZONE_NAME. If it offers a"
  ylw "   v=spf1 TXT record for the root, DECLINE it — the root already has one,"
  ylw "   and a second SPF record on the same name breaks Microsoft 365 auth."
fi

bold "7. Routing rule for $INTAKE"
RULES=$(cf GET "/zones/$ZID/email/routing/rules")
EXISTS=$(echo "$RULES" | jq -r --arg a "$INTAKE" \
  '[.result[]? | select(.matchers[]?.value == $a)] | length')
if [ "$EXISTS" != "0" ]; then
  grn "   a rule for $INTAKE already exists — nothing to do"
elif [ "$APPLY" != "1" ]; then
  ylw "   DRY RUN — would create: $INTAKE  ->  Worker '$WORKER'"
  ylw "   Re-run with --apply to create it."
else
  BODY=$(jq -nc --arg a "$INTAKE" --arg w "$WORKER" \
    '{name:("Linear To-Do intake: " + $a), enabled:true,
      matchers:[{type:"literal", field:"to", value:$a}],
      actions:[{type:"worker", value:[$w]}]}')
  R=$(cf POST "/zones/$ZID/email/routing/rules" "$BODY")
  if echo "$R" | ok; then
    grn "   created: $INTAKE -> Worker '$WORKER'"
  else
    red "   failed: $(echo "$R" | jq -r '.errors[0].message // "unknown"')"
    red "   (if it says routing is not enabled, do step 6 in the dashboard first)"
  fi
fi

# ---------------------------------------------------------------------------
bold "8. Re-checking the apex — company mail must be untouched"
AFTER=$(apex_mx)
echo "   before: $BEFORE"
echo "   after : $AFTER"
if [ "$BEFORE" = "$AFTER" ]; then
  grn "   UNCHANGED — Microsoft 365 mail is unaffected."
else
  red "   CHANGED. Restore the apex MX immediately from apex-mx-before.txt:"
  red "     $BEFORE"
  exit 1
fi

bold "Done"
echo "  Intake address : $INTAKE"
echo "  Delivered to   : Worker '$WORKER'"
echo "  Next           : Google Voice + Gmail forwarding (steps 4-6 of the checklist)"
echo
echo "  Now delete the API token: Cloudflare -> My Profile -> API Tokens -> Delete."
