#!/usr/bin/env bash
# Verification gate for migration 20260811000001_phase1_harden_authorization.
# See docs/SYSTEM_ARCHITECTURE.md §9.
#
# Read-only except for the optional member-JWT section, which attempts writes
# that are all expected to FAIL. Nothing here deletes data: the destructive RPC
# is probed for authorization only, and a 403 means it did not run.
#
# Usage:
#   bash scripts/verify_phase1.sh              # anon probes only
#   MEMBER_JWT=<token> bash scripts/verify_phase1.sh   # adds the member checks
#
# MEMBER_JWT should be the access_token of an ordinary (non-admin) member.

set -u
cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env; set +a

U="$EXPO_PUBLIC_SUPABASE_URL"
ANON="$EXPO_PUBLIC_SUPABASE_ANON_KEY"

pass=0; fail=0

check() { # description, expected_code, actual_code, extra
  local desc="$1" want="$2" got="$3" extra="${4:-}"
  if [ "$got" = "$want" ]; then
    printf '  \033[32mPASS\033[0m  %-52s %s\n' "$desc" "$got"
    pass=$((pass + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-52s got %s, want %s %s\n' "$desc" "$got" "$want" "$extra"
    fail=$((fail + 1))
  fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo
echo "Anon-key probes  (§5 — the RPCs must no longer be reachable)"

# cleanup_old_notifications DELETEs rows. A 403 proves the revoke landed and
# the function body never executed. Do not "fix" this test by expecting 200.
check "rpc/cleanup_old_notifications rejected" 403 "$(code -X POST \
  "$U/rest/v1/rpc/cleanup_old_notifications" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H 'Content-Type: application/json' -d '{}')"

check "rpc/unread_notification_counts rejected" 403 "$(code -X POST \
  "$U/rest/v1/rpc/unread_notification_counts" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H 'Content-Type: application/json' \
  -d '{"user_ids":["00000000-0000-0000-0000-000000000000"]}')"

# is_admin stays executable on purpose — anon evaluates it inside the
# announcements policy. If this starts returning 403, public announcements
# break. See §5 of the migration.
check "rpc/is_admin still executable (intentional)" 200 "$(code -X POST \
  "$U/rest/v1/rpc/is_admin" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H 'Content-Type: application/json' \
  -d '{"uid":"00000000-0000-0000-0000-000000000000"}')"

check "anon can still read published announcements" 200 "$(code \
  "$U/rest/v1/announcements?select=id&limit=1" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON")"

echo
echo "Signup metadata  (§1 — account_type in user_metadata must be ignored)"
echo "  SKIP  requires creating a throwaway auth user; run manually:"
echo "        sign up with options.data.account_type='admin', then confirm the"
echo "        new id lands in profiles and NOT in admin_profiles."

if [ -n "${MEMBER_JWT:-}" ]; then
  echo
  echo "Member-JWT probes  (§2/§3 — privileged columns must be rejected)"

  MID=$(curl -s "$U/rest/v1/profiles?select=id&limit=1" \
    -H "apikey: $ANON" -H "Authorization: Bearer $MEMBER_JWT" \
    | grep -o '[0-9a-f-]\{36\}' | head -1)

  if [ -z "$MID" ]; then
    echo "  \033[31mFAIL\033[0m  could not resolve member id from MEMBER_JWT"
    fail=$((fail + 1))
  else
    check "member cannot set own profiles.status" 403 "$(code -X PATCH \
      "$U/rest/v1/profiles?id=eq.$MID" \
      -H "apikey: $ANON" -H "Authorization: Bearer $MEMBER_JWT" \
      -H 'Content-Type: application/json' -d '{"status":"active"}')"

    check "member cannot set own profiles.role" 403 "$(code -X PATCH \
      "$U/rest/v1/profiles?id=eq.$MID" \
      -H "apikey: $ANON" -H "Authorization: Bearer $MEMBER_JWT" \
      -H 'Content-Type: application/json' -d '{"role":"admin"}')"

    check "member cannot set own member_no" 403 "$(code -X PATCH \
      "$U/rest/v1/profiles?id=eq.$MID" \
      -H "apikey: $ANON" -H "Authorization: Bearer $MEMBER_JWT" \
      -H 'Content-Type: application/json' -d '{"member_no":"DOMICOOP-0001"}')"

    # The positive case matters as much as the negatives: an over-broad guard
    # that blocks ordinary profile edits is also a broken guard.
    check "member CAN still edit own full_name" 204 "$(code -X PATCH \
      "$U/rest/v1/profiles?id=eq.$MID" \
      -H "apikey: $ANON" -H "Authorization: Bearer $MEMBER_JWT" \
      -H 'Content-Type: application/json' -d '{"full_name":"Verification Probe"}')"
  fi
else
  echo
  echo "Member-JWT probes  SKIPPED  (set MEMBER_JWT to run)"
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
