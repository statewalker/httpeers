/**
 * The join blob: everything a page needs to join a mesh whose hub is
 * ANOTHER BROWSER PAGE, in one copyable string.
 *
 * WHY IT HAS TO EXIST. Every page in this stack has so far learned the mesh
 * from `httpeers.json` -- `{ relayAddrs, hubPeerId }`, written once by
 * `pnpm bootstrap` (`../setup/main.ts`) and served by both origins. That
 * works because the Node hub's identity comes from a key file generated at
 * bootstrap, so its peerId is knowable BEFORE it runs. The hub page's is
 * not: it generates (or reloads) its identity in IndexedDB, in a tab, after
 * `pnpm bootstrap` has already been and gone. Nothing on disk can name it.
 * So the hub page hands its peerId out at runtime, alongside the relay it
 * reserved through and a single-use invitation id -- and this module is the
 * shape of that hand-off.
 *
 * ONE INVITATION PER PAGE, NOT ONE PER MESH. Invitations are single-use by
 * construction (`../hub/hub-state.ts`'s `redeem` moves the id to
 * `spentInvitationIds`, and the spent check runs first, unconditionally), so
 * a blob shared between two pages lets exactly one in and fails the other
 * with `already-redeemed`. `../pages/hub/main.ts` mints a fresh invitation
 * per blob for that reason; this module only carries what it is given.
 *
 * THE ENCODING IS BASE64URL OF JSON, and it is a URL query parameter
 * (`?join=`). Two properties matter and nothing else does: it survives a
 * copy-paste through a terminal, a chat window and a browser address bar
 * without needing quoting (base64url's alphabet is `A-Za-z0-9-_`, all
 * URL-safe and none of it shell-special), and it is one token, so an
 * operator cannot paste half of it. It is NOT encryption and not
 * authentication -- anyone holding the blob can redeem the invitation
 * inside it, which is exactly what an invitation is.
 *
 * NOT A HEADER, EVER. Same rule the rest of this app follows: human-facing
 * text travels in a body or a URL, never a header (HTTP header values are
 * latin1 -- see `../services/search.ts`'s own note).
 */

/** The invitation payload's shape (`../setup/main.ts`'s `HttpeersConfig`) plus the one-shot invitation id that goes with it. */
export interface JoinBlob {
  relayAddrs: string[];
  hubPeerId: string;
  invitationId: string;
}

/** The query parameter a join blob travels in. */
export const JOIN_BLOB_PARAM = "join";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  // `atob` requires the padding `toBase64Url` stripped.
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encode a blob. UTF-8 first, THEN base64: `btoa` throws on any code point
 * above U+00FF, and while nothing in a blob is human text today (multiaddrs
 * and peer ids are ASCII), a relay address is operator-supplied
 * (`RELAY_HOST`) and a hostname can be an IDN.
 */
export function encodeJoinBlob(blob: JoinBlob): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(blob)));
}

/**
 * Decode a blob, validating every field rather than trusting the shape.
 * Throws with a message naming what was wrong: this value was typed or
 * pasted by a person, so a malformed one is an ordinary event, and "the
 * link you pasted is missing its hub peer id" is a fixable complaint where
 * `undefined is not an object` is not.
 */
export function decodeJoinBlob(text: string): JoinBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(text.trim())));
  } catch (err) {
    throw new Error(
      "join blob: this is not a join link from a hub page -- it did not decode. Copy the whole " +
        `link, including the "?${JOIN_BLOB_PARAM}=" part. Cause: ${String(err)}`,
      { cause: err },
    );
  }

  const blob = parsed as Partial<JoinBlob>;
  const relayAddrs = blob.relayAddrs;
  if (!Array.isArray(relayAddrs) || relayAddrs.length === 0) {
    throw new Error("join blob: no relayAddrs -- there is nothing to dial.");
  }
  if (typeof blob.hubPeerId !== "string" || blob.hubPeerId === "") {
    throw new Error("join blob: no hubPeerId -- this page would not know which mesh to join.");
  }
  if (typeof blob.invitationId !== "string" || blob.invitationId === "") {
    throw new Error("join blob: no invitationId -- this page would have nothing to redeem.");
  }
  return { relayAddrs, hubPeerId: blob.hubPeerId, invitationId: blob.invitationId };
}

/** The join URL an operator copies: `pageOrigin` with this blob attached. `pageUrl` is a full URL (e.g. `http://127.0.0.1:5175/`). */
export function joinUrl(pageUrl: string, blob: JoinBlob): string {
  const url = new URL(pageUrl);
  url.searchParams.set(JOIN_BLOB_PARAM, encodeJoinBlob(blob));
  return url.toString();
}

/**
 * What a page found in its own URL, or in what someone pasted into its
 * join form.
 *
 * TWO CASES, AND THE DIFFERENCE IS WHICH MESH. A `join` blob carries its
 * own `relayAddrs`/`hubPeerId`, so the page joins the mesh the blob names
 * -- a hub page's. A bare `invite` id carries neither, so the page falls
 * back to `httpeers.json` and joins the mesh the DEPLOYMENT names -- the
 * Node hub's. Both are supported deliberately: the Node hub is not going
 * anywhere (Task 24's first decision), and a page that silently preferred
 * one would make the other unreachable with no way to say so.
 */
export type JoinInput =
  | { kind: "blob"; blob: JoinBlob }
  | { kind: "invitation-id"; invitationId: string };

/**
 * Read a join input out of a page's `location.search`. Returns `null` when
 * neither parameter is present -- the page then shows its paste-in form.
 */
export function readJoinInputFromSearch(search: string): JoinInput | null {
  const params = new URLSearchParams(search);
  const blobParam = params.get(JOIN_BLOB_PARAM);
  if (blobParam != null && blobParam.trim() !== "") {
    return { kind: "blob", blob: decodeJoinBlob(blobParam) };
  }
  const invite = params.get("invite");
  if (invite != null && invite.trim() !== "") {
    return { kind: "invitation-id", invitationId: invite.trim() };
  }
  return null;
}

/**
 * Read a join input out of text a person pasted into a page's join form --
 * a whole join URL, a bare blob, or a bare invitation id.
 *
 * ACCEPTS A WHOLE URL BECAUSE THAT IS WHAT GETS COPIED. The hub page's
 * panel renders a complete link; an operator who copies it and pastes it
 * into the form (rather than the address bar) has done nothing wrong, and a
 * form that rejected it would be the page being pedantic about a
 * distinction only it can see.
 */
export function readJoinInputFromText(text: string): JoinInput | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  if (trimmed.includes("://") || trimmed.includes(`${JOIN_BLOB_PARAM}=`)) {
    // A URL, or at least something with a query string in it. `new URL`
    // needs a base for the second case; the base is never used for anything
    // but parsing, and the blob inside carries the real addresses.
    const url = new URL(trimmed, "http://join.invalid/");
    const found = readJoinInputFromSearch(url.search);
    if (found != null) return found;
    throw new Error(
      `join: that link carries no "${JOIN_BLOB_PARAM}" or "invite" parameter -- is it the whole link?`,
    );
  }

  // A bare value. A blob is base64url of a JSON object, which always starts
  // `{"` -> `eyJ`; an invitation id is a UUID (`../hub/main.ts`'s
  // `randomUUID`) and never does.
  if (trimmed.startsWith("eyJ")) return { kind: "blob", blob: decodeJoinBlob(trimmed) };
  return { kind: "invitation-id", invitationId: trimmed };
}
