#!/usr/bin/env bash
# shellcheck shell=bash
#
# Shared configuration, guards and rclone plumbing for the publishing tools.
#
# THE ENTIRE SAFETY STORY OF THESE SCRIPTS LIVES IN THIS FILE. The bucket is a
# serving copy with no backup (runbook §5), `rclone sync` at the top level of
# that bucket deletes any prefix the local tree does not contain, and a prefix
# is a whole site. So the dangerous command is not a typo -- it is the correct
# command run against a tree that is merely incomplete: a fresh clone, a
# half-finished checkout, a `cd` into the wrong directory. Every guard below
# exists for that case, not for a hostile one.

# ---------------------------------------------------------------------------
# Output. Diagnostics go to stderr so that `httpeers-status --porcelain` and
# friends stay pipeable.
# ---------------------------------------------------------------------------

_tty_bold=""; _tty_red=""; _tty_yellow=""; _tty_dim=""; _tty_reset=""
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  _tty_bold=$'\033[1m'; _tty_red=$'\033[31m'; _tty_yellow=$'\033[33m'
  _tty_dim=$'\033[2m'; _tty_reset=$'\033[0m'
fi

info() { printf '%s\n' "$*" >&2; }
note() { printf '%s%s%s\n' "$_tty_dim" "$*" "$_tty_reset" >&2; }
warn() { printf '%swarning:%s %s\n' "$_tty_yellow" "$_tty_reset" "$*" >&2; }
err()  { printf '%serror:%s %s\n' "$_tty_red" "$_tty_reset" "$*" >&2; }
bold() { printf '%s%s%s\n' "$_tty_bold" "$*" "$_tty_reset" >&2; }
die()  { err "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------

# Resolved from this file, not from $0, so the scripts work through a symlink
# placed on PATH.
PUBLISH_LIB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PUBLISH_ROOT="$(dirname -- "$PUBLISH_LIB_DIR")"
export PUBLISH_ROOT

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Read `publish.env` if it is there. It holds credentials, so it is gitignored
# and never required to exist -- everything in it can also come from the real
# environment, which is what CI and the test suite do.
load_config() {
  local env_file="${HTTPEERS_ENV_FILE:-$PUBLISH_ROOT/publish.env}"

  if [ -f "$env_file" ]; then
    # `set -a` exports every assignment, so the values reach rclone as
    # environment variables without a second export list to keep in sync.
    set -a
    # shellcheck disable=SC1090  # path is configuration, not a literal
    . "$env_file"
    set +a
    HTTPEERS_ENV_FILE_USED="$env_file"
  else
    HTTPEERS_ENV_FILE_USED=""
  fi

  : "${HTTPEERS_S3_ENDPOINT:=https://s3.httpeers.net}"
  : "${HTTPEERS_S3_BUCKET:=sites}"
  : "${HTTPEERS_RCLONE_REMOTE:=httpeers}"
  : "${HTTPEERS_SITES_DIR:=$PUBLISH_ROOT/sites}"
  : "${HTTPEERS_NFS_ADDR:=127.0.0.1:20490}"
  : "${HTTPEERS_MOUNT_POINT:=$PUBLISH_ROOT/mnt}"
  : "${HTTPEERS_RUN_DIR:=$PUBLISH_ROOT/.run}"

  # HTTPEERS_TARGET_OVERRIDE replaces the whole rclone destination. It exists
  # so the test suite can point the identical code path at a plain directory
  # (rclone treats a local path as a remote), which is the only way to exercise
  # the delete gate without credentials and without the real bucket.
  if [ -n "${HTTPEERS_TARGET_OVERRIDE:-}" ]; then
    HTTPEERS_TARGET="$HTTPEERS_TARGET_OVERRIDE"
    HTTPEERS_TARGET_IS_LOCAL=1
  else
    HTTPEERS_TARGET="${HTTPEERS_RCLONE_REMOTE}:${HTTPEERS_S3_BUCKET}"
    HTTPEERS_TARGET_IS_LOCAL=0
  fi

  # Absolutise the tree once, so error messages name a path the user can paste
  # and so a later `cd` inside a script cannot change what "the tree" means.
  if [ -d "$HTTPEERS_SITES_DIR" ]; then
    HTTPEERS_SITES_DIR="$(cd -- "$HTTPEERS_SITES_DIR" && pwd)"
  fi

  export HTTPEERS_S3_ENDPOINT HTTPEERS_S3_BUCKET HTTPEERS_RCLONE_REMOTE \
         HTTPEERS_SITES_DIR HTTPEERS_TARGET HTTPEERS_TARGET_IS_LOCAL \
         HTTPEERS_NFS_ADDR HTTPEERS_MOUNT_POINT HTTPEERS_RUN_DIR
}

require_rclone() {
  command -v rclone >/dev/null 2>&1 \
    || die "rclone is not installed. Install it: https://rclone.org/install/"
}

# ---------------------------------------------------------------------------
# Filters
#
# Top-level dot entries are excluded from BOTH sides of every operation. rclone
# filters apply to the destination listing as well as the source, so an
# excluded remote key is also protected from deletion -- which is what we want:
# `.git`, `.DS_Store` and a stray `publish.env` dropped in the tree must
# neither be uploaded nor cause anything to be removed.
#
# Note this excludes only the FIRST level. `abc.httpeers.net/.site/config.json`
# is per-site configuration (design §8) and must publish normally.
# ---------------------------------------------------------------------------

rclone_filters() {
  printf '%s\n' --exclude "/.*" --exclude "/.*/**"
}

# ---------------------------------------------------------------------------
# Site names
# ---------------------------------------------------------------------------

# The same shape `apps/sites/src/host.ts` accepts, because that is what decides
# whether the published prefix is ever reachable: the server lowercases the
# `Host` header, strips the port, and looks up EXACTLY that string as a
# first-level prefix. A directory the server's `siteFromHost()` would reject is
# a directory that can never be served, so uploading it only wastes space and
# hides the mistake.
#
# The dot requirement is ours, not the server's. `siteFromHost()` accepts a
# single label, but no browser ever sends `Host: dist` -- so a dotless
# directory at the top of the tree is overwhelmingly a build output or a
# scratch folder that landed in the wrong place, and treating it as a site
# would silently publish it AND make the tree look legitimate to the
# empty-tree guard below.
valid_site_name() {
  local name="$1"
  [ "${#name}" -ge 1 ] && [ "${#name}" -le 253 ] || return 1
  [[ "$name" == *.* ]] || return 1
  [[ "$name" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$ ]]
}

# Print the first-level site directories, one per line, sorted. Dot entries are
# skipped to match rclone_filters(). Prints nothing (rc 0) for an empty tree --
# the caller decides what an empty tree means.
list_local_sites() {
  local root="$1" entry name
  [ -d "$root" ] || return 0
  for entry in "$root"/*/; do
    [ -d "$entry" ] || continue          # no match => the literal glob
    name="$(basename -- "${entry%/}")"
    case "$name" in .*) continue ;; esac
    printf '%s\n' "$name"
  done | LC_ALL=C sort
}

# Non-directory, non-dot entries at the top level. These are a symptom, not a
# feature: a file there would sync to the bucket root, outside every site
# prefix, where nothing serves it -- and its presence usually means the tree
# root is not what the user thinks it is.
list_local_stray_files() {
  local root="$1" entry name
  [ -d "$root" ] || return 0
  for entry in "$root"/*; do
    [ -e "$entry" ] || continue
    [ -d "$entry" ] && continue
    name="$(basename -- "$entry")"
    case "$name" in .*) continue ;; esac
    printf '%s\n' "$name"
  done | LC_ALL=C sort
}

# ---------------------------------------------------------------------------
# The tree guards. Called by every command that can write.
# ---------------------------------------------------------------------------

# THE REFUSAL THAT HAS NO OVERRIDE. An empty tree is never a legitimate request
# to delete every site: `rclone sync` of nothing over the bucket root removes
# all of them, and the two ways to arrive here -- a fresh checkout before the
# content is in place, and running from the wrong directory -- both look
# exactly like a deliberate "remove everything". Since there is no way to tell
# them apart, and one of the three is unrecoverable (runbook §5: no backup),
# this refuses unconditionally. `--yes` does not reach it. Removing the last
# site is done by naming it: `httpeers-publish --site <name> --delete-site`.
assert_tree_is_publishable() {
  local root="$1" sites strays invalid=() name

  [ -e "$root" ] || die "the site tree does not exist: $root
  create it, or set HTTPEERS_SITES_DIR to where your sites live."
  [ -d "$root" ] || die "the site tree is not a directory: $root"

  sites="$(list_local_sites "$root")"
  if [ -z "$sites" ]; then
    err "refusing to publish: $root contains no site directories."
    info "  A top-level sync from an empty tree deletes every site in the bucket,"
    info "  and the bucket has no backup. This refusal has no --yes override."
    info "  Each site is one directory named after its full domain, e.g."
    info "    mkdir -p $root/abc.httpeers.net && echo hi > $root/abc.httpeers.net/index.html"
    exit 1
  fi

  while IFS= read -r name; do
    valid_site_name "$name" || invalid+=("$name")
  done <<< "$sites"

  if [ "${#invalid[@]}" -gt 0 ]; then
    err "refusing to publish: these top-level directories are not valid site names:"
    for name in "${invalid[@]}"; do info "    $name"; done
    info "  A site directory's name IS the domain the server matches against the Host"
    info "  header -- lowercase, dot-separated labels of [a-z0-9-], no leading or"
    info "  trailing '-', at least one dot, 253 characters at most. A name outside"
    info "  that could never be served, so publishing it would only hide the mistake."
    info "  Rename it, or move it out of $root."
    exit 1
  fi

  strays="$(list_local_stray_files "$root")"
  if [ -n "$strays" ]; then
    err "refusing to publish: loose files at the top of $root:"
    while IFS= read -r name; do info "    $name"; done <<< "$strays"
    info "  Only site directories belong at this level. A file here would land in the"
    info "  bucket root, outside every site prefix, where nothing serves it -- and it"
    info "  usually means the tree root is not the directory you meant."
    info "  Move it inside a site, or rename it to start with a dot (dot entries are"
    info "  ignored on both sides and are never uploaded or deleted)."
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Diff
#
# The delete set is computed from two `rclone lsf` listings rather than by
# parsing `rclone sync --dry-run`. Two reasons, both about trusting the answer:
#
#   1. `rclone check` signals "differences found" with exit status 1, which is
#      also rclone's status for a usage error. A guard that cannot distinguish
#      "nothing to delete" from "the command was wrong" is not a guard.
#   2. The dry-run's delete lines are human-facing NOTICE text. If that wording
#      ever changes, a parser silently counts zero deletions -- failing open,
#      in the direction that loses data.
#
# `lsf` fails closed instead: status 0 means the listing is complete, 3 means
# the destination prefix does not exist yet (nothing to delete), and anything
# else aborts.
# ---------------------------------------------------------------------------

# Populates the file $2 with "<size> <path>" lines for $1 (an rclone path).
# Returns 1 if the path does not exist, 0 on success, aborts on any other
# failure -- because an incomplete listing read as "empty" is exactly the
# mistake that deletes a bucket.
_lsf_into() {
  local target="$1" out="$2" rc=0 stderr
  local -a _filters=()
  stderr="$(mktemp)"
  mapfile -t _filters < <(rclone_filters)
  rclone lsf -R --files-only --format "sp" --separator " " \
    "${_filters[@]}" "$target" >"$out" 2>"$stderr" || rc=$?
  case "$rc" in
    0) rm -f "$stderr"; return 0 ;;
    3) : >"$out"; rm -f "$stderr"; return 1 ;;   # directory not found
    *)
      err "could not list $target (rclone exit $rc):"
      sed 's/^/    /' "$stderr" >&2
      rm -f "$stderr"
      exit 1
      ;;
  esac
}

# compute_diff <local-dir> <rclone-target> <workdir>
#
# Writes three sorted path lists into <workdir>: added, changed, deleted; and
# sets DIFF_ADDED / DIFF_CHANGED / DIFF_DELETED to their counts, plus
# DIFF_SITES_REMOVED to the list of whole site prefixes that disappear.
compute_diff() {
  local src="$1" dst="$2" work="$3"
  local src_list="$work/src.lsf" dst_list="$work/dst.lsf"

  _lsf_into "$src" "$src_list" || true          # a missing local tree is caught earlier
  _lsf_into "$dst" "$dst_list" || true          # a missing destination is legitimately empty

  # "<size> <path>" -> keyed by path. Sorting on the path field only, so the
  # join below is a pure set operation on paths and sizes never reorder it.
  awk '{ size=$1; $1=""; sub(/^ /,""); print $0 "\t" size }' "$src_list" \
    | LC_ALL=C sort -t$'\t' -k1,1 > "$work/src.tsv"
  awk '{ size=$1; $1=""; sub(/^ /,""); print $0 "\t" size }' "$dst_list" \
    | LC_ALL=C sort -t$'\t' -k1,1 > "$work/dst.tsv"

  cut -f1 "$work/src.tsv" > "$work/src.paths"
  cut -f1 "$work/dst.tsv" > "$work/dst.paths"

  LC_ALL=C comm -23 "$work/src.paths" "$work/dst.paths" > "$work/added"
  LC_ALL=C comm -13 "$work/src.paths" "$work/dst.paths" > "$work/deleted"

  # "changed" is reported on size alone. rclone's own sync decides with size
  # AND modification time, so a same-size edit shows here as unchanged and is
  # still re-uploaded. That understates the change set and never understates
  # the DELETE set, which is the only one a guard may not get wrong.
  LC_ALL=C join -t$'\t' -j1 -o 0,1.2,2.2 "$work/src.tsv" "$work/dst.tsv" \
    | awk -F'\t' '$2 != $3 { print $1 }' > "$work/changed"

  # Whole sites disappearing: a first-level prefix present remotely and absent
  # locally. Reported separately because losing one is categorically worse than
  # losing a file inside one.
  awk -F/ 'NF>1 { print $1 }' "$work/dst.paths" | LC_ALL=C sort -u > "$work/dst.sites"
  awk -F/ 'NF>1 { print $1 }' "$work/src.paths" | LC_ALL=C sort -u > "$work/src.sites"
  LC_ALL=C comm -13 "$work/src.sites" "$work/dst.sites" > "$work/sites-removed"

  DIFF_ADDED=$(wc -l < "$work/added" | tr -d ' ')
  DIFF_CHANGED=$(wc -l < "$work/changed" | tr -d ' ')
  DIFF_DELETED=$(wc -l < "$work/deleted" | tr -d ' ')
  DIFF_SITES_REMOVED=$(wc -l < "$work/sites-removed" | tr -d ' ')
  export DIFF_ADDED DIFF_CHANGED DIFF_DELETED DIFF_SITES_REMOVED
}

# print_diff <workdir> [limit]
print_diff() {
  local work="$1" limit="${2:-20}" f label
  for f in added changed deleted; do
    case "$f" in
      added)   label="added" ;;
      changed) label="changed" ;;
      deleted) label="DELETED" ;;
    esac
    local n; n=$(wc -l < "$work/$f" | tr -d ' ')
    [ "$n" -eq 0 ] && continue
    if [ "$f" = deleted ]; then
      printf '%s%s (%s):%s\n' "$_tty_red$_tty_bold" "$label" "$n" "$_tty_reset" >&2
    else
      printf '%s%s (%s):%s\n' "$_tty_bold" "$label" "$n" "$_tty_reset" >&2
    fi
    head -n "$limit" "$work/$f" | sed 's/^/    /' >&2
    [ "$n" -gt "$limit" ] && note "    ... and $((n - limit)) more"
  done
  if [ "$DIFF_SITES_REMOVED" -gt 0 ]; then
    printf '%sWHOLE SITES REMOVED (%s):%s\n' \
      "$_tty_red$_tty_bold" "$DIFF_SITES_REMOVED" "$_tty_reset" >&2
    sed 's/^/    /' "$work/sites-removed" >&2
  fi
  if [ "$DIFF_ADDED" -eq 0 ] && [ "$DIFF_CHANGED" -eq 0 ] && [ "$DIFF_DELETED" -eq 0 ]; then
    info "in sync -- nothing to do."
  fi
}

# ---------------------------------------------------------------------------
# Confirmation
# ---------------------------------------------------------------------------

# confirm_destructive <assume-yes> <workdir>
#
# Returns 0 to proceed. Exits non-zero to refuse. A run with nothing to delete
# never reaches the prompt.
confirm_destructive() {
  local assume_yes="$1" work="$2" want reply

  [ "$DIFF_DELETED" -eq 0 ] && return 0

  if [ "$assume_yes" = 1 ]; then
    warn "--yes given: proceeding with $DIFF_DELETED deletion(s)" \
         "${DIFF_SITES_REMOVED:+including $DIFF_SITES_REMOVED whole site(s)}"
    return 0
  fi

  # A pipe, a cron job or a CI step must not be able to delete by default. The
  # operator has to have decided in advance, in the command line, which is what
  # --yes records.
  if [ ! -t 0 ]; then
    err "refusing to delete $DIFF_DELETED remote file(s) with no terminal to confirm at."
    info "  Re-run interactively, or pass --yes if you have read the list above and"
    info "  meant it. There is no backup of this bucket."
    exit 1
  fi

  # Typing a word rather than pressing 'y': removing a whole site is not a
  # keystroke-sized decision, and a stray Enter must not be an answer.
  if [ "$DIFF_SITES_REMOVED" -gt 0 ]; then
    want=DELETE
    printf '%s%s whole site(s) will be removed from the bucket, permanently.%s\n' \
      "$_tty_red$_tty_bold" "$DIFF_SITES_REMOVED" "$_tty_reset" >&2
    printf 'Type %s to confirm: ' "$want" >&2
  else
    want=yes
    printf '%s%s remote file(s) will be deleted.%s\n' \
      "$_tty_red" "$DIFF_DELETED" "$_tty_reset" >&2
    printf 'Type %s to confirm: ' "$want" >&2
  fi

  IFS= read -r reply || reply=""
  if [ "$reply" != "$want" ]; then
    err "not confirmed -- nothing was changed."
    exit 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Preflight helpers, shared by setup and the mount scripts
# ---------------------------------------------------------------------------

rclone_version() { rclone version 2>/dev/null | awk 'NR==1 {print $2}'; }

# `rclone serve nfs` arrived in rclone 1.65. Asking the binary what it can do
# is better than comparing version strings: this machine reports
# "v1.60.1-DEV", and a distro or self-built binary can carry any label it
# likes while the subcommand list is the truth.
rclone_has_serve_nfs() {
  rclone serve --help 2>&1 | grep -qE '^[[:space:]]+nfs[[:space:]]'
}

have_mount_nfs() {
  command -v mount.nfs >/dev/null 2>&1 || [ -x /sbin/mount.nfs ] || [ -x /usr/sbin/mount.nfs ]
}
