/**
 * Revocation: a token is revoked when any of its blocks' revocation ids is in
 * the revoked set. Revoking a block's id revokes every token derived from it,
 * since each attenuation keeps the ids of the blocks before it.
 */

/** Anything carrying a token's revocation ids: a `VerifiedBiscuit` or a `LoadedToken`. */
export interface HasRevocationIds {
  readonly revocationIds: readonly string[];
}

/** Thrown by `assertNotRevoked`. `revocationId` is the first id found revoked. */
export class RevokedTokenError extends Error {
  constructor(readonly revocationId: string) {
    super(`token revoked: ${revocationId}`);
    this.name = "RevokedTokenError";
  }
}

/**
 * The first of the token's revocation ids found in `revoked`, if any. The
 * token's ids are lowercase hex; `revoked` may hold them lowercase or
 * uppercase (a set of mixed-case ids should be lowercased by its owner).
 */
export function revokedId(
  token: HasRevocationIds,
  revoked: ReadonlySet<string>,
): string | undefined {
  return token.revocationIds.find((id) => {
    const lower = id.toLowerCase();
    return revoked.has(lower) || revoked.has(lower.toUpperCase());
  });
}

/** Whether any of the token's revocation ids is in `revoked` (hex ids, either case). */
export function isRevoked(token: HasRevocationIds, revoked: ReadonlySet<string>): boolean {
  return revokedId(token, revoked) !== undefined;
}

/** Throw `RevokedTokenError` when any of the token's revocation ids is in `revoked`. */
export function assertNotRevoked(token: HasRevocationIds, revoked: ReadonlySet<string>): void {
  const id = revokedId(token, revoked);
  if (id !== undefined) throw new RevokedTokenError(id);
}
