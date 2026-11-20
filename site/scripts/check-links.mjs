// Checks every internal link of the built site: each href and src in dist/**/*.html that points
// into the site must name a file the build wrote, and a #fragment must name an id (or a name) on
// the page it points to. External URLs (http:, mailto:, …) are not fetched. Fails listing every
// broken link with the page it is on.
//
//   pnpm build && pnpm check:links
//
// "/docs/access" and "/docs/access/" both resolve to dist/docs/access/index.html, as the static
// host serves them.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;

/** Every file under dir, as site paths ("/docs/index.html"). */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full) : [`/${relative(DIST, full).split(sep).join("/")}`];
  });
}

const files = new Set(walk(DIST));
const pages = [...files].filter((f) => f.endsWith(".html"));
if (!pages.length) {
  console.error(`no HTML in ${DIST} (run the build first)`);
  process.exit(1);
}

const decode = (s) =>
  s
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

// Only real tags: text inside code blocks is escaped (&lt;a href=…), so it never matches.
const TAG = /<[a-zA-Z][^>]*>/g;
const attr = (tag, name) =>
  [...tag.matchAll(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "g"))].map((m) =>
    decode(m[1] ?? m[2]),
  );

const idsByPage = new Map();
const linksByPage = new Map();
for (const page of pages) {
  const html = readFileSync(join(DIST, page), "utf8");
  const ids = new Set();
  const links = [];
  for (const [tag] of html.matchAll(TAG)) {
    for (const v of [...attr(tag, "id"), ...(tag.startsWith("<a") ? attr(tag, "name") : [])]) {
      ids.add(v);
    }
    for (const v of [...attr(tag, "href"), ...attr(tag, "src")]) links.push(v);
  }
  idsByPage.set(page, ids);
  linksByPage.set(page, links);
}

/** The built file a site path is served from, or null. */
function resolveFile(path) {
  const candidates = path.endsWith("/")
    ? [`${path}index.html`]
    : [path, `${path}/index.html`, `${path}.html`];
  return candidates.find((c) => files.has(c) && statSync(join(DIST, c)).isFile()) ?? null;
}

const broken = [];
for (const [page, links] of linksByPage) {
  for (const link of links) {
    // External, or not a location at all.
    if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("//")) continue;
    const [beforeHash, fragment = ""] = link.split("#", 2);
    const pathPart = beforeHash.split("?")[0];
    let target = page;
    if (pathPart) {
      let path;
      try {
        path = decodeURIComponent(
          pathPart.startsWith("/") ? pathPart : posix.join(posix.dirname(page), pathPart),
        );
      } catch {
        broken.push({ page, link, why: "undecodable path" });
        continue;
      }
      target = resolveFile(path);
      if (!target) {
        broken.push({ page, link, why: "no such file" });
        continue;
      }
    }
    if (fragment && target.endsWith(".html")) {
      const id = decodeURIComponent(fragment);
      if (!idsByPage.get(target)?.has(id))
        broken.push({ page, link, why: `no #${id} on ${target}` });
    }
  }
}

const count = [...linksByPage.values()].reduce((n, l) => n + l.length, 0);
if (broken.length) {
  for (const b of broken) console.log(`FAIL ${b.page}: ${b.link} (${b.why})`);
  console.error(`\n${broken.length} broken internal link(s)`);
  process.exit(1);
}
console.log(`all internal links resolve (${count} links on ${pages.length} pages)`);
