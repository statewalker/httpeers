// Narrowing a right, and passing one on. Part 1: Alice attenuates her own membership token (only
// Bob, only for five minutes) by appending a Biscuit block, with no call to the hub; Bob and Dave
// verify it themselves. Part 2: membership tokens are bound to their subject, so a right is handed
// to another peer with an application token instead. Bob's app issues one to Alice, Alice narrows
// it to "Carol may read" and gives it to Carol, and Bob checks it against the caller the transport
// proved.

import { ruleSet, withAccess } from "@statewalker/httpeers-access";
import { generateSigner, mintToken } from "@statewalker/httpeers-access/issuer";
import { createRemoteOverLink, serveFetchOverLink } from "@statewalker/httpeers-bridge";
import { pairedLinks } from "@statewalker/httpeers-bridge/ports";
import {
  ANONYMOUS,
  createMounts,
  createPeerRouter,
  type FetchHandler,
  json,
  lookupPeer,
  setMeshToken,
} from "@statewalker/httpeers-core";
import { Biscuit, generateKeypair } from "@statewalker/webrun-biscuit";
import { expect, type Output } from "./output";

const rules = ruleSet({
  version: 1,
  rules: [
    'capability("app:read")  <- role("member");',
    'capability("app:write") <- role("admin");',
  ],
  policies: [
    'allow if capability("app:read"), resource($r), $r.starts_with("/data");',
    'allow if capability("app:read"), resource($r), $r.starts_with("/reports");',
    'allow if capability("app:write"), resource($r), $r.starts_with("/admin");',
  ],
});

const MINUTE = 60_000;

export async function run(out: Output) {
  // One clock for every peer, so the example can move time forward.
  let clock = Date.now();
  const now = () => clock;

  const hub = await generateSigner();
  const [alice, bob, dave, carol] = await Promise.all(
    [1, 2, 3, 4].map(async () => (await generateSigner()).mesh),
  );
  const name = new Map([
    [alice, "Alice"],
    [bob, "Bob"],
    [dave, "Dave"],
    [carol, "Carol"],
  ]);

  // Bob's application signs its own tokens with its own key: they travel in Authorization, which
  // the mesh never reads or strips.
  const app = generateKeypair();

  // A provider: /data and /admin behind withAccess, as in the tokens example. Bob also serves
  // /reports, which additionally checks an application token.
  const provider = (self: string): FetchHandler => {
    const mounts = createMounts();
    mounts.provide("/data", async () => json({ from: name.get(self) }));
    mounts.provide("/admin", async () => json({ written: true }));
    mounts.provide("/reports", async (req) => {
      const presented = req.headers.get("authorization")?.replace(/^Bearer /, "");
      if (!presented) return json({ error: "application token required" }, 401);
      let verified: Awaited<ReturnType<Biscuit["verifyAsync"]>>;
      try {
        verified = await Biscuit.fromBase64(presented).verifyAsync(app.publicKey);
      } catch {
        return json({ error: "not a token of this application" }, 401);
      }
      const caller = lookupPeer(req);
      // The node states what is true now; the token's blocks state what they allow.
      const result = verified.authorize(
        "caller({caller}); operation({op}); resource({path}); time_ms({now});\n" +
          "allow if right({path}, {op});",
        {
          params: {
            caller: typeof caller === "string" ? caller : "anonymous",
            op: req.method,
            path: new URL(req.url).pathname,
            now: clock,
          },
        },
      );
      return result.kind === "ok"
        ? json({ report: "Q3", by: name.get(self) })
        : json({ error: "the application token does not allow this" }, 403);
    });
    return createPeerRouter({
      selfPeerId: self,
      mounts,
      access: withAccess({
        issuer: hub.mesh,
        rules,
        selfPeer: self,
        now,
        provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
      }),
      remote: async () => new Response(null, { status: 403 }),
    });
  };
  const servers = new Map([
    [bob, provider(bob)],
    [dave, provider(dave)],
  ]);

  // One MessagePort pair per caller and server: the link proves who is calling.
  const stops: (() => Promise<void>)[] = [];
  const connect = async (from: string, to: string) => {
    const [mine, theirs] = pairedLinks(from, to);
    const dispatch = servers.get(to);
    if (!dispatch) throw new Error("no such server");
    stops.push(await serveFetchOverLink({ link: theirs, dispatch }));
    const remote = createRemoteOverLink({ link: mine });
    return (method: string, path: string, init: { token?: string; app?: string } = {}) => {
      const headers = new Headers();
      if (init.token) setMeshToken(headers, init.token);
      if (init.app) headers.set("authorization", `Bearer ${init.app}`);
      return remote(to, new Request(`http://peer.local${path}`, { method, headers }));
    };
  };
  const aliceToBob = await connect(alice, bob);
  const aliceToDave = await connect(alice, dave);
  const carolToBob = await connect(carol, bob);

  try {
    out.log("— Part 1: Alice narrows her own membership token");
    const token = await mintToken({
      signer: hub,
      sub: alice,
      roles: ["member"],
      ttlMs: 60 * MINUTE,
      now,
    });
    out.log("hub mints Alice a member token: every peer of the mesh, for one hour");

    let res = await aliceToBob("GET", "/data", { token });
    expect(res.status === 200, "the full token should reach Bob");
    out.log(`full token        → Bob  GET /data   → ${res.status}`, "ok");
    res = await aliceToDave("GET", "/data", { token });
    expect(res.status === 200, "the full token should reach Dave");
    out.log(`full token        → Dave GET /data   → ${res.status}`, "ok");

    // Attenuation: anyone holding the token can append a block; no key and no hub are needed.
    // A block can only add checks, so it can only narrow.
    const narrowed = Biscuit.fromBase64(token)
      .attenuate("check if self_peer({bob});\ncheck if time_ms($t), $t < {until};", {
        params: { bob, until: clock + 5 * MINUTE },
      })
      .toBase64();
    out.log("Alice appends a block: only at Bob, and only for five minutes");

    res = await aliceToBob("GET", "/data", { token: narrowed });
    expect(res.status === 200, "the narrowed token should still reach Bob");
    out.log(`narrowed token    → Bob  GET /data   → ${res.status}`, "ok");
    res = await aliceToDave("GET", "/data", { token: narrowed });
    expect(res.status === 403, "the narrowed token should be refused at Dave");
    out.log(
      `narrowed token    → Dave GET /data   → ${res.status} (Dave is not self_peer)`,
      "refused",
    );

    // A block cannot widen: the authority block's checks never see a later block's facts.
    const widened = Biscuit.fromBase64(token).attenuate('role("admin");').toBase64();
    res = await aliceToBob("GET", "/admin", { token: widened });
    expect(res.status === 403, "an appended role must not grant /admin");
    out.log(
      `+ role("admin")   → Bob  GET /admin  → ${res.status} (a block cannot add a role)`,
      "refused",
    );

    // Any change to the signed bytes breaks the signature chain.
    const i = Math.floor(narrowed.length / 2);
    const tampered =
      narrowed.slice(0, i) + (narrowed[i] === "A" ? "B" : "A") + narrowed.slice(i + 1);
    res = await aliceToBob("GET", "/data", { token: tampered });
    expect(res.status >= 400, "a tampered token should be refused");
    out.log(`one byte changed  → Bob  GET /data   → ${res.status}`, "refused");

    // The token is bound to Alice: handing it to Carol gives Carol nothing.
    res = await carolToBob("GET", "/data", { token: narrowed });
    expect(res.status >= 400, "Alice's token in Carol's hands should be refused");
    out.log(`Alice's token, sent by Carol → ${res.status} (bound to its subject)`, "refused");

    clock += 10 * MINUTE;
    out.log("ten minutes later");
    res = await aliceToBob("GET", "/data", { token: narrowed });
    expect(res.status === 401, "the narrowed token should have expired");
    out.log(
      `narrowed token    → Bob  GET /data   → ${res.status} (expired: its own five minutes are over)`,
      "refused",
    );
    res = await aliceToBob("GET", "/data", { token });
    expect(res.status === 200, "the full token is valid for an hour");
    out.log(`full token        → Bob  GET /data   → ${res.status} (the hub's hour is not)`, "ok");

    out.log("— Part 2: Alice passes a narrower right to Carol");
    const carolsMembership = await mintToken({
      signer: hub,
      sub: carol,
      roles: ["member"],
      ttlMs: 60 * MINUTE,
      now,
    });
    // Bob's application grants Alice read and write on one report.
    const grant = Biscuit.build(
      app.secretKey,
      'right("/reports/q3", "GET");\nright("/reports/q3", "PUT");',
    ).toBase64();
    res = await aliceToBob("PUT", "/reports/q3", { token, app: grant });
    expect(res.status === 200, "Alice's grant allows PUT");
    out.log(`Alice, app grant  → Bob  PUT /reports/q3 → ${res.status}`, "ok");

    // Delegation: Alice narrows the grant to "Carol, read only" and hands it over (any channel).
    const forCarol = Biscuit.fromBase64(grant)
      .attenuate('check if operation("GET");\ncheck if caller({carol});', { params: { carol } })
      .toBase64();
    out.log("Alice appends: only GET, only when the proven caller is Carol; gives it to Carol");

    res = await carolToBob("GET", "/reports/q3", { token: carolsMembership, app: forCarol });
    expect(res.status === 200, "Carol may read with the delegated token");
    out.log(`Carol, delegated  → Bob  GET /reports/q3 → ${res.status}`, "ok");
    res = await carolToBob("PUT", "/reports/q3", { token: carolsMembership, app: forCarol });
    expect(res.status === 403, "the delegated token does not allow PUT");
    out.log(
      `Carol, delegated  → Bob  PUT /reports/q3 → ${res.status} (only GET was passed on)`,
      "refused",
    );
    res = await aliceToBob("GET", "/reports/q3", { token, app: forCarol });
    expect(res.status === 403, "Carol's token in Alice's hands is refused");
    out.log(
      `Alice, Carol's token → Bob GET /reports/q3 → ${res.status} (the caller is not Carol)`,
      "refused",
    );
  } finally {
    await Promise.all(stops.map((stop) => stop()));
  }
}
