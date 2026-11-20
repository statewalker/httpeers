// Who may call, and what may they do? A hub signs a membership token (a Biscuit) for Alice; Bob
// guards his handlers with withAccess and a Datalog policy. No server checks anything centrally:
// Bob verifies the token himself, against the hub's peer id, which is also its public key.

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
import { expect, type Output } from "./output";

// The mesh's rules: members may read /data, admins may also write it.
const rules = ruleSet({
  version: 1,
  rules: [
    'capability("app:read")  <- role("member");',
    'capability("app:write") <- role("admin");',
    'role("member")          <- role("admin");',
  ],
  policies: [
    'allow if capability("app:read"), resource($r), $r.starts_with("/data");',
    'allow if capability("app:write"), resource($r), $r.starts_with("/admin");',
  ],
});

export async function run(out: Output) {
  // Every identity is an Ed25519 key; its peer id names it. The hub's key signs tokens.
  const hub = await generateSigner();
  const alice = (await generateSigner()).mesh;
  const bob = (await generateSigner()).mesh;
  const carol = (await generateSigner()).mesh;
  out.log(`hub (the mesh) = ${hub.mesh.slice(0, 16)}…`);

  // Bob's handlers, behind one middleware: verify the token, bind it to the proven caller,
  // derive capabilities from roles, evaluate the policy for the requested path.
  const mounts = createMounts();
  mounts.provide("/data", async (req) =>
    json({ notes: ["first", "second"], caps: [...(access(req)?.capabilities() ?? [])] }),
  );
  mounts.provide("/admin", async () => json({ written: true }));
  const guard = withAccess({
    issuer: hub.mesh,
    rules,
    selfPeer: bob,
    provenPeer: (req) => lookupPeer(req) ?? ANONYMOUS,
  });
  const [linkA, linkB] = pairedLinks(alice, bob);
  const stop = await serveFetchOverLink({
    link: linkB,
    dispatch: createPeerRouter({
      selfPeerId: bob,
      mounts,
      access: guard,
      remote: async () => new Response(null, { status: 403 }),
    }),
  });
  const call = createRemoteOverLink({ link: linkA });
  const get = async (path: string, token?: string) => {
    const headers = new Headers();
    if (token) setMeshToken(headers, token);
    return call(bob, new Request(`http://peer.local${path}`, { headers }));
  };

  try {
    let res = await get("/data");
    expect(res.status >= 400, "no token should be refused");
    out.log(`no token            GET /data   → ${res.status}`, "refused");

    const member = await mintToken({ signer: hub, sub: alice, roles: ["member"], ttlMs: 60_000 });
    out.log(`hub mints a "member" token for Alice (a signed Biscuit, ${member.length} characters)`);

    res = await get("/data", member);
    expect(res.status === 200, "a member may read /data");
    out.log(
      `member token        GET /data   → ${res.status} ${JSON.stringify(await res.json())}`,
      "ok",
    );

    res = await get("/admin", member);
    expect(res.status === 403, "a member may not use /admin");
    out.log(`member token        GET /admin  → ${res.status}`, "refused");

    const admin = await mintToken({ signer: hub, sub: alice, roles: ["admin"], ttlMs: 60_000 });
    res = await get("/admin", admin);
    expect(res.status === 200, "an admin may use /admin");
    out.log(`admin token         GET /admin  → ${res.status} ${await res.text()}`, "ok");

    // A token is bound to the peer it was minted for: a stolen one is useless to anyone else.
    const carols = await mintToken({ signer: hub, sub: carol, roles: ["admin"], ttlMs: 60_000 });
    res = await get("/data", carols);
    expect(res.status >= 400, "Carol's token presented by Alice should be refused");
    out.log(`Carol's token, sent by Alice   → ${res.status}`, "refused");

    // A token signed by another mesh's hub is not this mesh's.
    const other = await generateSigner();
    const foreign = await mintToken({ signer: other, sub: alice, roles: ["admin"], ttlMs: 60_000 });
    res = await get("/data", foreign);
    expect(res.status >= 400, "a foreign mesh's token should be refused");
    out.log(`token from another mesh        → ${res.status}`, "refused");
  } finally {
    await stop();
  }
}
