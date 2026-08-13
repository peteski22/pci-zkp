/**
 * Credential Proof - Prove possession of valid credential
 */

import { createPublicKey, verify as verifySignature } from "node:crypto";
import type {
  Proof,
  ProofConfig,
  CredentialProofInput,
  CredentialProofOutput,
} from "../types.js";
import { isOnChainProof } from "../types.js";

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

function decodeHex(value: string, expectedBytes: number): Buffer | null {
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length !== expectedBytes * 2) {
    return null;
  }
  return Buffer.from(value, "hex");
}

export class CredentialProof {
  constructor(private readonly config: ProofConfig) {}

  /**
   * Generate a credential verification proof
   *
   * Proves: Has valid, unexpired credential of specified type, signed by
   * its issuer (Ed25519 signature over the credential hash)
   * Reveals: credential type, issuer public key, validity
   * Hides: credential hash, signature, specific details
   */
  async generate(input: CredentialProofInput): Promise<Proof> {
    const currentTimestamp = Math.floor(Date.now() / 1000);

    // Check validity (this logic runs privately in the circuit)
    const notExpired = input.expiryTimestamp > currentTimestamp;
    const validSignature = this.verifyIssuerSignature(input);
    const trustedIssuer = this.isTrustedIssuer(input.issuerPublicKey);

    const valid = notExpired && validSignature && trustedIssuer;

    // TODO: Integrate with Midnight SDK for actual ZKP generation
    const proof: Proof = {
      verificationMethod: "offline",
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

    // If proof has on-chain metadata, it needs indexer verification.
    // Not yet implemented for credential proofs — reject rather than throw
    // so callers can rely on the Promise<boolean> contract.
    if (isOnChainProof(proof)) {
      return false;
    }

    return true;
  }

  private verifyIssuerSignature(input: CredentialProofInput): boolean {
    const publicKeyBytes = decodeHex(input.issuerPublicKey, ED25519_PUBLIC_KEY_BYTES);
    const signatureBytes = decodeHex(input.issuerSignature, ED25519_SIGNATURE_BYTES);
    if (publicKeyBytes === null || signatureBytes === null) {
      return false;
    }

    try {
      const issuerKey = createPublicKey({
        key: {
          kty: "OKP",
          crv: "Ed25519",
          x: publicKeyBytes.toString("base64url"),
        },
        format: "jwk",
      });
      return verifySignature(
        null,
        Buffer.from(input.credentialHash, "utf8"),
        issuerKey,
        signatureBytes
      );
    } catch {
      return false;
    }
  }

  private isTrustedIssuer(issuerPublicKey: string): boolean {
    const registry = this.config.trustedIssuers;
    if (registry === undefined) {
      return true;
    }
    const normalized = issuerPublicKey.toLowerCase();
    return registry.some((key) => key.toLowerCase() === normalized);
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
