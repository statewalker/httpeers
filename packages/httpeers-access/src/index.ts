/**
 * Who is calling, and may they.
 *
 * An explicit list, never `export *` — see `httpeers-core`'s barrel for the
 * reason. The split across three entry points is deliberate:
 *
 *   `.`         verification and policy. What a MEMBER needs.
 *   `./issuer`  minting and the revocation registry. What a HUB needs.
 *   `./engine`  the WASM loader seam. Optional, and almost nobody needs it.
 *
 * A member that imports only the root never pulls minting into its bundle,
 * which is the point of separating them rather than a tidiness preference.
 */

// Where a mesh's verifying key comes from.
export {
  describeMeshId,
  type IssuerKeys,
  meshIdOf,
  publicKeyOf,
  selfCertifyingKeys,
} from "./keys.js";

// Policy: the rule set, whole — builder, readers and authorizer together.
export {
  assertValid,
  authorize,
  capabilityNames,
  type Decision,
  deriveCapabilities,
  type PolicyInit,
  type RequestFacts,
  type RuleSet,
  type RuleSetDefs,
  RuleSetError,
  roleNames,
  ruleSet,
  validateRoles,
  withPolicy,
} from "./rules.js";
export type { Signer } from "./signer.js";
// Verification.
export {
  LIMITS,
  TokenVerificationError,
  type VerifyTokenOptions,
  verifyToken,
  warmUpTokens,
} from "./tokens.js";
export type { MeshId, SubjectId } from "./types.js";
