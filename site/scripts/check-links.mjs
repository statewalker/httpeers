// Every internal link of the built site resolves: walks dist/ for HTML pages, and for each
// href and src that stays on this site checks that the file exists in dist/ and, when the link
// names a #fragment, that the target page has an element with that id. External links are not
// fetched.
//
//   pnpm build && pnpm check:links

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;
const SITE = "https://httpeers.com"; // absolute links to the site itself count as internal

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
const pages = walk(DIST).filter((f) => f.endsWith(".html"));
if (!pages.length) {
  console.error("check-links: no HTML in dist/ (run the build first)");
  process.exit(1);
}

/** The file a site path is served from, as the sites host resolves it, or undefined. */
function resolveFile(pathname) {
  const path = decodeURIComponent(pathname);
  const file = join(DIST, path);
  if (path.endsWith("/"))
    return existsSync(join(file, "index.html")) ? join(file, "index.html") : undefined;
  if (existsSync(file) && statSync(file).isFile()) return file;
  if (existsSync(join(file, "index.html"))) return join(file, "index.html");
  if (existsSync(`${file}.html`)) return `${file}.html`;
  return undefined;
}

const ids = new Map();
function idsOf(file) {
  if (!ids.has(file)) {
    const html = readFileSync(file, "utf8");
    ids.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return ids.get(file);
}

const problems = [];
let checked = 0;
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  // The page's own URL, for resolving relative links.
  const rel = relative(DIST, page).replace(/index\.html$/, "");
  const base = new URL(`/${rel}`, SITE);
  for (const [, attr, raw] of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
    const value = raw.replaceAll("&amp;", "&");
    if (!value || /^(mailto:|tel:|data:|javascript:)/.test(value)) continue;
    let url;
    try {
      url = new URL(value, base);
    } catch {
      problems.push(`${rel || "/"}: unparseable ${attr} "${value}"`);
      continue;
    }
    if (url.origin !== new URL(SITE).origin) continue;
    checked++;
    const target = resolveFile(url.pathname);
    if (!target) {
      problems.push(`${rel || "/"}: ${attr}="${value}" → ${url.pathname} is not in dist/`);
      continue;
    }
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (fragment && target.endsWith(".html") && !idsOf(target).has(fragment)) {
      problems.push(`${rel || "/"}: ${attr}="${value}" → no id="${fragment}" on ${url.pathname}`);
    }
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} broken internal link(s) in ${pages.length} pages`);
  process.exit(1);
}
console.log(`check-links: ${checked} internal links in ${pages.length} pages, all resolve`);
