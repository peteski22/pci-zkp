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

function isNonEmptyString(value: string): boolean {
  return typeof value === "string" && value.length > 0;
}

function decodeHex(value: string, expectedBytes: number): Buffer | null {
  if (typeof value !== "string" || !/^[0-9a-fA-F]+$/.test(value)) {
    return null;
  }
  if (value.length !== expectedBytes * 2) {
    return null;
  }
  return Buffer.from(value, "hex");
}

/**
 * Canonicalize configured issuer keys to lowercase hex, rejecting malformed
 * entries. A mistyped allow-list would otherwise be indistinguishable at proof
 * time from an issuer that is genuinely untrusted.
 */
function normalizeTrustedIssuers(issuers?: string[]): ReadonlySet<string> | undefined {
  if (issuers === undefined) {
    return undefined;
  }

  return new Set(
    issuers.map((issuer, index) => {
      const keyBytes = decodeHex(issuer, ED25519_PUBLIC_KEY_BYTES);
      if (keyBytes === null) {
        throw new Error(
          `Trusted issuer at index ${index} is not a hex-encoded ${ED25519_PUBLIC_KEY_BYTES}-byte Ed25519 public key`
        );
      }
      return keyBytes.toString("hex");
    })
  );
}

function isCredentialProofOutput(signals: unknown): signals is CredentialProofOutput {
  const candidate = signals as Partial<CredentialProofOutput>;
  return (
    typeof candidate?.valid === "boolean" &&
    typeof candidate.credentialType === "string" &&
    candidate.credentialType.length > 0 &&
    typeof candidate.issuerPublicKey === "string" &&
    decodeHex(candidate.issuerPublicKey, ED25519_PUBLIC_KEY_BYTES) !== null
  );
}

export class CredentialProof {
  /** Trusted issuer keys, canonicalized to lowercase hex. */
  private readonly trustedIssuers?: ReadonlySet<string>;

  constructor(config: ProofConfig) {
    this.trustedIssuers = normalizeTrustedIssuers(config.trustedIssuers);
  }

  /**
   * Generate a credential verification proof
   *
   * Checks, at generation time, that issuerSignature is a valid Ed25519
   * signature by issuerPublicKey over the UTF-8 bytes of credentialHash,
   * that the credential has not expired, and — when config.trustedIssuers
   * is set — that the issuer is listed.
   *
   * credentialType and expiryTimestamp are NOT covered by the signature:
   * they are asserted by the caller, so `valid` does not mean the issuer
   * attested to them.
   *
   * Reveals: credential type, issuer public key, validity
   * Hides: credential hash, signature, specific details
   *
   * The returned proof is a placeholder: its public signals are not
   * cryptographically bound to anything and MUST NOT be relied upon by a
   * relying party until circuit integration lands.
   */
  async generate(input: CredentialProofInput): Promise<Proof> {
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const issuerPublicKeyBytes = decodeHex(input.issuerPublicKey, ED25519_PUBLIC_KEY_BYTES);

    // One key has one public representation, regardless of input casing.
    const issuerPublicKey = issuerPublicKeyBytes?.toString("hex") ?? input.issuerPublicKey;

    // Check validity (this logic runs privately in the circuit)
    const notExpired =
      Number.isInteger(input.expiryTimestamp) && input.expiryTimestamp > currentTimestamp;
    const wellFormed = isNonEmptyString(input.credentialType) && isNonEmptyString(input.credentialHash);
    const validSignature =
      issuerPublicKeyBytes !== null && this.verifyIssuerSignature(input, issuerPublicKeyBytes);

    const valid =
      notExpired && wellFormed && validSignature && this.isTrustedIssuer(issuerPublicKey);

    // TODO: Integrate with Midnight SDK for actual ZKP generation
    const proof: Proof = {
      verificationMethod: "offline",
      proof: this.generatePlaceholderProof(),
      publicSignals: {
        valid,
        credentialType: input.credentialType,
        issuerPublicKey,
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
   *
   * This does NOT re-check the issuer signature: the signature is a private
   * input, verified only when the proof is generated. An offline placeholder
   * proof is therefore self-attested — anyone can construct one whose signals
   * claim validity — and carries no guarantee for a relying party until
   * circuit integration lands.
   */
  async verify(proof: Proof): Promise<boolean> {
    if (proof.circuitId !== "credential_proof") {
      throw new Error("Invalid circuit ID for credential proof");
    }

    if (!isCredentialProofOutput(proof.publicSignals)) {
      return false;
    }

    // The proof's own validity flag must be true
    if (!proof.publicSignals.valid) {
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

  private verifyIssuerSignature(
    input: CredentialProofInput,
    publicKeyBytes: Buffer
  ): boolean {
    const signatureBytes = decodeHex(input.issuerSignature, ED25519_SIGNATURE_BYTES);
    if (signatureBytes === null) {
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

  private isTrustedIssuer(canonicalIssuerKey: string): boolean {
    return this.trustedIssuers?.has(canonicalIssuerKey) ?? true;
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
