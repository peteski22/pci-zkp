/**
 * Proof Generator - Main interface for generating ZK proofs
 */

import type { Proof, ProofConfig, AgeProofInput, CredentialProofInput } from "../types.js";
import { AgeVerification } from "./age-verification.js";
import { CredentialProof } from "./credential-proof.js";

export class ProofGenerator {
  private config: ProofConfig;
  private ageVerification: AgeVerification;
  private credentialProof: CredentialProof;

  constructor(config: ProofConfig = {}) {
    this.config = {
      timeoutMs: 30000,
      ...config,
    };

    this.ageVerification = new AgeVerification(this.config);
    this.credentialProof = new CredentialProof(this.config);
  }

  /**
   * Generate an age verification proof
   */
  async generateAgeProof(input: AgeProofInput): Promise<Proof> {
    return this.ageVerification.generate(input);
  }

  /**
   * Generate a credential proof
   */
  async generateCredentialProof(input: CredentialProofInput): Promise<Proof> {
    return this.credentialProof.generate(input);
  }

  /**
   * Verify a proof
   */
  async verify(proof: Proof): Promise<boolean> {
    switch (proof.circuitId) {
      case "age_verification":
        return this.ageVerification.verify(proof);
      case "credential_proof":
        return this.credentialProof.verify(proof);
      default:
        throw new Error(`Unknown circuit: ${proof.circuitId}`);
    }
  }
}
