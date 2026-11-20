export const REPO = "https://github.com/statewalker/httpeers";
/** Links into the repository's default branch. */
export const repoFile = (path: string) => `${REPO}/blob/HEAD/${path}`;
export const npmPackage = (name: string) => `https://www.npmjs.com/package/${name}`;

/**
 * The four demo pages (apps/demos), published on four origins that form one mesh. They need the
 * circuit relay at relay.httpeers.net.
 */
export const DEPLOYED_DEMOS = [
  {
    name: "hub",
    href: "https://hub.httpeers.net/",
    title: "Hub",
    body: "Creates the mesh in a browser tab and mints invitations, shown as QR codes. Serves search and a small app at /spa.",
  },
  {
    name: "images",
    href: "https://images.httpeers.net/",
    title: "Images",
    body: "A provider: serves a gallery to the mesh. Stock photographs, plus any picture you choose or take with the phone's camera.",
  },
  {
    name: "app",
    href: "https://app.httpeers.net/",
    title: "App",
    body: "A consumer: finds providers and calls them with a bare fetch(); opens a peer's app in a session origin of its own.",
  },
  {
    name: "proxy",
    href: "https://proxy.httpeers.net/",
    title: "Proxy",
    body: "Exposes an outside origin to the mesh, so members reach it through their own fetch().",
  },
] as const;
