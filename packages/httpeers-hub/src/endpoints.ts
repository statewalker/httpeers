/**
 * The hub's `.well-known` surface: registries, invitations, presence and the
 * mesh view. The hub is an ordinary peer (note 03) — nothing here imports
 * libp2p; it is handed a `mintToken` capability already scoped to this
 * peer's own signing key (see `createPeer`'s `mounts` factory in
 * `@statewalker/httpeers-core`), never the key itself.
 *
 * Built on Hono. `app.fetch` is already `(Request) => Promise<Response>`, so
 * it drops straight into the `FetchHandler` contract with no adapter — and
 * `c.req.raw` is the very `Request` the transport (or, in a test, the
 * caller) registered a peer binding on, which is what makes `lookupPeer`
 * and `lookupClaims` work at all from inside a handler.
 *
 * NO QUERY PARAMETERS. Conditional reads use `ETag` / `If-None-Match`, not
 * `?since=`: some transports drop `url.search` before the wire, and ETag is
 * better HTTP regardless.
 */

import type { Advertisement, AdvertisementStore, FetchHandler, MemberStore, Mounts, PeerIdStr, PresenceStore, UsesTransportIdentity } from "@statewalker/httpeers-core";
import type { RuleSet } from "@statewalker/httpeers-access";
import type { RevocationRegistry } from "@statewalker/httpeers-access/issuer";
import { ANONYMOUS, createMounts, json, lookupClaims, lookupPeer } from "@statewalker/httpeers-core";
import { capabilityNames, deriveCapabilities } from "@statewalker/httpeers-access";
import { createAdvertisementStore, createPresenceStore } from "./registries.js";
import { Hono } from "hono";
import { createAdminEndpoints } from "./admin.js";
// `./hub-state.js`, not `./persist.js`: the latter is the NODE facade (it
// imports `node:fs`), and this module is bundled into the browser hub page
// (`../pages/hub/`) as well as into the Node hub. The import is type-only
// and therefore erased either way, but pointing it at the portable half is
// what stops a future value import here from quietly breaking that page.
import type { InvitationStore } from "./hub-state.js";
import type { AdvertisementPayload, MeshView } from "./mesh-view.js";
import { buildMeshView } from "./mesh-view.js";

/** The capability that grants admin visibility — sees `hidden` members and gates `/admin/*` (Task 8's `DELETE /admin/members/{peerId}` included). */
export const ADMIN_CAPABILITY = "std:mesh.admin";

/** Presence TTL: an entry not refreshed within this window is swept. */
export const DEFAULT_PRESENCE_TTL_MS = 15_000;

/** Exactly two handlers, method-aware: a presence WRITE is bootstrap, a read is not. */
export function usesTransportIdentity(): UsesTransportIdentity {
  return async (req: Request) => {
    if (req.method !== "POST") return false;
    const { pathname } = new URL(req.url);
    return pathname === "/.well-known/invite" || pathname === "/.well-known/presence";
  };
}

/**
 * The diagnostic `/test` surface: `/test/whoami` and `/test/echo`, per the
 * archived `12-httpeers-prototype-validated/src/endpoints.ts` (lines 128
 * and 138). NOT hub-specific — every peer in that archive served this
 * unconditionally, hub or not, and Task 7b's promoted E2E suites need the
 * same: their "provider" peer (an ordinary member, never a hub) must answer
 * `/test/whoami` with this rich shape too.
 *
 * This is deliberately NOT `httpeers.core`'s own default diagnostic mount
 * (`peer.ts`'s `defaultMounts`, also `/test/whoami`) — that one answers
 * `{ peer, sub }` from the transport/binding alone and knows nothing about
 * a minted token's `roles`/`mesh`. The archived suites assert `body.you`,
 * `body.roles`, `body.mesh` — fields the core's default does not have and
 * is not meant to grow, since the core must stay hub-agnostic. Any peer
 * that wants this richer surface mounts this handler explicitly, the same
 * way `createHubEndpoints` below does for the hub itself.
 */
export function createTestSurfaceHandler(selfPeerId: PeerIdStr): FetchHandler {
  const app = new Hono();

  app.get("/test/whoami", (c) => {
    const claims = lookupClaims(c.req.raw) ?? null;
    return json({
      servedBy: selfPeerId,
      you: claims?.sub ?? null,
      roles: claims?.roles ?? [],
      mesh: claims?.mesh ?? null,
    });
  });

  app.post("/test/echo", async (c) => json({ method: c.req.method, body: await c.req.text() }));

  return app.fetch as FetchHandler;
}

export interface HubEndpointsInit {
  selfPeerId: PeerIdStr;
  /**
   * Mint a membership token that self-certifies as this mesh. Structurally
   * `MountsFactoryContext["mintToken"]` from `httpeers.core`, restated here
   * rather than imported so this file stays a plain description of what the
   * hub needs -- including the audience option ADR-0020 added, which nothing
   * in this file passes yet: the invitation and presence protocols mint
   * unrestricted tokens, and narrowing them is a protocol change, not a
   * signature change.
   */
  mintToken: (
    sub: string,
    roles: string[],
    options?: { ttlMs?: number; audience?: readonly PeerIdStr[] },
  ) => Promise<string>;
  memberStore: MemberStore;
  invitations: InvitationStore;
  /** This mesh's Datalog rules and policies (ADR-0019) — published read-only, and the source of the caller's capabilities in the mesh view. */
  rules: RuleSet;
  revocations: RevocationRegistry;
  /** `kind` -> capability required to see advertisements of that kind. Defaults to `{}` (no kind gated). */
  advertisementAccess?: Record<string, string>;
  presenceTtlMs?: number;
  now?: () => number;
  /**
   * Application mounts served alongside the hub's own `.well-known` surface
   * and `/admin`, behind the same access checks.
   *
   * The prototype hard-mounted a demo `/search` endpoint here, which made the
   * library import the application. A hub is membership and the bulletin
   * board; what else a particular deployment serves is not its business.
   */
  extraMounts?: Record<string, FetchHandler>;
  /**
   * What this hub advertises about ITSELF on the bulletin board.
   *
   * Posted once at construction, because the hub is the one peer that never
   * sends a heartbeat — and a heartbeat's `advertisements` array is otherwise
   * the only way anything reaches that store. The prototype learned this the
   * hard way: its `/search` mount was served and gated but INVISIBLE, so a
   * consumer filtering `/.well-known/mesh` by `kind` found the image peer and
   * nothing else.
   *
   * A hub that serves a route while withholding its advertisement is a
   * half-wired state, so a deployment passing `extraMounts` almost always
   * wants a matching entry here. These never need withdrawing: `sweep`
   * withdraws only for peers whose PRESENCE expired, and a hub has no presence
   * record of its own.
   */
  ownAdvertisements?: Array<{ id: string; kind: string; title: string }>;
}

export interface HubEndpoints {
  mounts: Mounts;
  /** Expire stale presence and the advertisements that rode along with it; bumps the mesh version only if something actually left. Call on a timer (production) or directly with a controlled clock (tests). */
  sweep: () => void;
  /**
   * The very view `GET /.well-known/mesh` serves, read in-process.
   *
   * FOR A UI THAT IS ALREADY INSIDE THE HUB, and for nothing else. The
   * browser hub page (`../pages/hub/`) renders the member list from this;
   * going through the HTTP endpoint for it would mean the hub minting
   * itself a token and dispatching a request to itself, purely so it could
   * read three registries it is holding two references away. The HTTP
   * endpoint remains the ONLY way any other peer sees this — this accessor
   * adds no route, no capability, and no way in from the network.
   *
   * IT IS `buildMeshView`, NOT A SECOND OPINION. "Saved" (a member record,
   * from the persisted snapshot) and "active" (`online`, from the TTL'd
   * presence store) are two different facts, and `mesh-view.ts` already
   * computes the second per member. A UI that re-derived `online` by
   * joining a member list against a presence list would be inventing a
   * parallel notion that could disagree with the one every remote peer
   * reads — the exact kind of divergence that turns into a debugging trap.
   *
   * THE HUB'S OWN VIEW SEES EVERYTHING: every capability the rules can
   * derive is passed as the caller's, so `hidden` members and every gated
   * advertisement are included. There is nobody to hide from — this is the
   * machine that holds the list, and an operator shown a filtered version
   * of their own mesh would be misled about what they are administering.
   *
   * Live, not a snapshot: a swept peer is `online: false` on the next call,
   * and a removed member is gone from it, which is what a polling UI wants.
   */
  meshView: () => MeshView;
}

interface PresenceBody {
  seq: number;
  addrs: string[];
  advertisements?: Array<{ id: string; kind: string; title: string }>;
}

function sameAddrs(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (a == null) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function sameAdvertisements(
  prev: Advertisement[],
  next: ReadonlyArray<{ id: string; kind: string; title: string }>,
): boolean {
  if (prev.length !== next.length) return false;
  const prevById = new Map(prev.map((a) => [a.key, a.payload as AdvertisementPayload]));
  return next.every((ad) => {
    const p = prevById.get(ad.id);
    return p != null && p.kind === ad.kind && p.title === ad.title;
  });
}

export function createHubEndpoints(init: HubEndpointsInit): HubEndpoints {
  const now = init.now ?? Date.now;
  const presenceTtlMs = init.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS;
  const advertisementAccess = init.advertisementAccess ?? {};

  const presenceStore: PresenceStore = createPresenceStore(now);
  const advertisementStore: AdvertisementStore = createAdvertisementStore(now);
  const addrsByPeer = new Map<PeerIdStr, string[]>();

  // Whatever this deployment says about itself, posted once — see
  // `ownAdvertisements` for why this is the only path onto the board for a
  // peer that never heartbeats.
  for (const ad of init.ownAdvertisements ?? []) {
    advertisementStore.post(init.selfPeerId, ad.id, {
      kind: ad.kind,
      title: ad.title,
    } satisfies AdvertisementPayload);
  }

  // Tracks the highest `seq` EVER accepted for a peer, independent of
  // `presenceStore` — which the TTL sweep clears. Without this, a delayed
  // duplicate of an old heartbeat arriving AFTER the peer has already been
  // swept would look like a brand-new write (no record exists to compare
  // against) and resurrect a peer that has genuinely departed. This map is
  // never cleared by sweep, only ever advanced.
  const lastSeqByPeer = new Map<PeerIdStr, number>();

  // The one counter this whole module exists to bump correctly: it moves
  // only when the OBSERVABLE mesh view could have changed (a member added,
  // a peer's online/addrs state changed, an advertisement changed, or the
  // sweep removed someone) — never on a heartbeat that repeats what the hub
  // already knew, which is what keeps `/.well-known/mesh`'s ETag stable
  // between identical heartbeats instead of churning every 5 s.
  let meshVersion = 1;
  const bumpMesh = (): void => {
    meshVersion++;
  };

  const claimsOf = (req: Request) => lookupClaims(req) ?? null;
  const provenPeer = (req: Request): PeerIdStr => {
    const peer = lookupPeer(req);
    if (peer === undefined || peer === ANONYMOUS) {
      throw new Error("hub bootstrap handler reached without a transport-proven peer");
    }
    return peer;
  };

  const withdrawAllFor = (peerId: PeerIdStr): void => {
    for (const ad of advertisementStore.list(peerId)) advertisementStore.withdraw(peerId, ad.key);
  };

  const app = new Hono();

  // --- BOOTSTRAP: no token exists yet ---------------------------------------

  app.post("/.well-known/invite", async (c) => {
    const peerId = provenPeer(c.req.raw);
    const { id } = await c.req.json<{ id: string }>();

    const redemption = init.invitations.redeem(id);
    if (!redemption.ok) {
      return json({ error: `invitation ${redemption.reason}` }, 403);
    }

    init.memberStore.add(peerId, redemption.roles);
    bumpMesh();

    return json({
      token: await init.mintToken(peerId, redemption.roles),
      mesh: init.selfPeerId,
      roles: redemption.roles,
    });
  });

  // --- BOOTSTRAP: mints the token, so cannot itself require one -------------

  app.post("/.well-known/presence", async (c) => {
    const peerId = provenPeer(c.req.raw);
    const member = init.memberStore.get(peerId);
    if (member == null) return json({ error: "not a member" }, 403);

    const body = await c.req.json<PresenceBody>();

    const lastSeq = lastSeqByPeer.get(peerId);
    if (lastSeq !== undefined && body.seq <= lastSeq) {
      return json({ error: "stale-sequence" }, 409);
    }
    lastSeqByPeer.set(peerId, body.seq);

    const wasPresent = presenceStore.isPresent(peerId);
    const prevAddrs = addrsByPeer.get(peerId);
    // Result intentionally ignored: `lastSeqByPeer` above already decided
    // whether this write is stale, using a guard that survives the TTL
    // sweep clearing `presenceStore`'s own record (see that map's doc
    // comment) — so `presenceStore`'s own monotonic check can only agree.
    presenceStore.heartbeat(peerId, body.seq, presenceTtlMs);
    addrsByPeer.set(peerId, body.addrs);

    let changed = !wasPresent || !sameAddrs(prevAddrs, body.addrs);

    if (body.advertisements !== undefined) {
      const prevAds = advertisementStore.list(peerId);
      if (!sameAdvertisements(prevAds, body.advertisements)) {
        withdrawAllFor(peerId);
        for (const ad of body.advertisements) {
          const payload: AdvertisementPayload = { kind: ad.kind, title: ad.title };
          advertisementStore.post(peerId, ad.id, payload);
        }
        changed = true;
      }
    }

    if (changed) bumpMesh();

    return json({
      token: await init.mintToken(peerId, member.roles),
      versions: {
        mesh: meshVersion,
        policy: init.revocations.policyVersion(),
        rules: init.rules.version,
      },
      // `ttl` is unchanged context from the archive (`CHANGES-v0.8.0.txt`'s
      // heartbeat shape `{ token, versions, meshVersion, ttl }`), not part
      // of that delta -- unlike `meshVersion`, which WAS superseded by
      // `versions.mesh` and correctly dropped (Ruling R31). It lets a
      // client take its heartbeat interval from the server rather than
      // hardcoding it.
      ttl: presenceTtlMs,
    });
  });

  // --- ORDINARY: identity comes from the verified token ----------------------

  app.get("/.well-known/members", (_c) => json({ members: init.memberStore.list() }));

  app.get("/.well-known/presence", (_c) =>
    json({
      presence: presenceStore.list().map((p) => ({ ...p, addrs: addrsByPeer.get(p.peerId) ?? [] })),
    }),
  );

  app.get("/.well-known/advertisements", (_c) =>
    json({
      advertisements: advertisementStore.list().map((ad) => {
        const payload = ad.payload as AdvertisementPayload;
        return { peerId: ad.peerId, id: ad.key, kind: payload.kind, title: payload.title };
      }),
    }),
  );

  // ONE expression, two readers: this endpoint and `HubEndpoints.meshView`
  // below. They must not drift -- an in-process UI showing a different
  // membership or a different `online` from the one every remote peer reads
  // would be a debugging trap rather than a diagnostic.
  const viewFor = (self: PeerIdStr, callerCapabilities: ReadonlySet<string>): MeshView =>
    buildMeshView({
      version: meshVersion,
      self,
      members: init.memberStore.list(),
      presence: presenceStore.list(),
      addrsByPeer,
      advertisements: advertisementStore.list(),
      callerCapabilities,
      advertisementAccess,
      adminCapability: ADMIN_CAPABILITY,
    });

  app.get("/.well-known/mesh", (c) => {
    const claims = claimsOf(c.req.raw);
    if (claims == null) return json({ error: "unauthenticated" }, 401);

    const etag = `"v${meshVersion}"`;
    if (c.req.header("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    const view = viewFor(claims.sub, deriveCapabilities(init.rules, claims.roles));

    return new Response(JSON.stringify(view), {
      headers: { "content-type": "application/json", etag },
    });
  });

  // ADR-0016's amendment: the rules are published, still read-only in the
  // strict sense -- what this returns influences no decision, here or on any
  // other peer, which is why no signing scheme is needed for it. It is served
  // for discovery, debugging and the explainability of a denial.
  app.get("/.well-known/rules", (c) => {
    const etag = `"rules${init.rules.version}"`;
    if (c.req.header("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(JSON.stringify(init.rules), {
      headers: { "content-type": "application/json", etag },
    });
  });

  app.get("/.well-known/revocations", (c) => {
    const version = init.revocations.policyVersion();
    const etag = `"policy${version}"`;
    if (c.req.header("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(JSON.stringify({ version, entries: init.revocations.list() }), {
      headers: { "content-type": "application/json", etag },
    });
  });

  // --- admin-only, to exercise the policy middleware -----------------------
  // Archive: `12/src/endpoints.ts` line 122. Listing only — invitations are
  // created programmatically (`InvitationStore.create`, `persist.ts`), never
  // over HTTP; see this app's `PROVENANCE.md`.

  app.get("/admin/invitations", (c) =>
    json({ ok: true, issuedBy: init.selfPeerId, caller: claimsOf(c.req.raw)?.sub }),
  );

  app.all("*", (c) => json({ error: "not found", path: new URL(c.req.raw.url).pathname }, 404));

  const mounts = createMounts();
  mounts.provide("/.well-known", app.fetch as FetchHandler);
  mounts.provide("/test", createTestSurfaceHandler(init.selfPeerId));
  mounts.provide("/admin", app.fetch as FetchHandler);
  // Longer prefix wins (R-1): "/admin/members" is more specific than the
  // "/admin" mount above, so DELETE /admin/members/{peerId} reaches
  // admin.ts's handler while GET /admin/invitations keeps hitting `app`.
  mounts.provide(
    "/admin/members",
    createAdminEndpoints({ memberStore: init.memberStore, revocations: init.revocations }),
  );
  // Revocation for `/search` (and every other route on this hub) is NOT
  // handled here. Policy (`policy.ts`) only ever checks the CAPABILITY a
  // token's roles expand to, which cannot see a membership change made
  // after the token was minted -- but the fix for that is a single seam on
  // this peer's own `createPeer` (`hub/main.ts`'s `revocationCache:
  // revocations`, using `RevocationRegistry`'s own `check`, added in
  // `httpeers.core` alongside this task -- see that package's
  // `revocation.ts`), applied uniformly to EVERY mount by the binding
  // middleware before any handler runs. An earlier version of this file put
  // a bespoke membership check on this one mount instead; that covered only
  // the route being built and silently left every other hub endpoint
  // (including `/admin/*`) still honouring a revoked token until it
  // expired -- removed on review. See `hub/main.ts` and this app's
  // `PROVENANCE.md`.
  for (const [prefix, handler] of Object.entries(init.extraMounts ?? {})) {
    mounts.provide(prefix, handler);
  }

  return {
    mounts,
    // Every capability the rules can derive, so the hub's own view is
    // unfiltered -- see this field's doc comment on `HubEndpoints`.
    meshView: () => viewFor(init.selfPeerId, new Set(capabilityNames(init.rules))),
    sweep() {
      const expired = presenceStore.sweep();
      if (expired.length === 0) return;
      for (const peerId of expired) {
        addrsByPeer.delete(peerId);
        withdrawAllFor(peerId);
      }
      bumpMesh();
    },
  };
}
