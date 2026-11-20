/** The live examples: each runs src/examples/<slug>.ts in the visitor's tab, no relay needed. */
export interface Example {
  slug: string;
  title: string;
  summary: string;
  /** The packages it imports, in the order a reader meets them. */
  packages: string[];
  /** What to look for in the transcript. */
  shows: string[];
}

export const examples: Example[] = [
  {
    slug: "mesh-over-ports",
    title: "Two peers, one fetch()",
    summary:
      "Alice and Bob serve HTTP handlers to each other over a pair of MessagePorts: the bridge, the mount table and the peer router a deployed mesh runs, with no libp2p, relay or hub.",
    packages: ["@statewalker/httpeers-core", "@statewalker/httpeers-bridge"],
    shows: [
      "Requests and responses in both directions, bodies included.",
      "The caller's identity is what the link proved: a forged x-httpeers-peer header is overwritten on arrival.",
      "An unknown path is a 404 from the mount table, not a hang.",
    ],
  },
  {
    slug: "access-tokens",
    title: "Tokens and policy",
    summary:
      "A hub mints Biscuit membership tokens; Bob guards his handlers with withAccess and a Datalog policy and verifies every token himself, against the hub's peer id.",
    packages: [
      "@statewalker/httpeers-access",
      "@statewalker/httpeers-core",
      "@statewalker/httpeers-bridge",
    ],
    shows: [
      "No token: refused. A member token reads /data; only an admin token reaches /admin.",
      "A token is bound to the peer it was minted for: Carol's token in Alice's hands is refused.",
      "A token signed by another mesh's hub is refused.",
    ],
  },
  {
    slug: "hub-invitation",
    title: "A hub in a tab, and an invitation",
    summary:
      "A hub runs in this tab (it has no transport of its own), mints a single-use invitation shown as a QR code, and admits Alice when she redeems it.",
    packages: [
      "@statewalker/httpeers-hub",
      "@statewalker/httpeers-qr",
      "@statewalker/httpeers-access",
      "@statewalker/httpeers-bridge",
    ],
    shows: [
      "A stranger cannot read the mesh view.",
      "Redeeming the invitation makes Alice a member and gives her a token; replaying it is refused.",
      "With her token, Alice reads /.well-known/mesh and sees herself in it.",
    ],
  },
];
