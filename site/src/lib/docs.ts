import { repoFile } from "./site";

/** A Markdown file of the repository that the site renders at /docs/<slug>. */
export interface RepoPage {
  /** Path from the repository root. */
  file: string;
  slug: string;
  label: string;
}

export const guidePages: RepoPage[] = [
  { file: "docs/security-model.md", slug: "security", label: "Security model" },
  { file: "deploy/README.md", slug: "deploy", label: "Deployment runbook" },
  { file: "tools/publish/README.md", slug: "publish", label: "Publishing sites" },
];

/** The published libraries, in the order of the layers they sit in (lowest first). */
export const packagePages: RepoPage[] = [
  ["httpeers-core", "core"],
  ["httpeers-person", "person"],
  ["webrun-biscuit", "webrun-biscuit"],
  ["httpeers-access", "access"],
  ["httpeers-bridge", "bridge"],
  ["httpeers-libp2p", "libp2p"],
  ["httpeers-hub", "hub"],
  ["httpeers-member", "member"],
  ["httpeers-ghost", "ghost"],
  ["httpeers-share", "share"],
  ["httpeers-qr", "qr"],
  ["httpeers-join", "join"],
].map(([dir, label]) => ({
  file: `packages/${dir}/README.md`,
  slug: `packages/${dir}`,
  label,
}));

/** The deployables and pages (apps/*): services the mesh needs, and what runs on them. */
export const appPages: RepoPage[] = [
  ["relay", "Circuit relay"],
  ["sites", "Static-site host"],
  ["session-shell", "Session shell"],
  ["hub", "Hub daemon"],
  ["llm-chat", "LLM chat"],
  ["demos", "Demo sites"],
].map(([dir, label]) => ({ file: `apps/${dir}/README.md`, slug: `apps/${dir}`, label }));

export const repoPages = [...guidePages, ...packagePages, ...appPages];

export const pageHref = (page: RepoPage) => `/docs/${page.slug}`;

const hrefByFile = new Map(repoPages.map((page) => [page.file, pageHref(page)]));

/** The site page of a repository file if the site renders it, else the file on GitHub. */
export const docHref = (file: string) => hrefByFile.get(file) ?? repoFile(file);

/**
 * Pages of the site that explain, or run, what a repository page describes: shown at the top of
 * that page, so a reader of a package README finds the concept page and the live example, and the
 * other way round.
 */
export const relatedPages: Record<string, { href: string; label: string }[]> = {
  "docs/security-model.md": [
    { href: "/docs/access", label: "Access control: tokens, policy, attenuation, delegation" },
    { href: "/docs/architecture#headers", label: "Architecture: the two security headers" },
    { href: "/examples/access-tokens", label: "Live example: tokens and policy" },
  ],
  "packages/httpeers-access/README.md": [
    { href: "/docs/access", label: "Access control, explained" },
    { href: "/examples/access-tokens", label: "Live example: tokens and policy" },
    { href: "/examples/attenuation", label: "Live example: attenuation and delegation" },
  ],
  "packages/webrun-biscuit/README.md": [
    { href: "/docs/access#attenuation", label: "Access control: attenuation" },
    { href: "/examples/attenuation", label: "Live example: attenuation and delegation" },
  ],
  "packages/httpeers-hub/README.md": [
    { href: "/docs/access#membership", label: "Access control: invitations and membership" },
    { href: "/examples/hub-invitation", label: "Live example: a hub in a tab, and an invitation" },
  ],
  "packages/httpeers-qr/README.md": [
    { href: "/examples/hub-invitation", label: "Live example: an invitation shown as a QR code" },
  ],
  "packages/httpeers-core/README.md": [
    { href: "/docs/architecture#request-path", label: "Architecture: the request path" },
    { href: "/examples/mesh-over-ports", label: "Live example: two peers, one fetch()" },
  ],
  "packages/httpeers-bridge/README.md": [
    { href: "/docs/architecture#request-path", label: "Architecture: the request path" },
    { href: "/examples/mesh-over-ports", label: "Live example: two peers, one fetch()" },
  ],
  "packages/httpeers-member/README.md": [
    { href: "/docs#join", label: "Getting started: join a mesh" },
    { href: "/examples#deployed-demos", label: "The deployed demos" },
  ],
  "apps/demos/README.md": [
    { href: "/examples#deployed-demos", label: "Try the deployed demos" },
    { href: "/docs/access#membership", label: "Access control: invitations and membership" },
  ],
};
