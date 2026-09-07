#!/usr/bin/env bash
#
# Tests for the publishing tools.
#
# NO CREDENTIALS AND NO REAL BUCKET. rclone treats a plain directory as a
# remote, so HTTPEERS_TARGET_OVERRIDE points the identical code path at
# $TMP/fake-bucket. Everything below therefore exercises the real guards, the
# real diff and the real `rclone sync` -- only the destination is fake.
#
# What this cannot prove is in the README under "What the tests do not cover":
# S3 semantics, the NFS mode (the prerequisites are absent on this machine),
# and the interactive prompt on a real tty.
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname -- "$HERE")"
BIN="$ROOT/bin"

pass=0; fail=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ok()   { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
notok(){ printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/         /'; fail=$((fail + 1)); }

# Each test gets a fresh tree and a fresh fake bucket, so ordering can never
# make one test depend on another's leftovers.
scenario() {
  SITES="$TMP/$1/sites"; BUCKET="$TMP/$1/bucket"
  rm -rf "$TMP/$1"; mkdir -p "$SITES" "$BUCKET"
  export HTTPEERS_SITES_DIR="$SITES"
  export HTTPEERS_TARGET_OVERRIDE="$BUCKET"
  export HTTPEERS_ENV_FILE=/dev/null   # never read a developer's real publish.env
}

site() { mkdir -p "$SITES/$1"; printf '%s\n' "${3:-hello}" > "$SITES/$1/${2:-index.html}"; }
inbucket() { mkdir -p "$BUCKET/$1"; printf '%s\n' "${3:-hello}" > "$BUCKET/$1/${2:-index.html}"; }

# Run a command with stdin closed, so nothing can ever block on a prompt and
# so the non-interactive refusal path is what is under test.
run() { "$@" </dev/null >"$TMP/out" 2>&1; echo $?; }

command -v rclone >/dev/null 2>&1 || { echo "rclone is required to run these tests"; exit 1; }

echo "== hostname validation =="
# shellcheck disable=SC1091
. "$ROOT/lib/common.sh"
for good in abc.httpeers.net a-b.c.example.com x1.y2.zz 0.0.example.org; do
  valid_site_name "$good" && ok "accepts $good" || notok "accepts $good"
done
for bad in "UPPER.httpeers.net" "-lead.example.com" "trail-.example.com" "no_underscore.example.com" \
           "dist" "a..b.example.com" "with space.example.com" "sub./x.example.com" "" ; do
  valid_site_name "$bad" && notok "rejects '$bad'" || ok "rejects '$bad'"
done
# 253 characters is the ceiling the server enforces; one past it must fail.
# Three 63-character labels plus a fourth sized to land exactly on the limit.
lab() { printf 'a%.0s' $(seq 1 "$1"); }
name253="$(lab 63).$(lab 63).$(lab 63).$(lab 61)"
name254="$(lab 63).$(lab 63).$(lab 63).$(lab 62)"
[ "${#name253}" = 253 ] && [ "${#name254}" = 254 ] || notok "fixture lengths (${#name253}/${#name254})"
valid_site_name "$name253" && ok "accepts a 253-character name" || notok "accepts a 253-character name"
valid_site_name "$name254" && notok "rejects a 254-character name" || ok "rejects a 254-character name"
# A single label longer than 63 characters is invalid however short the whole name is.
valid_site_name "$(lab 64).net" && notok "rejects a 64-character label" || ok "rejects a 64-character label"

echo
echo "== 1. a new local directory becomes a new remote prefix =="
scenario new
site abc.httpeers.net
rc="$(run "$BIN/httpeers-publish" --yes)"
if [ "$rc" = 0 ] && [ -f "$BUCKET/abc.httpeers.net/index.html" ]; then
  ok "publish created abc.httpeers.net/index.html in the bucket"
else
  notok "publish created the prefix (rc=$rc)" "$(cat "$TMP/out")"
fi
# ... and the diff it printed said "added", not "deleted".
grep -q 'added (1)' "$TMP/out" && ok "reported it as added" || notok "reported it as added" "$(cat "$TMP/out")"

echo
echo "== 2. a second run is a no-op (safe to run twice) =="
rc="$(run "$BIN/httpeers-publish")"
if [ "$rc" = 0 ] && grep -q 'in sync' "$TMP/out"; then
  ok "re-running reports in sync and exits 0"
else
  notok "re-running is a no-op (rc=$rc)" "$(cat "$TMP/out")"
fi

echo
echo "== 3. deleting a local directory removes the prefix ONLY after confirmation =="
scenario del
site keep.httpeers.net
inbucket keep.httpeers.net
inbucket doomed.httpeers.net
# 3a. no tty, no --yes  ->  refuse, and the bucket is untouched.
rc="$(run "$BIN/httpeers-publish")"
if [ "$rc" != 0 ] && [ -f "$BUCKET/doomed.httpeers.net/index.html" ]; then
  ok "unconfirmed run refused (rc=$rc) and doomed.httpeers.net survives"
else
  notok "unconfirmed run refused (rc=$rc)" "$(cat "$TMP/out")"
fi
grep -q 'WHOLE SITES REMOVED' "$TMP/out" && ok "named the whole site that would be removed" \
  || notok "named the whole site that would be removed" "$(cat "$TMP/out")"
grep -qi 'no terminal to confirm' "$TMP/out" && ok "explained why it refused" \
  || notok "explained why it refused" "$(cat "$TMP/out")"

# 3b. an interactive-looking run that answers wrongly must also refuse. `yes`
# is not the accepted word when a whole site is at stake -- DELETE is.
if command -v script >/dev/null 2>&1; then
  printf 'yes\n' > "$TMP/answer"
  script -qec "$BIN/httpeers-publish" /dev/null < "$TMP/answer" > "$TMP/out" 2>&1; rc=$?
  if [ "$rc" != 0 ] && [ -f "$BUCKET/doomed.httpeers.net/index.html" ]; then
    ok "typing 'yes' at a whole-site removal is refused; the site survives"
  else
    notok "typing 'yes' at a whole-site removal is refused (rc=$rc)" "$(cat "$TMP/out")"
  fi
  printf 'DELETE\n' > "$TMP/answer"
  script -qec "$BIN/httpeers-publish" /dev/null < "$TMP/answer" > "$TMP/out" 2>&1; rc=$?
  if [ "$rc" = 0 ] && [ ! -e "$BUCKET/doomed.httpeers.net" ]; then
    ok "typing DELETE at a tty removes the prefix"
  else
    notok "typing DELETE at a tty removes the prefix (rc=$rc)" "$(cat "$TMP/out")"
  fi
else
  echo "  skip  tty confirmation (util-linux 'script' not available)"
fi

# 3c. --yes deletes.
scenario del2
site keep.httpeers.net
inbucket keep.httpeers.net
inbucket doomed.httpeers.net
rc="$(run "$BIN/httpeers-publish" --yes)"
if [ "$rc" = 0 ] && [ ! -e "$BUCKET/doomed.httpeers.net" ] && [ -f "$BUCKET/keep.httpeers.net/index.html" ]; then
  ok "--yes removes the prefix and keeps the other site"
else
  notok "--yes removes the prefix (rc=$rc)" "$(cat "$TMP/out")"
fi

echo
echo "== 4. an empty local tree is refused =="
scenario empty
inbucket a.httpeers.net
inbucket b.httpeers.net
rc="$(run "$BIN/httpeers-publish")"
if [ "$rc" != 0 ] && [ -f "$BUCKET/a.httpeers.net/index.html" ]; then
  ok "empty tree refused (rc=$rc), both sites survive"
else
  notok "empty tree refused (rc=$rc)" "$(cat "$TMP/out")"
fi

echo
echo "== 5. --yes does NOT bypass the empty-tree refusal =="
rc="$(run "$BIN/httpeers-publish" --yes)"
if [ "$rc" != 0 ] && [ -f "$BUCKET/a.httpeers.net/index.html" ] && [ -f "$BUCKET/b.httpeers.net/index.html" ]; then
  ok "--yes on an empty tree still refused (rc=$rc); nothing deleted"
else
  notok "--yes on an empty tree still refused (rc=$rc)" "$(cat "$TMP/out")"
fi
grep -q 'no --yes override' "$TMP/out" && ok "said the refusal has no override" \
  || notok "said the refusal has no override" "$(cat "$TMP/out")"

# A tree holding only dot entries is empty for our purposes -- .git and
# .DS_Store must not make a wiped checkout look populated.
scenario dotonly
mkdir -p "$SITES/.git"; touch "$SITES/.DS_Store"
inbucket a.httpeers.net
rc="$(run "$BIN/httpeers-publish" --yes)"
if [ "$rc" != 0 ] && [ -f "$BUCKET/a.httpeers.net/index.html" ]; then
  ok "a tree of only dot entries counts as empty and is refused"
else
  notok "a tree of only dot entries is refused (rc=$rc)" "$(cat "$TMP/out")"
fi

echo
echo "== 6. an invalid hostname directory is refused =="
for bad in "Upper.httpeers.net" "not_a_host.net" "dist" "-bad.httpeers.net"; do
  scenario "invalid"
  site good.httpeers.net
  mkdir -p "$SITES/$bad"; echo x > "$SITES/$bad/index.html"
  rc="$(run "$BIN/httpeers-publish" --yes)"
  if [ "$rc" != 0 ] && [ ! -e "$BUCKET/$bad" ] && [ ! -e "$BUCKET/good.httpeers.net" ]; then
    ok "refused the whole publish because of '$bad' (nothing uploaded)"
  else
    notok "refused because of '$bad' (rc=$rc)" "$(cat "$TMP/out")"
  fi
done

echo
echo "== 7. a loose file at the top of the tree is refused =="
scenario stray
site a.httpeers.net
echo notes > "$SITES/README.md"
rc="$(run "$BIN/httpeers-publish" --yes)"
if [ "$rc" != 0 ] && [ ! -e "$BUCKET/README.md" ]; then
  ok "loose top-level file refused, nothing uploaded"
else
  notok "loose top-level file refused (rc=$rc)" "$(cat "$TMP/out")"
fi
# A dot-file there is fine: it is filtered out on both sides.
rm "$SITES/README.md"; touch "$SITES/.DS_Store"
rc="$(run "$BIN/httpeers-publish" --yes)"
if [ "$rc" = 0 ] && [ ! -e "$BUCKET/.DS_Store" ] && [ -f "$BUCKET/a.httpeers.net/index.html" ]; then
  ok "a top-level dot-file is ignored, not uploaded, and does not block the publish"
else
  notok "a top-level dot-file is ignored (rc=$rc)" "$(cat "$TMP/out")"
fi
# ... but a dot-directory INSIDE a site is per-site config and must publish.
mkdir -p "$SITES/a.httpeers.net/.site"; echo '{"spa":true}' > "$SITES/a.httpeers.net/.site/config.json"
rc="$(run "$BIN/httpeers-publish" --yes)"
if [ "$rc" = 0 ] && [ -f "$BUCKET/a.httpeers.net/.site/config.json" ]; then
  ok "a site's .site/config.json is published (only FIRST-level dot entries are filtered)"
else
  notok "a site's .site/config.json is published (rc=$rc)" "$(cat "$TMP/out")"
fi

echo
echo "== 8. --site scopes everything to one prefix =="
scenario scoped
site a.httpeers.net
inbucket a.httpeers.net
inbucket untouched.httpeers.net
echo new > "$SITES/a.httpeers.net/page.html"
rc="$(run "$BIN/httpeers-publish" --site a.httpeers.net --yes)"
if [ "$rc" = 0 ] && [ -f "$BUCKET/a.httpeers.net/page.html" ] && [ -f "$BUCKET/untouched.httpeers.net/index.html" ]; then
  ok "--site published one prefix and left the other site alone"
else
  notok "--site scoping (rc=$rc)" "$(cat "$TMP/out")"
fi
# An empty site directory must not be a way to empty a live site.
rm -rf "${SITES:?}/a.httpeers.net"; mkdir -p "$SITES/a.httpeers.net"
rc="$(run "$BIN/httpeers-publish" --site a.httpeers.net --yes)"
if [ "$rc" != 0 ] && [ -f "$BUCKET/a.httpeers.net/index.html" ]; then
  ok "an empty site directory is refused even with --yes"
else
  notok "empty site directory refused (rc=$rc)" "$(cat "$TMP/out")"
fi

echo
echo "== 9. --delete-site is the explicit removal path =="
scenario delsite
site a.httpeers.net
inbucket a.httpeers.net
inbucket b.httpeers.net
rc="$(run "$BIN/httpeers-publish" --delete-site b.httpeers.net)"
if [ "$rc" != 0 ] && [ -e "$BUCKET/b.httpeers.net" ]; then
  ok "--delete-site with no tty and no --yes refuses"
else
  notok "--delete-site refuses unconfirmed (rc=$rc)" "$(cat "$TMP/out")"
fi
rc="$(run "$BIN/httpeers-publish" --delete-site b.httpeers.net --yes)"
if [ "$rc" = 0 ] && [ ! -e "$BUCKET/b.httpeers.net" ] && [ -e "$BUCKET/a.httpeers.net" ]; then
  ok "--delete-site --yes removed exactly that prefix"
else
  notok "--delete-site --yes (rc=$rc)" "$(cat "$TMP/out")"
fi
rc="$(run "$BIN/httpeers-publish" --delete-site b.httpeers.net --yes)"
if [ "$rc" = 0 ]; then ok "--delete-site on a missing prefix is a no-op (safe to run twice)"
else notok "--delete-site is idempotent (rc=$rc)" "$(cat "$TMP/out")"; fi
rc="$(run "$BIN/httpeers-publish" --delete-site "Bad_Name" --yes)"
if [ "$rc" != 0 ]; then ok "--delete-site refuses an invalid name rather than building a path from it"
else notok "--delete-site refuses an invalid name (rc=$rc)" "$(cat "$TMP/out")"; fi

echo
echo "== 10. --dry-run writes nothing =="
scenario dryrun
site a.httpeers.net
inbucket doomed.httpeers.net
rc="$(run "$BIN/httpeers-publish" --dry-run --yes)"
if [ "$rc" = 0 ] && [ -e "$BUCKET/doomed.httpeers.net" ] && [ ! -e "$BUCKET/a.httpeers.net" ]; then
  ok "--dry-run reported and changed nothing, even with --yes"
else
  notok "--dry-run writes nothing (rc=$rc)" "$(cat "$TMP/out")"
fi

echo
echo "== 11. httpeers-status =="
scenario status
site a.httpeers.net
inbucket a.httpeers.net second.html
rc="$(run "$BIN/httpeers-status" --porcelain)"
out="$(cat "$TMP/out")"
if [ "$rc" = 2 ] && printf '%s' "$out" | grep -qx 'A a.httpeers.net/index.html' \
   && printf '%s' "$out" | grep -qx 'D a.httpeers.net/second.html'; then
  ok "--porcelain lists A/D correctly and exits 2 when a delete is pending"
else
  notok "status --porcelain (rc=$rc)" "$out"
fi
# A size change must show as M, not as A+D.
inbucket a.httpeers.net index.html "a much longer body than hello"
rc="$(run "$BIN/httpeers-status" --porcelain)"
if printf '%s' "$(cat "$TMP/out")" | grep -qx 'M a.httpeers.net/index.html'; then
  ok "a changed file is reported as M"
else
  notok "changed file reported as M (rc=$rc)" "$(cat "$TMP/out")"
fi
scenario status2
site a.httpeers.net
inbucket a.httpeers.net
rc="$(run "$BIN/httpeers-status")"
if [ "$rc" = 0 ] && grep -q 'in sync' "$TMP/out"; then
  ok "status exits 0 and says 'in sync' when identical"
else
  notok "status in-sync (rc=$rc)" "$(cat "$TMP/out")"
fi

echo
echo "== 12. paths with spaces survive the diff =="
scenario spaces
mkdir -p "$SITES/a.httpeers.net/some dir"
echo hi > "$SITES/a.httpeers.net/some dir/a file.html"
rc="$(run "$BIN/httpeers-publish" --yes)"
if [ "$rc" = 0 ] && [ -f "$BUCKET/a.httpeers.net/some dir/a file.html" ]; then
  ok "a path containing spaces publishes correctly"
else
  notok "space in path (rc=$rc)" "$(cat "$TMP/out")"
fi

echo
echo "== 13. the mount preflight refuses on this machine, and starts nothing =="
scenario mountpf
site a.httpeers.net
rc="$(run "$BIN/httpeers-mount")"
if rclone serve --help 2>&1 | grep -qE '^[[:space:]]+nfs[[:space:]]'; then
  echo "  skip  this rclone HAS serve nfs; the negative preflight cannot be tested here"
else
  if [ "$rc" != 0 ] && grep -q 'serve nfs' "$TMP/out" && grep -q 'Nothing was started' "$TMP/out"; then
    ok "httpeers-mount refused, named the missing subcommand, and started nothing"
  else
    notok "mount preflight refuses (rc=$rc)" "$(cat "$TMP/out")"
  fi
  [ ! -e "$ROOT/.run/serve-nfs.pid" ] && ok "no pidfile was created" || notok "no pidfile was created"
fi
rc="$(run "$BIN/httpeers-unmount")"
if [ "$rc" = 0 ]; then ok "httpeers-unmount is a safe no-op when nothing is mounted"
else notok "unmount no-op (rc=$rc)" "$(cat "$TMP/out")"; fi

echo
echo "== 14. setup reports rather than repairs =="
scenario setuptest
site a.httpeers.net
rc="$(run "$BIN/httpeers-setup")"
if rclone serve --help 2>&1 | grep -qE '^[[:space:]]+nfs[[:space:]]'; then
  echo "  skip  setup's NFS failure path (this rclone has serve nfs)"
else
  if [ "$rc" != 0 ] && grep -q 'Nothing was installed or changed' "$TMP/out"; then
    ok "setup exits non-zero and states it changed nothing"
  else
    notok "setup exits non-zero on missing NFS prerequisites (rc=$rc)" "$(cat "$TMP/out")"
  fi
  grep -q 'nfs-common' "$TMP/out" && ok "setup names the exact apt package" \
    || notok "setup names nfs-common" "$(cat "$TMP/out")"
  grep -q 'rclone.org/install.sh' "$TMP/out" && ok "setup names the exact rclone upgrade command" \
    || notok "setup names the rclone upgrade command" "$(cat "$TMP/out")"
fi
rc="$(run "$BIN/httpeers-setup" --sync-only)"
if [ "$rc" = 0 ]; then ok "setup --sync-only passes (sync mode needs nothing extra)"
else notok "setup --sync-only passes (rc=$rc)" "$(cat "$TMP/out")"; fi

echo
echo "== 15. a broken destination aborts instead of reading as empty =="
# The failure that would be catastrophic: a listing error interpreted as "the
# bucket is empty" turns into "everything must be added" -- or, with the sides
# reversed, into a full delete. rclone exits 3 for "not found" and something
# else for a real failure; only the first is treated as empty.
scenario broken
site a.httpeers.net
export HTTPEERS_TARGET_OVERRIDE="nosuchremote:bucket"
rc="$(run "$BIN/httpeers-status")"
if [ "$rc" != 0 ] && grep -qi 'could not list' "$TMP/out"; then
  ok "an unusable destination aborts with 'could not list' instead of assuming empty"
else
  notok "unusable destination aborts (rc=$rc)" "$(cat "$TMP/out")"
fi

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
