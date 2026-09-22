/**
 * Deprecated: superseded by `tests/e2e/mesh.spec.mjs`, which now owns the mesh acceptance flow
 * end to end -- join with a pasted blob, four settings tabs, a key minted from the Keys panel, a
 * genuinely streamed reply -- and mints its own invitation via the appliance's `bin/invite.sh`
 * instead of a hand-supplied `HUB_ADMIN_USER`/`HUB_ADMIN_PASSWORD` against a hardcoded door URL.
 *
 * This file used to carry a second, parallel copy of that flow (targeting the dead "Choose a
 * model" dialog and a `?join=` link, both gone since Task 5/11) and had drifted from the app as
 * built. Task 13 promoted it rather than fixing it in place a second time -- "do not write a
 * second, divergent harness" -- so it is now a plain forward: `pnpm run mesh-smoke` still works,
 * and there is exactly one place this logic can go stale in.
 *
 *   pnpm run build && node scripts/mesh-smoke.mjs
 *   # same as: node tests/e2e/mesh.spec.mjs
 *
 * See that file's own header for how to start an appliance, how it is found (`APPLIANCE_DIR`),
 * and what it skips on.
 */

import "../tests/e2e/mesh.spec.mjs";
