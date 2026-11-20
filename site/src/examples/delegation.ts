// Narrowing a token before passing it on. Alice holds a member token usable at every peer. She
// appends a block to it, with no hub and no key of the hub's: "only at Bob, only for 30 seconds".
// Bob verifies the narrowed token against the hub's peer id and accepts it; Dave refuses it. An
// appended block can only add checks: a block that claims a role changes nothing, and a token
// whose bytes were altered fails its signature. The token stays bound to Alice, so it narrows what
// she can do; it does not hand a right to another holder.

import { access, ruleSet, withAccess } from "@statewalker/httpeers-access";
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
import { Biscuit } from "@statewalker/webrun-biscuit";
import { expect, type Output } from "./output";

const rules = ruleSet({
  version: 1,
  rules: ['capability("app:read") <- role("member");', 'capability("app:write") <- role("admin");'],
  policies: [
    'allow if capability("app:read"), resource($r), $r.starts_with("/data");',
    'allow if capability("app:write"), resource($r), $r.starts_with("/admin");',
  ],
});

export async function run(out: Output) {
  const hub = await generateSigner();
  const [alice, bob, dave, carol] = await Promise.all(
    [1, 2, 3, 4].map(async () => (await generateSigner()).mesh),
  );
  const name = (peer: string) =>
    ({ [alice]: "Alice", [bob]: "Bob", [dave]: "Dave", [carol]: "Carol" })[peer];

  // Bob and Dave serve the same handlers behind the same policy; each verifies tokens himself.
  const stops: Array<() => Promise<void>> = [];
  const connect = async (caller: string, target: string) => {
    const mounts = createMounts();
    mounts.provide("/data", async (req) =>
      json({ by: name(target), for: name(access(req)?.claims?.sub ?? "") }),
    );
    mounts.provide("/admin", async () => json({ written: true }));
    const [callerLink, targetLink] = pairedLinks(caller, target);
    stops.push(
      await serveFetchOverLink({
        link: targetLink,
        dispatch: createPeerRouter({
          selfPeerId: target,
          mounts,
          remote: async () => new Response(null, { status: 403 }),
          access: withAccess({
            issuer: hub.mesh,
            rules,
            selfPeer: target, // asserted as self_peer: what an audience check is evaluated against
            provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
          }),
        }),
      }),
    );
    const call = createRemoteOverLink({ link: callerLink });
    return async (path: string, token: string) => {
      const headers = new Headers();
      setMeshToken(headers, token);
      return call(target, new Request(`http://peer.local${path}`, { headers }));
    };
  };
  const aliceToBob = await connect(alice, bob);
  const aliceToDave = await connect(alice, dave);
  const carolToBob = await connect(carol, bob);

  try {
    const token = await mintToken({
      signer: hub,
      sub: alice,
      roles: ["member"],
      ttlMs: 10 * 60_000,
    });
    out.log("the hub mints Alice a member token, valid at every peer of the mesh for 10 minutes");
    let res = await aliceToDave("/data", token);
    expect(res.status === 200, "the original token works at Dave");
    out.log(`original token    → Dave  GET /data   → ${res.status}`, "ok");

    // Attenuation: Alice appends a block of checks. Values are bound as parameters, never spliced.
    const narrowed = Biscuit.fromBase64(token)
      .attenuate("check if self_peer({bob}); check if time_ms($t), $t < {until};", {
        params: { bob, until: Date.now() + 30_000 },
      })
      .toBase64();
    out.log(
      "Alice appends a block: check if self_peer(Bob); check if time_ms($t), $t < now + 30 s",
    );

    res = await aliceToBob("/data", narrowed);
    expect(res.status === 200, "the narrowed token works at Bob");
    out.log(`narrowed token    → Bob   GET /data   → ${res.status} ${await res.text()}`, "ok");

    res = await aliceToDave("/data", narrowed);
    expect(res.status >= 400, "the narrowed token is refused at Dave");
    out.log(
      `narrowed token    → Dave  GET /data   → ${res.status} (the block's check fails there)`,
      "refused",
    );

    // A block can only add checks. A role it claims is invisible to the authority block's readers.
    const widened = Biscuit.fromBase64(narrowed).attenuate('role("admin");').toBase64();
    res = await aliceToBob("/admin", widened);
    expect(res.status === 403, "an appended role grants nothing");
    out.log(
      `+ block role("admin") → Bob GET /admin → ${res.status} (still only a member)`,
      "refused",
    );

    // One altered character in the middle of the token breaks the signature chain.
    const i = Math.floor(narrowed.length / 2);
    const tampered =
      narrowed.slice(0, i) + (narrowed[i] === "A" ? "B" : "A") + narrowed.slice(i + 1);
    res = await aliceToBob("/data", tampered);
    expect(res.status >= 400, "a tampered token is refused");
    out.log(`tampered token    → Bob   GET /data   → ${res.status}`, "refused");

    // The token names its subject, and Bob checks it against the peer the link proved.
    res = await carolToBob("/data", narrowed);
    expect(res.status >= 400, "Alice's token in Carol's hands is refused");
    out.log(`Alice's token sent by Carol → Bob     → ${res.status} (bound to Alice)`, "refused");
  } finally {
    for (const stop of stops) await stop();
  }
}
