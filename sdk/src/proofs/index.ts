/**
 * Proof Handlers Registry
 *
 * TODO: Reevaluate this pattern - requires manual registration when adding
 * new proofs. Consider build-time codegen for true auto-discovery.
 *
 * Add new proof handlers here. Each export is auto-registered by the server.
 */

export { AgeVerification } from "./age-verification.js";
export { CredentialProof } from "./credential-proof.js";
