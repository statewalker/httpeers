# Publishing sites by changing a folder

A site is a **first-level prefix in the `sites` bucket, named after its full domain**. The server
lowercases the `Host` header, strips the port, and looks up exactly that string as a prefix — so
publishing is writing files, and nothing else brings a site online: no DNS record, no
certificate, no Caddy edit, no restart.

These scripts make one local directory tree stand for that bucket.

```
sites/
  abc.httpeers.net/
    index.html
    .site/config.json        (optional; never served)
  cde.httpeers.net/
    index.html
```

Create a directory, and you create a site. Remove it, and you remove one. That is the whole
mental model; everything below is about making it true without making it easy to destroy
everything by accident.

Two ways to do it:

| | |
|---|---|
| **Sync mode** (default, works today) | you edit the tree, then run `httpeers-publish`. The tree is the source of truth; the publish is a reviewed, confirmed step. |
| **Live mode** (NFS) | the tree *is* the bucket. No publish step, no confirmation, no undo. **Needs two things this machine does not have — see [Live mode](#live-mode-nfs).** |

---

## Setup

```sh
cd tools/publish
cp publish.env.example publish.env
```

Fill in the two credentials. They exist in exactly one place — `/opt/httpeers/.env` on the
server, mode 600, generated there with `openssl rand`, never copied anywhere:

```sh
ssh kotelnikov@163.172.46.87 'grep S3_ /opt/httpeers/.env'
```

`publish.env` is gitignored. `statewalker/httpeers` is a public repository; nothing in this
directory may ever hold a real credential.

Then:

```sh
./bin/httpeers-setup            # checks everything, creates the rclone remote
./bin/httpeers-setup --sync-only  # ... skipping the NFS prerequisites
```

`httpeers-setup` **reports; it does not repair.** It installs nothing, upgrades nothing, and
never calls `sudo`. Each missing prerequisite is printed with the exact command that fixes it,
and the script exits non-zero. Everything the NFS mode needs is a system-wide change on what is
also somebody's workstation, and the difference between *a tool told me to run this* and *a tool
ran this* is the entire reason it is safe to run a publishing script.

The remote it creates:

```
type = s3
provider = Other
endpoint = https://s3.httpeers.net
force_path_style = true
```

`force_path_style` is not optional. With virtual-host addressing rclone resolves
`sites.s3.httpeers.net`, which does not exist — and the failure surfaces as a DNS error rather
than as a configuration one.

If a remote of that name already exists, `httpeers-setup` refuses to overwrite it and tells you
to pick another name with `HTTPEERS_RCLONE_REMOTE`.

---

## Sync mode

```sh
./bin/httpeers-status                        # what differs
./bin/httpeers-publish --dry-run             # the diff, writing nothing
./bin/httpeers-publish                       # publish, with the confirmation gate
./bin/httpeers-publish --site abc.httpeers.net   # one site only — the safest form
./bin/httpeers-publish --delete-site abc.httpeers.net
```

Adding a site:

```sh
mkdir -p sites/abc.httpeers.net
echo '<h1>hello</h1>' > sites/abc.httpeers.net/index.html
./bin/httpeers-publish --site abc.httpeers.net
```

Removing one — say so, rather than inferring it from an absence:

```sh
./bin/httpeers-publish --delete-site abc.httpeers.net
rm -rf sites/abc.httpeers.net
```

(`rm -rf sites/abc.httpeers.net` followed by a full `httpeers-publish` also works, and prompts.
`--delete-site` is preferred because it names what goes.)

### Exit statuses

| | `httpeers-status` | `httpeers-publish` |
|---|---|---|
| `0` | in sync | done |
| `1` | additions/changes pending | refused, or not confirmed |
| `2` | a deletion is pending | — |

`httpeers-status --porcelain` prints one `A`/`M`/`D` line per differing path, plus `S <name>` for
each whole site that would disappear.

---

## Why the publish is guarded

`rclone sync` is `rsync --delete`. Run at the top of the bucket it removes every prefix the local
tree does not contain — and a prefix is a whole site. The bucket is a **serving copy with no
backup** (runbook §5), so the dangerous command is not a typo. It is the *correct* command run
against a tree that is merely incomplete: a fresh clone before the content is in place, a
half-finished checkout, a `cd` into the wrong directory. Each of those looks exactly like a
deliberate "remove everything".

So every publish, in order:

1. **Guards the tree.** No site directories → refuse. A directory whose name is not a valid
   hostname → refuse the whole publish, not just that directory. A loose file at the top level →
   refuse. These run before anything is listed remotely.
2. **Computes and prints the diff** — added / changed / **DELETED**, and separately the list of
   whole sites that would disappear.
3. **Cross-checks against `rclone sync --dry-run`.** If rclone plans *more* deletions than the
   diff accounted for, the run aborts: the confirmation you were about to give would have been
   based on an understated list.
4. **Requires a typed confirmation for any deletion** — `yes` for files, `DELETE` when a whole
   site is at stake. A run with no terminal refuses outright unless `--yes` was passed, so a
   pipe, a cron job or a CI step cannot delete by default.

**`--yes` does not override the empty-tree refusal, the invalid-name refusal, or the empty-site
refusal.** Those have no override at all. Removing the last site is done by naming it.

### The two comparisons, and why they are different tools

The delete set is computed from two `rclone lsf` listings, not by parsing `rclone sync
--dry-run`, for two reasons that are both about trusting the answer:

- `rclone check` signals "differences found" with exit status 1 — which is also rclone's status
  for a usage error. A guard that cannot tell "nothing to delete" from "the command was wrong" is
  not a guard.
- The dry-run's delete lines are human-facing `NOTICE` text. If that wording ever changes, a
  parser silently counts zero deletions: it fails *open*, in the direction that loses data.

`lsf` fails closed instead. Status 0 means the listing is complete; 3 means the prefix does not
exist yet (nothing to delete); anything else aborts the run. The dry-run is still executed — as
the cross-check in step 3, where it can only ever make the run *more* cautious.

One honest limitation: the **changed** count compares sizes only, while rclone's sync compares
size *and* modification time. A same-size edit is therefore reported as unchanged and re-uploaded
anyway. That understates the change set and never understates the delete set, which is the only
one a guard may not get wrong.

### What is filtered

Top-level dot entries are excluded from **both** sides — `.git`, `.DS_Store`, a stray
`publish.env` dropped in the tree. rclone filters apply to the destination listing too, so an
excluded key is also protected from deletion. Only the *first* level is filtered:
`abc.httpeers.net/.site/config.json` is per-site configuration and publishes normally.

### Site names

A directory name must be what the server would accept as a `Host`: lowercase labels of
`[a-z0-9-]`, no leading or trailing `-`, each label at most 63 characters, 253 overall — the same
shape as `siteFromHost()` in `apps/sites/src/host.ts`. A name outside that could never be served,
so uploading it would only hide the mistake.

**One extra rule is ours, not the server's: at least one dot.** `siteFromHost()` accepts a single
label, but no browser sends `Host: dist`. A dotless directory at the top of the tree is
overwhelmingly a build output or a scratch folder in the wrong place — and treating it as a site
would both publish it and make a wiped checkout look populated to the empty-tree guard.

### After publishing

A **re-published** file can take up to `SITES_CACHE_TTL_MS` (default 60 s) to appear. Resolutions
are cached in the `sites` app and there is no publish hook to invalidate on (design §11). A
*newly created* site appears immediately — nothing negative was cached for it yet. Set the TTL to
`0` on the server while iterating.

---

## Live mode (NFS)

`rclone serve nfs` on loopback, mounted locally, so the folder *is* the bucket.

```sh
./bin/httpeers-mount            # starts the server, prints the mount command
./bin/httpeers-mount --sudo     # ... and runs it
./bin/httpeers-unmount --sudo   # unmount, then stop the server
```

### It does not run on this machine yet

Both of these are missing, and `httpeers-setup` and `httpeers-mount` both refuse and start
nothing until they are fixed:

| Missing | Why | Fix |
|---|---|---|
| **`rclone serve nfs`** | added in rclone **1.65**. This machine has **v1.60.1-DEV**, whose `rclone serve` offers only `dlna`, `docker`, `http`, `restic`, `sftp`, `webdav`. Distro packages lag badly. | `curl https://rclone.org/install.sh \| sudo bash` |
| **`mount.nfs`** | the NFS client utilities are not installed | `sudo apt install nfs-common` |

Mounting NFS also needs root on Linux, with no unprivileged equivalent. `httpeers-mount` prints
the exact `mount` command and stops; `--sudo` makes it run that command through `sudo`, visibly.
It never acquires root behind your back.

The command it builds:

```sh
rclone serve nfs httpeers:sites --addr 127.0.0.1:20490 --vfs-cache-mode writes
sudo mount -t nfs -o port=20490,mountport=20490,tcp,vers=3,nolock,noatime 127.0.0.1:/ ./mnt
```

`--vfs-cache-mode writes` is not tuning. `serve nfs` defaults to `off`, under which writes to the
mount fail outright — without it the mode does not work at all. `vers=3` because rclone's NFS
server speaks NFSv3 only, and `nolock` because there is no lock manager behind it and the kernel
would otherwise block waiting for one that never answers.

> **This command line has never been executed.** Neither prerequisite exists on this machine, so
> the flags above come from rclone's documentation for `serve nfs`, not from a mount that was
> observed working. Everything up to the refusal *is* tested — that `httpeers-mount` detects both
> gaps, names the fix, and starts nothing. Treat the first successful mount as the moment these
> flags are confirmed, and correct them here if they turn out wrong.

`httpeers-unmount` unmounts **before** stopping the server, always. The other order leaves the
kernel holding a mount whose backend is gone, and every process that touches it — including an
unrelated `ls` from a shell prompt, or a file manager indexing the tree — blocks uninterruptibly.
It also sends `TERM` and waits rather than `KILL`: the VFS write cache holds uploads that have
not reached the bucket yet, and rclone flushes them on a clean shutdown.

### Two things that will surprise you

- **None of the safety above applies inside the mount.** There is no diff, no confirmation and no
  undo. `rm -rf mnt/abc.httpeers.net` takes the site off the internet the moment the last object
  is gone. That is the point of the mode; it is also why sync mode is the default.
- **S3 has no directories.** An *empty* directory you create in the mount does not exist in the
  bucket and is not a site. A site begins to exist when the first file lands in it, and stops
  existing when the last one is removed. "Creating a directory creates a site" is true only once
  a file is in it.

### FUSE, the alternative that is not built here

`rclone mount` (FUSE) would give the same writable folder on this machine with **no root and no
new packages** — `/usr/bin/fusermount3` and `/dev/fuse` are already present. NFS was chosen
deliberately over it. `httpeers-setup` points this out and does nothing about it. If you change
your mind, the equivalent is:

```sh
rclone mount httpeers:sites ./mnt --vfs-cache-mode writes &
fusermount3 -u ./mnt
```

(It still needs rclone ≥ 1.65 for a usable VFS write cache on this workflow, so the upgrade is
common to both paths.)

---

## Tests

```sh
./tests/run-tests.sh
```

**No credentials and no real bucket.** rclone treats a plain directory as a remote, so
`HTTPEERS_TARGET_OVERRIDE` points the identical code path at a temporary directory. The guards,
the diff and the actual `rclone sync` are all real; only the destination is fake.

They prove, among other things: a new local directory becomes a new remote prefix; deleting one
removes the prefix *only* after confirmation (and `yes` is not an accepted answer when a whole
site is at stake — `DELETE` is); an empty tree is refused, and `--yes` does not bypass that; a
tree holding only dot entries counts as empty; an invalid hostname refuses the *whole* publish;
`--dry-run` writes nothing even with `--yes`; a destination that cannot be listed aborts instead
of reading as empty.

### What the tests do not cover

- **S3 semantics.** The fake bucket is a POSIX directory. It has real directories, exact
  modification times, and no eventual consistency — S3 has none of those. In particular, the
  "empty directory is not a site" behaviour above cannot be exercised locally.
- **The NFS mode itself.** Its prerequisites are absent on this machine, so only the *negative*
  preflight is tested: that `httpeers-mount` refuses, names what is missing, and starts nothing.
  No mount has ever been made.
- **Anything against the real deployment.** Nothing here has been run against
  `s3.httpeers.net`, and no credential has been used.
- **`shellcheck`.** It is not installed on this machine, so the scripts are `bash -n` clean but
  have not been linted.

---

## Files

```
tools/publish/
  README.md
  publish.env.example      # endpoint, bucket, credentials; publish.env is gitignored
  lib/common.sh            # config, guards, hostname validation, the diff
  bin/httpeers-setup       # preflight; creates the rclone remote
  bin/httpeers-status      # what differs between the tree and the bucket
  bin/httpeers-publish     # sync mode, with the dry-run + confirm gate
  bin/httpeers-mount       # NFS: start `rclone serve nfs`, mount it
  bin/httpeers-unmount     # unmount, stop the server
  tests/run-tests.sh
```

See also: `deploy/README.md` (§ *Publishing a site*), the design spec §5 and §8, and the server
runbook §5, §7 and §8.
