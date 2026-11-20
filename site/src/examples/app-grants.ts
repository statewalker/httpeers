// Passing a right to another peer, with an application token. Membership tokens are bound to
// their subject, so Alice cannot hand hers to Carol (the narrowing example shows that). An
// application can still let rights travel: it signs its own Biscuits with its own key, and they
// ride in Authorization, which the mesh never reads or strips. Bob's application grants Alice a
// right; Alice narrows it to "Carol may read" and hands it to Carol; Bob checks the grant against
// the caller the transport proved. The membership token still decides whether Carol may reach
// Bob at all; the application token decides what she may do there.

import { ruleSet, withAccess } from "@statewalker/httpeers-access";
import { generateSigner, mintToken } from "@statewalker/httpeers-access/issuer";
import { createRemoteOverLink, serveFetchOverLink } from "@statewalker/httpeers-bridge";
import { pairedLinks } from "@statewalker/httpeers-bridge/ports";
import {
  ANONYMOUS,
  createMounts,
  createPeerRouter,
  json,
  lookupPeer,
  setMeshToken,
} from "@statewalker/httpeers-core";
import { Biscuit, generateKeypair } from "@statewalker/webrun-biscuit";
import { expect, type Output } from "./output";

// The mesh's policy: members may read /reports. What a member may do with one report is the
// application's business, decided by its own token below.
const rules = ruleSet({
  version: 1,
  rules: ['capability("app:read") <- role("member");'],
  policies: ['allow if capability("app:read"), resource($r), $r.starts_with("/reports");'],
});

const HOUR = 3_600_000;

export async function run(out: Output) {
  const hub = await generateSigner();
  const [alice, bob, carol] = await Promise.all(
    [1, 2, 3].map(async () => (await generateSigner()).mesh),
  );

  // Bob's application signs its own tokens with its own key.
  const app = generateKeypair();

  const mounts = createMounts();
  mounts.provide("/reports", async (req) => {
    const presented = req.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!presented) return json({ error: "application token required" }, 401);
    let verified: Awaited<ReturnType<Biscuit["verifyAsync"]>>;
    try {
      verified = await Biscuit.fromBase64(presented).verifyAsync(app.publicKey);
    } catch {
      return json({ error: "not a token of this application" }, 401);
    }
    // Bob states what is true for this request; the token's blocks state what they allow. The
    // caller is the peer the transport proved, never a header.
    const caller = lookupPeer(req);
    const result = verified.authorize(
      "caller({caller}); operation({op}); resource({path}); time_ms({now});\nallow if right({path}, {op});",
      {
        params: {
          caller: typeof caller === "string" ? caller : "anonymous",
          op: req.method,
          path: new URL(req.url).pathname,
          now: Date.now(),
        },
      },
    );
    return result.kind === "ok"
      ? json({ report: "Q3" })
      : json({ error: "the application token does not allow this" }, 403);
  });
  const bobServer = createPeerRouter({
    selfPeerId: bob,
    mounts,
    access: withAccess({
      issuer: hub.mesh,
      rules,
      selfPeer: bob,
      provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
    }),
    remote: async () => new Response(null, { status: 403 }),
  });

  // One MessagePort pair per caller: the link proves who is calling.
  const stops: (() => Promise<void>)[] = [];
  const connect = async (from: string) => {
    const [mine, theirs] = pairedLinks(from, bob);
    stops.push(await serveFetchOverLink({ link: theirs, dispatch: bobServer }));
    const remote = createRemoteOverLink({ link: mine });
    return (method: string, path: string, init: { token: string; app?: string }) => {
      const headers = new Headers();
      if (init.token) setMeshToken(headers, init.token);
      if (init.app) headers.set("authorization", `Bearer ${init.app}`);
      return remote(bob, new Request(`http://peer.local${path}`, { method, headers }));
    };
  };
  const aliceToBob = await connect(alice);
  const carolToBob = await connect(carol);

  try {
    // Each member has its own membership token from the hub.
    const [aliceMember, carolMember] = await Promise.all(
      [alice, carol].map((sub) => mintToken({ signer: hub, sub, roles: ["member"], ttlMs: HOUR })),
    );
    out.log("the hub mints Alice and Carol a member token each");

    // Bob's application grants Alice read and write on one report, for one hour. The grant names
    // no holder: it must stay open for Alice to pass it on, so it is a bearer token until a block
    // binds it. That is why it gets a short life.
    const grant = Biscuit.build(
      app.secretKey,
      'right("/reports/q3", "GET");\nright("/reports/q3", "PUT");\ncheck if time_ms($t), $t < {until};',
      { params: { until: Date.now() + HOUR } },
    ).toBase64();
    out.log("Bob's application grants Alice GET and PUT on /reports/q3, for one hour");

    let res = await aliceToBob("PUT", "/reports/q3", { token: aliceMember, app: grant });
    expect(res.status === 200, "Alice's grant allows PUT");
    out.log(`Alice, her grant       → Bob PUT /reports/q3 → ${res.status}`, "ok");

    // Delegation: Alice narrows the grant to "only GET, only when the proven caller is Carol" and
    // hands it over, by any channel. She needs no key: appending a block only adds checks.
    const forCarol = Biscuit.fromBase64(grant)
      .attenuate('check if operation("GET");\ncheck if caller({carol});', { params: { carol } })
      .toBase64();
    out.log("Alice appends: only GET, only when the proven caller is Carol; gives it to Carol");

    res = await carolToBob("GET", "/reports/q3", { token: carolMember, app: forCarol });
    expect(res.status === 200, "Carol may read with the delegated grant");
    out.log(`Carol, delegated grant → Bob GET /reports/q3 → ${res.status}`, "ok");

    res = await carolToBob("PUT", "/reports/q3", { token: carolMember, app: forCarol });
    expect(res.status === 403, "the delegated grant does not allow PUT");
    out.log(
      `Carol, delegated grant → Bob PUT /reports/q3 → ${res.status} (only GET was passed on)`,
      "refused",
    );

    res = await aliceToBob("GET", "/reports/q3", { token: aliceMember, app: forCarol });
    expect(res.status === 403, "Carol's grant in Alice's hands is refused");
    out.log(
      `Alice, Carol's grant   → Bob GET /reports/q3 → ${res.status} (the caller is not Carol)`,
      "refused",
    );

    // The limit of this design: Alice's own grant carries no caller check, so whoever holds it may
    // use it. Bind every copy you hand on with a caller check, and keep the root grant short-lived.
    res = await carolToBob("PUT", "/reports/q3", { token: carolMember, app: grant });
    expect(res.status === 200, "the un-narrowed grant is a bearer token");
    out.log(
      `Carol, Alice's own grant → Bob PUT /reports/q3 → ${res.status} (no caller check: a bearer token)`,
      "ok",
    );

    // Removing the appended block is not possible: the chain is signed block by block, so a
    // changed byte breaks it.
    const i = Math.floor(forCarol.length / 2);
    const tampered =
      forCarol.slice(0, i) + (forCarol[i] === "A" ? "B" : "A") + forCarol.slice(i + 1);
    res = await carolToBob("PUT", "/reports/q3", { token: carolMember, app: tampered });
    expect(res.status === 401, "a tampered grant is refused");
    out.log(`Carol, one byte changed → Bob PUT /reports/q3 → ${res.status}`, "refused");

    // The mesh still decides who reaches Bob: without a membership token, no grant helps.
    res = await carolToBob("GET", "/reports/q3", { token: "", app: forCarol });
    expect(res.status === 401, "no membership token, no access");
    out.log(
      `Carol, no member token → Bob GET /reports/q3 → ${res.status} (the mesh refuses first)`,
      "refused",
    );
  } finally {
    await Promise.all(stops.map((stop) => stop()));
  }
}
