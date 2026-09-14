/**
 * A picture the person chose or just took, turned into something this peer can
 * serve to the mesh.
 *
 * NOTHING IS RE-ENCODED. An earlier version of the prototype downscaled
 * anything over 1280px, reasoning that the relay's 1 MiB per-connection data
 * limit would truncate a phone photo. That protected the exceptional path at
 * the cost of the normal one: peers upgrade to WebRTC and a direct, unlimited
 * connection, and the relay is not in the data path at all once ICE completes.
 * Silently re-encoding every photograph to guard a fallback that mostly does
 * not happen is the wrong trade — and it threw away the user's actual bytes to
 * do it.
 *
 * The bytes are served exactly as given. If a peer ever does fall back to a
 * relayed circuit and a large transfer is cut off, that is a visible failure of
 * the fallback and belongs in the fallback, not in a lossy transformation
 * applied to everyone in advance.
 *
 * SAME SHAPE AS `stock.ts` ON PURPOSE. Both hand back `{ info, bytes }`, so the
 * page adds a fetched photograph and a chosen one through one code path and
 * neither source is privileged — the mesh cannot tell them apart either.
 */

import type { ImageInfo } from "./images.js";

/** What a picture becomes when the browser reports no type at all — some Android pickers do. */
const FALLBACK_CONTENT_TYPE = "image/jpeg";

export interface LocalImage {
  info: ImageInfo;
  bytes: Uint8Array;
}

/**
 * Distinct per pick, so choosing the same file twice yields two gallery entries
 * rather than one silently replacing the other.
 *
 * `Math.random` is correct here for the same reason it is in `stock.ts`: this
 * is a catalogue key, not a credential. Invitation ids, which ARE bearer
 * credentials, come from the platform CSPRNG.
 */
function freshId(): string {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function fileToImage(file: File): Promise<LocalImage> {
  const declared = file.type;
  // An empty type is "the browser could not tell", which is not the same as
  // "this is not an image" — refusing it would reject real photographs.
  if (declared !== "" && !declared.startsWith("image/")) {
    throw new Error(`"${file.name}" is not an image (${declared}) — refusing to serve it as one.`);
  }
  const contentType = declared === "" ? FALLBACK_CONTENT_TYPE : declared;

  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    info: {
      id: freshId(),
      title: file.name.replace(/\.[^.]+$/, "") || "Untitled",
      contentType,
      size: bytes.length,
    },
    bytes,
  };
}
