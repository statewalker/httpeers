// Joining a mesh. A hub (here, in this tab) mints a single-use invitation and shows it as a QR
// code. Alice redeems it: the hub records her as a member and mints her a token, which she then
// presents to read the mesh. A second redemption of the same invitation is refused.

import { ruleSet, withAccess } from "@statewalker/httpeers-access";
import { generateSigner, mintToken } from "@statewalker/httpeers-access/issuer";
import { createRemoteOverLink, serveFetchOverLink } from "@statewalker/httpeers-bridge";
import { pairedLinks } from "@statewalker/httpeers-bridge/ports";
import { ANONYMOUS, createPeerRouter, lookupPeer, setMeshToken } from "@statewalker/httpeers-core";
import { createHub, memoryStorage, usesTransportIdentity } from "@statewalker/httpeers-hub";
import { qrSvg } from "@statewalker/httpeers-qr";
import { expect, type Output } from "./output";

const rules = ruleSet({
  version: 1,
  rules: ['capability("std:mesh.read") <- role("member");'],
  policies: [
    'allow if capability("std:mesh.read"), resource($r), $r.starts_with("/.well-known/");',
  ],
});

export async function run(out: Output) {
  // The hub's key names the mesh and signs its tokens.
  const signer = await generateSigner();
  const hub = await createHub({
    selfPeerId: signer.mesh,
    policies: rules,
    storage: memoryStorage(), // idbStorage() in a page that must survive a reload
    mintToken: async (sub, roles) => mintToken({ signer, sub, roles, ttlMs: 5 * 60_000 }),
  });
  // Served as any peer serves: its mounts behind the router and the access guard. The two
  // bootstrap routes (invite, presence) need a proven caller but no token yet.
  const dispatch = createPeerRouter({
    selfPeerId: signer.mesh,
    mounts: hub.mounts,
    remote: async () => new Response(null, { status: 403 }),
    access: withAccess({
      issuer: signer.mesh,
      rules,
      selfPeer: signer.mesh,
      provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
      bootstrap: usesTransportIdentity(),
    }),
  });

  const alice = (await generateSigner()).mesh;
  const bob = (await generateSigner()).mesh;
  const [hubToAlice, aliceLink] = pairedLinks(signer.mesh, alice);
  const [hubToBob, bobLink] = pairedLinks(signer.mesh, bob);
  const stops = [
    await serveFetchOverLink({ link: hubToAlice, dispatch }),
    await serveFetchOverLink({ link: hubToBob, dispatch }),
  ];
  const fromAlice = createRemoteOverLink({ link: aliceLink });
  const fromBob = createRemoteOverLink({ link: bobLink });
  const redeem = (call: typeof fromAlice, id: string) =>
    call(
      signer.mesh,
      new Request("http://hub/.well-known/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      }),
    );

  try {
    const invitation = await hub.invitations.create(["member"], 10 * 60_000);
    out.log(`hub ${signer.mesh.slice(0, 16)}… creates invitation ${invitation.id}`);
    // What a member page scans. The deployed demos also put the relay's address in it.
    out.html(qrSvg(`https://app.httpeers.net/?invite=${invitation.id}`));

    let res = await fromAlice(signer.mesh, new Request("http://hub/.well-known/mesh"));
    expect(res.status >= 400, "a stranger may not read the mesh");
    out.log(`Alice, not a member yet:  GET /.well-known/mesh   → ${res.status}`, "refused");

    res = await redeem(fromAlice, invitation.id);
    expect(res.status === 200, "the invitation should redeem");
    const { token, roles } = await res.json();
    out.log(
      `Alice redeems it:  POST /.well-known/invite → ${res.status}, roles ${JSON.stringify(roles)}, a token`,
      "ok",
    );

    res = await redeem(fromBob, invitation.id);
    expect(res.status === 403, "a spent invitation should be refused");
    out.log(
      `Bob replays it:    POST /.well-known/invite → ${res.status} ${(await res.json()).error}`,
      "refused",
    );

    const headers = new Headers();
    setMeshToken(headers, token);
    res = await fromAlice(signer.mesh, new Request("http://hub/.well-known/mesh", { headers }));
    expect(res.status === 200, "a member may read the mesh");
    const view = await res.json();
    out.log(`Alice, with her token:    GET /.well-known/mesh   → ${res.status}`, "ok");
    out.log(
      `  members: ${view.members.map((m: { peerId: string }) => (m.peerId === alice ? "Alice" : m.peerId.slice(0, 12))).join(", ")}`,
    );
    expect(hub.isMember(alice) && !hub.isMember(bob), "only Alice is a member");
  } finally {
    for (const stop of stops) await stop();
    await hub.stop();
  }
}
