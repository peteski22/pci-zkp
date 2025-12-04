/**
 * PCI ZKP SDK
 *
 * Layer 4: Zero-knowledge proofs for Personal Context Infrastructure
 */

export { ProofGenerator } from "./proofs/generator.js";
export { AgeVerification } from "./proofs/age-verification.js";
export { CredentialProof } from "./proofs/credential-proof.js";

// Types
export type {
  Proof,
  ProofConfig,
  AgeProofInput,
  AgeProofOutput,
  CredentialProofInput,
  CredentialProofOutput,
} from "./types.js";
