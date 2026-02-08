/**
 * Credential Proof - Prove possession of valid credential
 */

import type {
  Proof,
  ProofConfig,
  CredentialProofInput,
  CredentialProofOutput,
} from "../types.js";

export class CredentialProof {
  constructor(private readonly _config: ProofConfig) {
    // Config reserved for future Midnight SDK integration
    void this._config;
  }

  /**
   * Generate a credential verification proof
   *
   * Proves: Has valid, unexpired credential of specified type
   * Reveals: credential type, issuer public key, validity
   * Hides: credential hash, signature, specific details
   */
  async generate(input: CredentialProofInput): Promise<Proof> {
    const currentTimestamp = Math.floor(Date.now() / 1000);

    // Check validity (this logic runs privately in the circuit)
    const notExpired = input.expiryTimestamp > currentTimestamp;

    // TODO: Verify issuer signature cryptographically
    const validSignature = input.issuerSignature.length > 0;

    const valid = notExpired && validSignature;

    // TODO: Integrate with Midnight SDK for actual ZKP generation
    const proof: Proof = {
      proof: this.generatePlaceholderProof(),
      publicSignals: {
        valid,
        credentialType: input.credentialType,
        issuerPublicKey: input.issuerPublicKey,
      } satisfies CredentialProofOutput,
      verificationKey: "credential_proof_vk_placeholder",
      circuitId: "credential_proof",
      timestamp: new Date(),
    };

    return proof;
  }

  /**
   * Verify a credential proof
   *
   * Checks structure validity of public signals. On-chain verification
   * (when available) would additionally check txId/contractAddress.
   */
  async verify(proof: Proof): Promise<boolean> {
    if (proof.circuitId !== "credential_proof") {
      throw new Error("Invalid circuit ID for credential proof");
    }

    const signals = proof.publicSignals as unknown as CredentialProofOutput;

    // Validate required structure fields
    const structureValid =
      typeof signals.valid === "boolean" &&
      typeof signals.credentialType === "string" &&
      signals.credentialType.length > 0 &&
      typeof signals.issuerPublicKey === "string" &&
      signals.issuerPublicKey.length > 0;

    if (!structureValid) {
      return false;
    }

    // The proof's own validity flag must be true
    if (!signals.valid) {
      return false;
    }

    // If proof has on-chain metadata, it needs indexer verification
    // (not yet implemented for credential proofs)
    if (proof.txId && proof.contractAddress) {
      throw new Error(
        "On-chain credential proof verification is not yet implemented"
      );
    }

    return true;
  }

  private generatePlaceholderProof(): string {
    return Buffer.from(
      JSON.stringify({
        type: "credential_proof",
        version: "1.0",
        placeholder: true,
      })
    ).toString("base64");
  }
}
