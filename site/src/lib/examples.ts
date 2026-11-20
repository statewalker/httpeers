/** The live examples: each runs src/examples/<slug>.ts in the visitor's tab, no relay needed. */
export interface Example {
  slug: string;
  title: string;
  summary: string;
  /** The packages it imports, in the order a reader meets them. */
  packages: string[];
  /** What to look for in the transcript. */
  shows: string[];
  /** The explanation sections this example demonstrates. */
  concepts: { href: string; label: string }[];
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
    concepts: [
      { href: "/docs/architecture#request-path", label: "Architecture: the request path" },
      { href: "/docs/architecture#headers", label: "Architecture: two headers carry the security" },
      { href: "/docs/packages/httpeers-bridge", label: "httpeers-bridge: fetch over any duplex" },
      { href: "/docs/packages/httpeers-core", label: "httpeers-core: mounts, router, headers" },
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
    concepts: [
      { href: "/docs/access#tokens", label: "Access control: Biscuit tokens" },
      { href: "/docs/access#policy", label: "Access control: the Datalog policy" },
      { href: "/docs/access#binding", label: "Access control: a token is bound to its peer" },
      { href: "/docs/security", label: "The security model" },
    ],
  },
  {
    slug: "delegation",
    title: "Narrowing a token",
    summary:
      "Alice appends a block of checks to her member token (no hub involved), so it works only at Bob and only for 30 seconds. Bob accepts it; Dave refuses it; widening and tampering fail.",
    packages: [
      "@statewalker/webrun-biscuit",
      "@statewalker/httpeers-access",
      "@statewalker/httpeers-core",
      "@statewalker/httpeers-bridge",
    ],
    shows: [
      "The narrowed token is accepted where its checks hold (Bob) and refused where they do not (Dave).",
      'An appended role("admin") grants nothing: a block can only add checks.',
      "A token with one altered character fails its signature; the same token sent by Carol fails the peer binding.",
    ],
    concepts: [
      { href: "/docs/access#attenuation", label: "Access control: attenuation" },
      { href: "/docs/access#passing", label: "Access control: passing a right to another peer" },
      { href: "/docs/access#binding", label: "Access control: a token is bound to its peer" },
      { href: "/docs/security", label: "The security model" },
    ],
  },
  {
    slug: "app-grants",
    title: "Passing a right to another peer",
    summary:
      'Bob\'s application grants Alice a right in its own Biscuit, sent in Authorization. Alice narrows it to "Carol may read" and hands it to Carol; Bob verifies it and binds it to the proven caller.',
    packages: [
      "@statewalker/webrun-biscuit",
      "@statewalker/httpeers-access",
      "@statewalker/httpeers-core",
      "@statewalker/httpeers-bridge",
    ],
    shows: [
      "Carol reads the report with the grant Alice narrowed for her; the PUT that Alice removed is refused.",
      "The grant names its holder: presented by Alice instead of Carol, it is refused.",
      "A changed byte breaks the signature chain; without a membership token the mesh refuses before the application looks.",
    ],
    concepts: [
      {
        href: "/docs/access#application-grants",
        label: "Access control: rights an application passes on",
      },
      { href: "/docs/access#attenuation", label: "Access control: attenuation" },
      { href: "/docs/architecture#headers", label: "Architecture: the two headers" },
      { href: "/docs/security", label: "The security model" },
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
    concepts: [
      { href: "/docs/membership", label: "Joining a mesh: invitations and membership" },
      { href: "/docs/access#revocation", label: "Access control: revocation and expiry" },
      { href: "/docs/packages/httpeers-hub", label: "httpeers-hub" },
      { href: "/docs/packages/httpeers-qr", label: "httpeers-qr" },
    ],
  },
];
