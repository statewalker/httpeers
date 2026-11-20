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

/** Site pages that explain what a rendered repository page covers, shown under it. */
export const relatedPages: Record<string, { href: string; label: string }[]> = {
  security: [
    { href: "/docs/access", label: "Access control: tokens, policy, attenuation, revocation" },
    { href: "/docs/membership", label: "Joining a mesh: invitations and membership" },
    { href: "/docs/architecture#request-path", label: "Architecture: the request path" },
  ],
  "packages/httpeers-core": [
    { href: "/docs/architecture#request-path", label: "Architecture: the request path" },
    { href: "/docs/architecture#headers", label: "Architecture: two headers carry the security" },
  ],
  "packages/httpeers-bridge": [
    { href: "/docs/architecture#request-path", label: "Architecture: the request path" },
  ],
  "packages/httpeers-access": [
    { href: "/docs/access", label: "Access control, explained" },
    { href: "/docs/access#unsupported", label: "Access control: what is not implemented" },
  ],
  "packages/webrun-biscuit": [
    { href: "/docs/access#tokens", label: "Access control: how httpeers uses Biscuit" },
    { href: "/docs/access#attenuation", label: "Access control: attenuation" },
  ],
  "packages/httpeers-hub": [{ href: "/docs/membership", label: "Joining a mesh, explained" }],
  "packages/httpeers-qr": [
    { href: "/docs/membership#invitation", label: "Joining a mesh: invitations" },
  ],
  "packages/httpeers-join": [
    { href: "/docs/membership#invitation", label: "Joining a mesh: invitations" },
  ],
};
