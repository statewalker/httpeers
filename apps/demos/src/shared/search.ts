/**
 * `GET /search?q=…` — the mesh's first real service, and the shape every
 * later service (image search, a real search backend) follows: a handler
 * plus its policy (`policy.ts`'s `/search` allow) plus, on a provider,
 * an advertisement — see the design record §5.2, "Search is a mount, not a
 * process."
 *
 * THE SEAM. `SearchUpstream` is the entire contract between this handler
 * and wherever results actually come from. `fixtureUpstream` below is the
 * only implementation this task ships — no network egress, deterministic,
 * safe to run in a test with no external dependency — but the handler
 * itself (`createSearchEndpoint`) never learns that: swapping in a real
 * backend later is a change to what gets passed as `upstream`, not to
 * `createSearchEndpoint` or to `policy.ts`'s `/search` allow.
 *
 * RESULTS GO IN THE BODY, NEVER IN A HEADER. HTTP header values are latin1
 * by specification (RFC 7230 §3.2, and enforced in practice by the Fetch
 * `Headers` implementation every runtime here uses) — a title or snippet
 * containing anything outside that range (an emoji, a curly quote, café's
 * `é`) throws or is mangled before the request ever reaches the wire. This
 * has bitten this project before; the fixture set deliberately carries a
 * couple of such characters (see `search-fixtures.json`) so a regression
 * that tried to hoist a result into a header would fail loudly, not
 * silently pass on ASCII-only fixtures.
 *
 * QUERY STRINGS WORK ON THIS TRANSPORT. An earlier finding that `url.search`
 * was dropped in flight was a defect in a library this stack no longer
 * depends on (`hub/endpoints.ts`'s own module comment explains why its
 * *conditional-read* endpoints use `ETag`/`If-None-Match` instead of
 * `?since=` regardless — that is a design preference, not a workaround for
 * a transport limitation). `GET /search` reads `q` from the ordinary
 * request URL with no fallback and no guard.
 *
 * THIS MODULE MUST STAY FREE OF `node:` IMPORTS, and that is a hard
 * constraint, not a style preference. `../hub/endpoints.ts` imports it as a
 * VALUE (`createSearchEndpoint`, `fixtureUpstream`, `SEARCH_ADVERTISEMENT`
 * — deliberately kept together, see `SEARCH_ADVERTISEMENT` below), so
 * everything reachable from here lands in any bundle that contains the
 * hub's HTTP surface. Since Task 24 that includes a BROWSER bundle: the hub
 * page (`../pages/hub/`) runs the very same `createHubEndpoints` in a tab.
 * Until then this file read `search-fixtures.json` with
 * `readFileSync(fileURLToPath(new URL(...)))` AT MODULE SCOPE, which is not
 * a warning in a browser build but a hard failure at the first line of the
 * bundle — before any page code runs, with nothing on screen to say why.
 * The import below is the fix: `resolveJsonModule` (this app's
 * `tsconfig.json`) types it, Node 24 loads it natively under the required
 * `with { type: "json" }` attribute, and Vite/rolldown inlines it into the
 * browser bundle. The fixtures are unchanged, and so is every behaviour
 * built on them.
 */
import type { FetchHandler } from "@statewalker/httpeers-core";
import { json } from "@statewalker/httpeers-core";
import { Hono } from "hono";
import FIXTURES_JSON from "./search-fixtures.json" with { type: "json" };

export interface SearchResult {
  id: string;
  title: string;
  snippet: string;
  url: string;
}

export type SearchUpstream = (query: string) => Promise<SearchResult[]>;

const FIXTURES: SearchResult[] = FIXTURES_JSON;

/**
 * Case-insensitive substring match over `title` and `snippet`. Deterministic
 * (no ranking, no randomness) and dependency-free — exactly enough to prove
 * the seam end to end, not a search engine.
 */
export const fixtureUpstream: SearchUpstream = async (query) => {
  const needle = query.toLowerCase();
  return FIXTURES.filter(
    (r) => r.title.toLowerCase().includes(needle) || r.snippet.toLowerCase().includes(needle),
  );
};

/**
 * The hub's own advertisement for this service — the THIRD of the three
 * pieces the design record §5.2 says search is made of ("a handler plus its
 * policy plus its advertisement, so relocating it to a standalone
 * peer later is a change of wiring, not of code"). Task 8 built the first
 * two and left this one unwritten, which made search undiscoverable: nothing
 * in this app ever posted it, the hub does not heartbeat itself, and
 * `/.well-known/mesh` builds its `advertisements` list purely from what
 * peers posted on their own heartbeats — so a consumer filtering the view by
 * `kind` found the image peer and nothing else. `hub/endpoints.ts` posts this
 * into its own advertisement store at construction time; see that file.
 *
 * `kind` IS THE DISCOVERY KEY, and it is what a consumer filters on — never
 * a peer id. Keeping the literal here, next to the handler and beside
 * `policy.ts`'s `/search` allow, is what makes "relocate search
 * to its own peer" a wiring change: the new peer posts this same
 * advertisement on its own heartbeat and every consumer keeps working
 * unchanged.
 */
export const SEARCH_ADVERTISEMENT = {
  id: "search",
  kind: "search",
  title: "Search",
} as const;

export interface SearchEndpointInit {
  upstream: SearchUpstream;
}

/** `GET /search?q=…`. A missing or empty `q` is a 400 with a reason; capability gating is `policy.ts`'s job, not this handler's. */
export function createSearchEndpoint(init: SearchEndpointInit): FetchHandler {
  const app = new Hono();

  app.get("/search", async (c) => {
    const q = c.req.query("q");
    if (q == null || q.trim() === "") {
      return json({ error: "q is required and must not be empty" }, 400);
    }
    const results = await init.upstream(q);
    return json({ results });
  });

  return app.fetch as FetchHandler;
}
