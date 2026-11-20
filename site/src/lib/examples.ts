/** The live examples: each runs src/examples/<slug>.ts in the visitor's tab, no relay needed. */
export interface Example {
  slug: string;
  title: string;
  summary: string;
  /** The packages it imports, in the order a reader meets them. */
  packages: string[];
  /** What to look for in the transcript. */
  shows: string[];
  /** The pages that explain what the example shows: read them before or after running it. */
  concepts: { href: string; label: string; why: string }[];
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
      {
        href: "/docs/architecture#request-path",
        label: "Architecture: the request path",
        why: "where the bridge and the peer router sit between a page's fetch() and a peer's handler",
      },
      {
        href: "/docs/architecture#headers",
        label: "Architecture: two headers carry the security",
        why: "why x-httpeers-peer is rewritten from what the transport proved",
      },
      {
        href: "/docs/packages/httpeers-bridge",
        label: "httpeers-bridge",
        why: "fetch over a duplex, and pairedLinks for MessagePorts",
      },
      {
        href: "/docs/packages/httpeers-core",
        label: "httpeers-core",
        why: "the FetchHandler contract, the mount table and the peer router",
      },
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
      {
        href: "/docs/access#tokens",
        label: "Access control: what a membership token says",
        why: "the authority block the hub signs, and why the hub's peer id is the verifying key",
      },
      {
        href: "/docs/access#policy",
        label: "Access control: the node's policy",
        why: "roles in the token, capabilities and policies in Bob's own rule set",
      },
      {
        href: "/docs/access#binding",
        label: "Access control: peer binding",
        why: "why Carol's token in Alice's hands is refused",
      },
      {
        href: "/docs/security",
        label: "Security model",
        why: "what the mesh protects, and the uses to avoid",
      },
    ],
  },
  {
    slug: "attenuation",
    title: "Attenuation and delegation",
    summary:
      "Alice narrows her own membership token to one peer and five minutes by appending a Biscuit block, with no call to the hub. Then she passes a narrower right to Carol with an application token, which Bob checks against the caller the transport proved.",
    packages: [
      "@statewalker/webrun-biscuit",
      "@statewalker/httpeers-access",
      "@statewalker/httpeers-core",
      "@statewalker/httpeers-bridge",
    ],
    shows: [
      "The narrowed token works at Bob and is refused at Dave; ten minutes later it has expired while the hub's original still works.",
      'An appended block cannot widen: role("admin") added by the holder grants nothing, and a changed byte breaks the signature.',
      "Membership tokens are bound to their subject, so they are not handed on. A right is delegated with an application token: Carol may GET with it, not PUT, and Alice cannot use Carol's copy.",
    ],
    concepts: [
      {
        href: "/docs/access#attenuation",
        label: "Access control: attenuation",
        why: "what an appended block can check, and why it can only narrow",
      },
      {
        href: "/docs/access#delegation",
        label: "Access control: passing a right to another peer",
        why: "why membership tokens are not delegated, and how an application token is",
      },
      {
        href: "/docs/packages/webrun-biscuit",
        label: "webrun-biscuit",
        why: "the Biscuit engine: attenuate, seal, verify, authorize",
      },
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
      {
        href: "/docs/access#membership",
        label: "Access control: invitations and membership",
        why: "how an invitation becomes a member record and a token, and how roles change",
      },
      {
        href: "/docs/packages/httpeers-hub",
        label: "httpeers-hub",
        why: "the hub's endpoints, storage and registries",
      },
      {
        href: "/docs/packages/httpeers-qr",
        label: "httpeers-qr",
        why: "invitations as QR codes, and the camera scanner",
      },
      {
        href: "/examples#deployed-demos",
        label: "The deployed demos",
        why: "the same join over a real relay, between two devices",
      },
    ],
  },
];
