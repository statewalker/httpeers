/**
 * Publish the built shell to the `p.httpeers.net` prefix of the sites bucket.
 *
 *   node scripts/deploy.mjs --root <bucket-dir> [--dry-run] [--create]
 *
 * `<bucket-dir>` holds one directory per domain. In the umbrella workspace it
 * is `umbrella-next/s3.httpeers.net`, an rclone FUSE mount: a write there is
 * LIVE IMMEDIATELY, for every session name at once. Hence `--dry-run`, and the
 * same refusals as `apps/demos/scripts/deploy.mjs`:
 *
 *   - ONE DESTINATION. The only directory this script writes is
 *     `<root>/p.httpeers.net`. Every `<name>.p.httpeers.net` reads that one
 *     prefix, because Caddy rewrites the Host header -- see deploy/Caddyfile.
 *   - IT DOES NOT CREATE IT unless told to (`--create`, the first publish
 *     only). An absent directory otherwise means the wrong root or an
 *     unmounted bucket -- and an unmounted FUSE mount looks exactly like an
 *     empty folder, so writing into it would "succeed" into nothing.
 *   - IT DELETES ONLY INSIDE `_shell/`, whose names are content-hashed and
 *     would otherwise accumulate.
 *
 * ORDER MATTERS, because visitors are mid-flight: the hashed assets first, the
 * worker next, and `relay.html` -- the page that names the new assets -- last,
 * so no published `relay.html` ever points at a file that is not there yet.
 */

import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DOMAIN = "p.httpeers.net";
const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "dist", "site");

function parseArgs(argv) {
  const args = { dryRun: false, create: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--create") args.create = true;
    else if (a === "--root") args.root = argv[++i];
    else throw new Error(`unknown flag: ${a}`);
  }
  if (args.root == null)
    throw new Error("--root <dir> is required (the bucket, one folder per domain)");
  return args;
}

const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(relative(base, full));
  }
  return out.sort();
}

/** Assets, then the worker and the rest, then relay.html. */
function publishOrder(files) {
  const rank = (f) => (f.startsWith("_shell/") ? 0 : f === "relay.html" ? 2 : 1);
  return [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const args = parseArgs(process.argv.slice(2));
if (!(await exists(args.root)) || !(await stat(args.root)).isDirectory()) {
  throw new Error(`--root is not a directory: ${args.root}`);
}
// A MOUNTED bucket has the other domains in it. An empty root is the unmounted
// FUSE point, and publishing into it would write to local disk, silently.
const siblings = (await readdir(args.root)).filter((d) => d.endsWith(".httpeers.net"));
if (siblings.length === 0)
  throw new Error(`${args.root} holds no domains -- is the bucket mounted?`);

if (!(await exists(join(from, "relay-sw.js"))))
  throw new Error("nothing built -- run `pnpm run build`");
const files = publishOrder(await walk(from));
for (const required of ["relay.html", "relay-sw.js", "index.html", ".site/config.json"]) {
  if (!files.includes(required)) throw new Error(`the build has no ${required}`);
}

const to = join(args.root, DOMAIN);
if (!(await exists(to))) {
  if (!args.create)
    throw new Error(`no ${DOMAIN} directory under ${args.root} (first publish? pass --create)`);
  console.log(`${args.dryRun ? "would create" : "creating"} ${to}`);
  if (!args.dryRun) await mkdir(to);
}

const fresh = new Set(files.filter((f) => f.startsWith("_shell/")).map((f) => f.slice(7)));
const stale = ((await exists(join(to, "_shell"))) ? await walk(join(to, "_shell")) : []).filter(
  (f) => !fresh.has(f),
);
console.log(`${DOMAIN}: ${files.length} file(s) in, ${stale.length} old _shell/ file(s) out`);
if (args.dryRun) {
  for (const f of stale) console.log(`  would remove _shell/${f}`);
  for (const f of files) console.log(`  would write ${f}`);
  process.exit(0);
}

// The new hashed assets are written before the old ones go, and both before
// relay.html changes: an old relay.html keeps working until the new one lands.
for (const f of files) {
  if (f === "relay.html") continue;
  await mkdir(dirname(join(to, f)), { recursive: true });
  await writeFile(join(to, f), await readFile(join(from, f)));
  console.log(`  wrote ${f}`);
}
await writeFile(join(to, "relay.html"), await readFile(join(from, "relay.html")));
console.log("  wrote relay.html");
for (const f of stale) {
  await rm(join(to, "_shell", f), { force: true });
  console.log(`  removed _shell/${f}`);
}
console.log(`published. verify: node scripts/live-check.mjs`);
