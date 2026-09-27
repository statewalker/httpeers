/**
 * Settings-dialog "Keys" tab: an admin's "Key for a member" minting (`member-key.tsx`'s
 * `MemberKeyButton`, unchanged) plus the LiteLLM dashboard link. This is `mesh.tsx`'s former
 * `dashboard` header element, moved here (Task 11) rather than redesigned -- including its
 * gating: the whole tab body stays empty for a non-admin, exactly as the header element did.
 *
 * Lives under `mesh/`, not `ui/`: it imports httpeers (through `../member-key.js`), which is why
 * the boundary test keeps it out of the standalone page's closure.
 */

import { MemberKeyButton } from "../member-key.js";
import type { MeshSessionHandle } from "./mesh-session.js";

/**
 * `href` is `service.dashboardUrl` -- always the dashboard's MOUNT, `<edge><hub>/llm/ui/`, never
 * a page inside it: `dashboardEntry` in `../discover.ts` says why LiteLLM's login page must not
 * be linked directly. Exported so `mesh.tsx` can reuse it for the pre-chat "key" stage, which has
 * no settings dialog to contribute this tab into yet.
 */
export function DashboardLink({ href }: { href: string }) {
  return (
    <a
      className="text-xs text-blue-700 underline"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      LiteLLM dashboard
    </a>
  );
}

export function KeysPanel({ meshSession }: { meshSession: MeshSessionHandle }) {
  const { admin, service, pageUrl } = meshSession.current;
  if (!admin || service == null) {
    return <p className="text-sm text-muted-foreground">Admin only.</p>;
  }
  return (
    <div className="flex flex-col items-start gap-3">
      {service.canMintKeys && (
        <MemberKeyButton
          fetchImpl={meshSession.fetchImpl}
          serviceBase={service.serviceBase}
          pageUrl={pageUrl}
        />
      )}
      <DashboardLink href={service.dashboardUrl} />
    </div>
  );
}
