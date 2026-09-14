/**
 * Publish the built pages to the static host.
 *
 *   node scripts/deploy.mjs --root <dir> [--only hub,images] [--dry-run]
 *
 * The target is one directory per DOMAIN, which is how the bucket is laid out:
 * `<root>/hub.httpeers.net/`, `<root>/images.httpeers.net/`, and so on. In this
 * workspace `<root>` is an rclone FUSE mount of the bucket, so a write here is
 * LIVE IMMEDIATELY -- there is no staging step and no build pipeline between
 * this script and a visitor. That is the whole reason for `--dry-run` and for
 * the refusals below.
 *
 * WHAT IT WILL NOT DO:
 *
 *   - create a domain directory. Every directory it writes to must already
 *     exist. A typo in a domain name would otherwise publish a page to a
 *     plausible-looking folder nobody serves, and the failure would be silent.
 *   - touch a domain that is not in the table. `img.httpeers.net` and
 *     `test.httpeers.net` live in the same bucket and belong to something else.
 *   - delete anything outside `assets/`. The old deployment left a per-site
 *     `httpeers.json` carrying the relay address; these pages read the relay's
 *     own `.well-known` document instead, so the file is inert -- but it is not
 *     this script's to remove, and a page rolled back would want it.
 *
 * `assets/` IS EMPTIED, because its filenames are content-hashed: nothing ever
 * overwrites an old bundle, it just accumulates beside the new one. The
 * index.html of the moment names exactly one, so the rest are orphans.
 */

import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Built page -> the domain that serves it. The only domains this script may write to. */
const SITES = {
  hub: "hub.httpeers.net",
  images: "images.httpeers.net",
  app: "app.httpeers.net",
  proxy: "proxy.httpeers.net",
};

function parseArgs(argv) {
  const args = { dryRun: false, only: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--root") args.root = argv[++i];
    else if (a === "--only")
      args.only = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else throw new Error(`unknown flag: ${a}`);
  }
  if (args.root == null)
    throw new Error("--root <dir> is required (the directory holding one folder per domain)");
  const unknown = (args.only ?? []).filter((p) => !(p in SITES));
  if (unknown.length)
    throw new Error(`not a page: ${unknown.join(", ")} (known: ${Object.keys(SITES).join(", ")})`);
  return args;
}

const exists = async (p) =>
  access(p).then(
    () => true,
    () => false,
  );

/** Every file under `dir`, as paths relative to it. */
async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(relative(base, full));
  }
  return out.sort();
}

async function deployPage(page, root, dryRun) {
  const from = join(here, "..", "dist", page);
  const to = join(root, SITES[page]);

  if (!(await exists(from)))
    throw new Error(`${page}: nothing built at ${from} -- run \`npm run build\` first`);
  // Never created: see the header. An absent directory means the domain is not
  // provisioned, or the name is wrong, and both should stop the deploy.
  if (!(await exists(to)))
    throw new Error(`${page}: no directory for ${SITES[page]} under ${root}`);

  const files = await walk(from);
  const index = files.find((f) => f === "index.html");
  if (index == null) throw new Error(`${page}: the build has no index.html`);

  const before = (await exists(join(to, "assets"))) ? await walk(join(to, "assets")) : [];
  console.log(`\n${page} -> ${SITES[page]}`);
  console.log(`  ${files.length} file(s) in, ${before.length} stale asset(s) out`);

  if (dryRun) {
    for (const f of files) console.log(`    would write ${f}`);
    for (const f of before) console.log(`    would remove assets/${f}`);
    return { page, written: 0, removed: 0 };
  }

  // Assets first: an emptied directory is briefly a page with no bundle, so
  // keep that window as small as possible and refill it before index.html is
  // replaced. Visitors mid-flight hold a URL that is about to 404 either way;
  // ordering it this way means the NEW index.html never points at nothing.
  if (before.length > 0) await rm(join(to, "assets"), { recursive: true, force: true });

  let written = 0;
  for (const f of files.filter((f) => f !== "index.html")) {
    const target = join(to, f);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(from, f)));
    written++;
  }
  await writeFile(join(to, "index.html"), await readFile(join(from, "index.html")));
  written++;

  return { page, written, removed: before.length };
}

const args = parseArgs(process.argv.slice(2));
if (!(await exists(args.root))) throw new Error(`--root does not exist: ${args.root}`);
if (!(await stat(args.root)).isDirectory())
  throw new Error(`--root is not a directory: ${args.root}`);

const pages = args.only ?? Object.keys(SITES);
console.log(`root     : ${args.root}`);
console.log(
  `pages    : ${pages.join(", ")}${args.dryRun ? "  (DRY RUN -- nothing is written)" : ""}`,
);

const results = [];
for (const page of pages) results.push(await deployPage(page, args.root, args.dryRun));

console.log(
  `\n${args.dryRun ? "would publish" : "published"}: ${results.map((r) => `${r.page} (${r.written} file(s))`).join(", ")}`,
);
if (!args.dryRun) console.log("verify with: node scripts/live-smoke.mjs");
