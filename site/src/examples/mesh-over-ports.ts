// Two peers, Alice and Bob, serving HTTP to each other in this tab. The link between them is a
// pair of MessagePorts instead of libp2p: the bridge, the router and the identity binding are the
// same code a deployed mesh runs.
import { createRemoteOverLink, serveFetchOverLink } from "@statewalker/httpeers-bridge";
import { pairedLinks } from "@statewalker/httpeers-bridge/ports";
import { createMounts, createPeerRouter, json, lookupPeer } from "@statewalker/httpeers-core";
import { expect, type Output } from "./output";

const ALICE = `12D3KooW${"A".repeat(44)}`;
const BOB = `12D3KooW${"B".repeat(44)}`;

/** A peer: a mount table of FetchHandlers behind the peer router. */
function peer(id: string, name: string) {
  const mounts = createMounts();
  mounts.provide("/hello", async () => new Response(`hello from ${name}`));
  // Who is calling? Whatever the TRANSPORT proved, bound to the request on arrival.
  mounts.provide("/whoami", async (req) => json({ caller: String(lookupPeer(req)) }));
  mounts.provide("/echo", async (req) => new Response(await req.text()));
  return createPeerRouter({
    selfPeerId: id,
    mounts,
    remote: async () => new Response("no relaying here", { status: 403 }),
  });
}

export async function run(out: Output) {
  const [linkA, linkB] = pairedLinks(ALICE, BOB);
  const stopA = await serveFetchOverLink({ link: linkA, dispatch: peer(ALICE, "Alice") });
  const stopB = await serveFetchOverLink({ link: linkB, dispatch: peer(BOB, "Bob") });
  const fromAlice = createRemoteOverLink({ link: linkA });
  const fromBob = createRemoteOverLink({ link: linkB });
  try {
    // A Request in, a Response out: the whole contract.
    let res = await fromAlice(BOB, new Request("http://peer.local/hello"));
    out.log(`Alice → Bob  GET /hello   ${res.status} "${await res.text()}"`, "ok");

    res = await fromBob(ALICE, new Request("http://peer.local/hello"));
    out.log(`Bob → Alice  GET /hello   ${res.status} "${await res.text()}"`, "ok");

    res = await fromAlice(
      BOB,
      new Request("http://peer.local/echo", { method: "POST", body: "a body, streamed" }),
    );
    out.log(`Alice → Bob  POST /echo   ${res.status} "${await res.text()}"`, "ok");

    res = await fromAlice(BOB, new Request("http://peer.local/whoami"));
    const { caller } = await res.json();
    expect(caller === ALICE, "Bob should see Alice as the caller");
    out.log(`Alice → Bob  GET /whoami  caller = ${caller === ALICE ? "Alice" : caller}`, "ok");

    // Alice claims to be somebody else. The header is overwritten with what the link proved.
    res = await fromAlice(
      BOB,
      new Request("http://peer.local/whoami", {
        headers: { "x-httpeers-peer": "12D3KooWMallory" },
      }),
    );
    const forged = (await res.json()).caller;
    expect(forged === ALICE, "the forged header should be overwritten");
    out.log(
      `Alice sends x-httpeers-peer: 12D3KooWMallory → Bob sees ${forged === ALICE ? "Alice" : forged}`,
      "refused",
    );

    res = await fromAlice(BOB, new Request("http://peer.local/nothing-here"));
    expect(res.status === 404, "an unknown path should be a 404");
    out.log(`Alice → Bob  GET /nothing-here  ${res.status} (no such mount)`, "refused");
  } finally {
    await stopA();
    await stopB();
  }
}
