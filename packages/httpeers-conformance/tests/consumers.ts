/**
 * Every prototype, rebuilt against the published API — and `tsc` is the judge.
 *
 * This is rung 07's technique, widened to the whole ladder. An API is
 * sufficient when the things that already exist can be built on it, and the
 * only way to know is to write them and compile. Prose cannot tell you, and a
 * review will agree with whatever the reviewer already believes.
 *
 * Each block below is one rung's CORE SHAPE — not its tests, not its fixtures,
 * but the calls it makes and the types it needs. A missing export, a narrowed
 * parameter or a type that moved shows up here as a compile error, which is
 * the only kind of answer worth having.
 *
 * This file is never executed. It is compiled.
 */

import type { FetchHandler, MeshView, Mounts, PeerIdStr } from "@statewalker/httpeers-core";
import {
  ANONYMOUS,
  createMounts,
  forwardLocalOnly,
  createPeerRouter,
  json,
  lookupPeer,
  registerPeer,
} from "@statewalker/httpeers-core";

// ---------------------------------------------------------------------------
// Rung 02 / 11 / 12 / 14 — a site that verifies a Biscuit with no libp2p
// ---------------------------------------------------------------------------

import {
  access,
  createRevocations,
  guardStream,
  type RuleSet,
  roleNames,
  ruleSet,
  selfCertifyingKeys,
  verifyToken,
  withAccess,
} from "@statewalker/httpeers-access";
import { generateSigner, mintToken } from "@statewalker/httpeers-access/issuer";
import { initBiscuit } from "@statewalker/httpeers-access/engine";

export async function rung11_siteOverAnyTransport(issuer: string, selfPeer: string) {
  const rules: RuleSet = ruleSet({
    version: 1,
    rules: ['capability("app:read") <- role("member");'],
    policies: ['allow if capability("app:read"), resource("/hello");'],
  });

  const mounts = createMounts();
  mounts.provide("/hello", async () => new Response("hello from the mesh"));
  mounts.provide("/secret", async (request) => json({ sub: access(request)?.claims?.sub }));

  const guarded = withAccess({
    issuer,
    rules,
    selfPeer,
    keys: selfCertifyingKeys(),
    provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
  })(createPeerRouter({ selfPeerId: selfPeer, mounts, remote: async () => new Response(null, { status: 403 }) }));

  return guarded;
}

export async function rung12_mintAndVerify() {
  const signer = await generateSigner();
  const token = await mintToken({ signer, sub: "12D3KooWSub", roles: ["member"], ttlMs: 60_000 });
  return verifyToken(token, { issuer: signer.mesh, connectionPeer: "12D3KooWSub" });
}

/** Rung 02: the worker-side loader seam is reachable and takes the caller's binding module. */
export const rung02_engine = initBiscuit;

// ---------------------------------------------------------------------------
// Rung 03 — QR on pure pixels
// ---------------------------------------------------------------------------

import { decodeQr, type Pixels, qrModules, qrSvg } from "@statewalker/httpeers-qr";
import { scanFile, scanFromCamera } from "@statewalker/httpeers-qr/browser";

export function rung03_qrRoundTrip(text: string, pixels: Pixels) {
  return { svg: qrSvg(text), size: qrModules(text).length, decoded: decodeQr(pixels) };
}

/**
 * The prototype's ACTUAL join flow: a live camera, and a file picker for the
 * cases it cannot serve.
 *
 * The two halves meet here and nowhere in either package — `httpeers-qr`
 * scans and does not know what an invitation is, `httpeers-member` knows and
 * does not scan. `accept` is the seam, and this is the compile-time proof
 * that the seam actually fits.
 */
export async function rung03_scanToJoin(host: { id: string }, session: PeerSession) {
  const camera = await scanFromCamera(host, {
    accept: invitationFromQrText,
    onCode: (code) => void session.join(code),
  });
  const fromPicture = async (file: Blob) => {
    const scan = await scanFile(file, { accept: invitationFromQrText });
    // A QR that is not an invitation is a DISTINCT outcome from no QR at all:
    // one means "you scanned the wrong thing", the other "try a better view".
    if (scan.ok) await session.join(scan.value);
    else if (scan.reason === "not-accepted") console.warn("not an invitation:", scan.text);
  };
  return { camera, fromPicture };
}

// ---------------------------------------------------------------------------
// Rung 04 / 12 — the hub, its registries, and a restart
// ---------------------------------------------------------------------------

import { createHub, type Hub, memoryStorage } from "@statewalker/httpeers-hub";

export async function rung12_hub(selfPeerId: PeerIdStr, rules: RuleSet): Promise<Hub> {
  const hub = await createHub({
    selfPeerId,
    policies: rules,
    storage: memoryStorage(),
    mintToken: async (sub, roles) => `${sub}:${roles.join("+")}`,
    // Rung 12's operator methods, in-process.
    extraMounts: { "/app": async () => new Response("app") },
    ownAdvertisements: [{ id: "app", kind: "demo", title: "The app" }],
  });
  const invite = await hub.invitations.create(["member"], 60_000);
  hub.invitations.status(invite.id);
  await hub.invitations.redeem(invite.id);
  hub.members.setRoles(selfPeerId, ["member"]);
  hub.sweep();
  const view: MeshView = hub.meshView();
  void view;
  return hub;
}

// ---------------------------------------------------------------------------
// Rung 05 — the reverse proxy and exposing a local app, as one mechanism
// ---------------------------------------------------------------------------

import {
  assertNoSecrets,
  type Route,
  routeTable,
  type StoredRoute,
  urlUpstream,
} from "@statewalker/webrun-http-proxy";
import { fileRouteStore } from "@statewalker/webrun-http-proxy/node";
import { localStorageRouteStore } from "@statewalker/webrun-http-proxy/browser";
import { PEER_ID_HEADER } from "@statewalker/httpeers-core";

export function rung05_expose(local: FetchHandler): FetchHandler {
  const routes: Route[] = [
    {
      prefix: "/openai",
      describe: "OpenAI",
      upstream: urlUpstream({
        base: "https://api.openai.com/v1",
        // THE ONE THING THE PROXY USED TO KNOW ABOUT MESHES, now passed in:
        // a third-party origin has no business learning which peer called.
        stripRequestHeaders: [PEER_ID_HEADER],
      }),
    },
    { prefix: "/local", describe: "in-process", upstream: local },
  ];
  // A THUNK, because the proxy page edits routes while traffic flows.
  return routeTable({ routes: () => routes });
}

export const rung05_stores = { fileRouteStore, localStorageRouteStore, assertNoSecrets };
export type Rung05Stored = StoredRoute;

// ---------------------------------------------------------------------------
// Rung 06 / 16 — the ghost: a pin, and containment
// ---------------------------------------------------------------------------

import { contain, pinnedPeer } from "@statewalker/httpeers-ghost";

export function rung06_ghost(remote: (peerId: PeerIdStr, request: Request) => Promise<Response>) {
  const pinned = pinnedPeer({
    landing: { peerId: "12D3KooWPinned", appPath: "/app" },
    basePath: "/ghost/",
    token: () => "VIEWER-TOKEN",
    remote,
  });
  return contain(pinned, { baseUrl: "http://viewer.example/ghost/", mode: "csp" });
}

// ---------------------------------------------------------------------------
// Rung 01 / 08 — a member, and the mesh as ordinary HTTP
// ---------------------------------------------------------------------------

import type { MemberHandle, MemberPlatform } from "@statewalker/httpeers-member";
import {
  createGateway,
  encodeJoinBlob,
  invitationFromQrText,
  readJoinInputFromText,
  startMember,
} from "@statewalker/httpeers-member";
import { nodePlatform } from "@statewalker/httpeers-member/node";

export async function rung01_member(
  key: Parameters<typeof startMember>[0]["key"],
  mounts: Mounts,
  rules: RuleSet,
): Promise<MemberHandle> {
  // A VALUE, not a factory — a Node member has nothing per-instance to build.
  const platform: MemberPlatform = nodePlatform;
  return startMember({
    key,
    mounts,
    rules,
    config: { relayAddrs: ["/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWRelay"], hubPeerId: "12D3KooWHub" },
    platform,
  });
}

export function rung08_gateway(member: MemberHandle): FetchHandler {
  // The member IS a `GatewaySource` — structurally, with no adapter.
  // `edgeKey` is the first path segment the underlying edge dispatch expects:
  // "" on a Node server, the SW key behind a ServiceWorker.
  return createGateway({ source: member, basePath: "", edgeKey: "peers" });
}

export const rung01_joinBlob = { encodeJoinBlob, readJoinInputFromText };

// ---------------------------------------------------------------------------
// Rung 01, the BROWSER half — the page session, and the three things a page
// does differently as one platform object
// ---------------------------------------------------------------------------

import type { PeerSession, SessionState } from "@statewalker/httpeers-member";
import { createSession } from "@statewalker/httpeers-member/browser";

/**
 * What a consumer PAGE is, in full: mounts, rules, and a render callback.
 *
 * Every seam the session takes has a browser default behind this entry — the
 * platform, the two IndexedDB stores, `location.search` and the reload — so
 * the page supplies none of them. That is the acceptance criterion for the
 * browser half: a page that is shorter than the prototype's `main.ts` was,
 * and holds no state of its own.
 */
export function rung01_page(
  mounts: Mounts,
  rules: RuleSet,
  render: (state: SessionState) => void,
): PeerSession {
  return createSession({
    key: "peers",
    mounts,
    rules,
    onChange: render,
    serviceWorkerUrl: "/sw.js",
    dev: true,
  });
}

// ---------------------------------------------------------------------------
// Rung 09 / 10 — duplex streams, and revoking one already open
// ---------------------------------------------------------------------------

import {
  createDuplexMounts,
  generateKey,
  openDuplex,
  peerIdOf,
  serveDuplex,
  servePeer,
} from "@statewalker/httpeers-libp2p";
import { nodeTransports } from "@statewalker/httpeers-libp2p/node";
import { createNode } from "@statewalker/httpeers-libp2p";

export async function rung09_duplex() {
  const node = await createNode({ privateKey: await generateKey(), transports: nodeTransports() });
  const mounts = createDuplexMounts();
  mounts.provide("/chat", async function* (input: AsyncIterable<Uint8Array>) {
    for await (const chunk of input) yield chunk;
  });
  const stop = await serveDuplex({ node, mounts });
  const duplex = await openDuplex({ node, peerId: peerIdOf(await generateKey()), path: "/chat" });
  return { stop, duplex };
}

export function rung10_revocation() {
  const revocations = createRevocations();
  // Enforced on the INPUT side, both directions — rung 10 had to move the
  // check twice before it was real.
  return { revocations, guardStream };
}

// ---------------------------------------------------------------------------
// Rung 01 — servePeer, the seam three assemblies collapse into
// ---------------------------------------------------------------------------

export async function rung01_servePeer(mounts: Mounts, guard: (next: FetchHandler) => FetchHandler) {
  const node = await createNode({ privateKey: await generateKey(), transports: nodeTransports() });
  const peer = await servePeer({ node, mounts, access: guard });
  await peer.call("12D3KooWOther", new Request("http://peer.local/hello"));
  registerPeer(new Request("http://peer.local/x"), peer.peerId);
  return peer;
}

// ---------------------------------------------------------------------------
// Rung 04 / 12, the BROWSER half — a hub in a tab
// ---------------------------------------------------------------------------

import {
  circuitAddrs,
  dialRelay,
  superviseRelay,
  waitForCircuitReservation,
} from "@statewalker/httpeers-libp2p";
import { createEdgeDispatch } from "@statewalker/httpeers-member";
import { createBrowserNode, mountEdge } from "@statewalker/httpeers-member/browser";

/**
 * `startBrowserHub`, rebuilt on the packages — the prototype's 498-line
 * `browser/hub-runtime.ts`, and the question this file exists to answer: is
 * the library sufficient, or does the hub lifecycle need a home of its own?
 *
 * THE ANSWER IS THAT IT IS APP WIRING, exactly as the NODE hub's `main.ts` is.
 * Both hubs orchestrate the same seven imported pieces; neither adds a
 * mechanism. What differs between them is a transport list and where the
 * snapshot lives, and both of those are already injected. Putting this in a
 * package would have meant a dependency edge from `httpeers-hub` to
 * `httpeers-libp2p` — the very edge that package's boundary test forbids, and
 * forbids for a reason: a hub is membership and a mount table, and keeping the
 * wire out is what lets it be tested without one AND what makes a hub in a tab
 * possible at all.
 *
 * So this compiles and is not extracted. If it ever stops compiling, THAT is
 * the signal that something is missing from the packages.
 */
export async function rung12_browserHub(
  privateKey: Parameters<typeof createBrowserNode>[0]["privateKey"],
  selfPeerId: PeerIdStr,
  rules: RuleSet,
  relayAddr: string,
) {
  // The hub relays signalling for ITS OWN MEMBERS and nobody else. The member
  // store does not exist yet -- it is built below -- so the gater reads it
  // through a thunk that answers no until then. That ordering cycle is why
  // `membershipGater` takes a thunk rather than a value.
  let isMember = (_peerId: string): boolean => false;
  const node = await createBrowserNode({
    privateKey,
    dev: true,
    isMember: (peerId) => isMember(peerId),
  });

  await dialRelay(node, relayAddr);
  const reserved = await waitForCircuitReservation(node);
  // BOTH variants come back and only one works: the bare `/p2p-circuit` is a
  // LIMITED connection on which libp2p silently refuses the protocol.
  const addrs = circuitAddrs(node);
  const supervisor = superviseRelay({ node, relayAddr });

  const signer = await generateSigner();
  const hub = await createHub({
    selfPeerId,
    policies: rules,
    storage: memoryStorage(),
    mintToken: async (sub, roles) =>
      mintToken({ signer, sub, roles, ttlMs: 5 * 60_000 }),
  });
  isMember = (peerId) => hub.isMember(peerId);

  // The hub's own mounts, behind the same access guard every peer uses.
  const guard = withAccess({
    issuer: signer.mesh,
    rules,
    selfPeer: selfPeerId,
    keys: selfCertifyingKeys(),
    provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
  });
  const peer = await servePeer({
    node,
    mounts: hub.mounts,
    access: guard,
    // The hub page reaches the mesh through its OWN edge, so its router has to
    // be willing to forward what that edge hands it. Deny-by-default is right
    // for requests off the wire and fatal for these -- see `forwardLocalOnly`.
    allowForward: forwardLocalOnly,
  });

  // A HUB PAGE IS REACHED THROUGH ITS OWN fetch() LIKE ANY OTHER PAGE — the
  // same `createEdgeDispatch` a member uses, over `peer.dispatch`, which is
  // exactly the reuse `Peer.dispatch` is exposed for.
  //
  // The hub mints a token FOR ITSELF. Its own endpoints are behind the same
  // guard as everyone else's, so a hub with no token could not read its own
  // mesh view through its own edge.
  const selfToken = await mintToken({
    signer,
    sub: peer.peerId,
    roles: ["admin"],
    ttlMs: 5 * 60_000,
  });
  const dispatch = createEdgeDispatch({
    key: "peers",
    dispatch: peer.dispatch,
    token: () => selfToken,
  });
  const edge = await mountEdge({ key: "peers", dispatch });

  return {
    peerId: peer.peerId,
    relayAddr,
    circuitAddr: addrs.webrtc ?? reserved,
    baseUrl: edge.baseUrl,
    // Every operator control the prototype's handle exposed, straight off
    // `Hub` -- no adapter, which is the actual acceptance criterion.
    invitations: hub.invitations,
    members: hub.members,
    meshView: () => hub.meshView(),
    revocations: hub.revocations,
    // Read off the RULES, never a hard-coded list: a role added to the policy
    // appears in the operator UI without anybody updating a second place.
    // Since the rules ARE the role registry, a role exists exactly when some
    // rule fires on it.
    roles: () => roleNames(hub.rules),
    async stop() {
      await edge.stop();
      supervisor.stop();
      await hub.stop();
      await node.stop();
    },
  };
}
