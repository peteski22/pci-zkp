/**
 * Type definitions for PCI ZKP SDK
 */

interface ProofBase {
  /** Serialized proof data */
  proof: string;
  /** Public signals/outputs */
  publicSignals: Record<string, unknown>;
  /** Verification key */
  verificationKey: string;
  /** Circuit identifier */
  circuitId: string;
  /** Generation timestamp */
  timestamp: Date;
}

/** Proof generated offline or via placeholder — no on-chain metadata. */
export interface OfflineProof extends ProofBase {
  verificationMethod: "offline";
}

/** Proof verified on-chain — contains transaction and contract metadata. */
export interface OnChainProof extends ProofBase {
  verificationMethod: "on-chain";
  /** Midnight transaction ID */
  txId: string;
  /** Contract address for this specific proof interaction */
  contractAddress: string;
  /** Block height where proof was confirmed */
  blockHeight: number;
}

export type Proof = OfflineProof | OnChainProof;

/** Type guard: is this an on-chain proof? */
export function isOnChainProof(p: Proof): p is OnChainProof {
  return p.verificationMethod === "on-chain";
}

export interface ProofConfig {
  /** Proof server endpoint (if using remote prover) */
  proverEndpoint?: string;
  /** Network ID for Midnight */
  networkId?: string;
  /** Timeout for proof generation (ms) */
  timeoutMs?: number;
  /**
   * Trusted credential issuers: hex-encoded 32-byte Ed25519 public keys.
   *
   * Generation-time policy: credential proofs generated for issuers outside
   * this list are marked invalid. It is not enforced when verifying a proof.
   * An empty list therefore rejects every issuer; omitting the field accepts
   * any issuer whose signature is valid. Malformed entries are rejected when
   * the proof generator is constructed.
   */
  trustedIssuers?: string[];
}

// Age Verification
export interface AgeProofInput {
  /** Birth date (kept secret) */
  birthDate: Date;
  /** Minimum age to prove */
  minAge: number;
  /** Current date (defaults to now) */
  currentDate?: Date;
  /** Requester's ephemeral DID (proof bound to this identity) */
  requesterDid?: string;
}

export interface AgeProofOutput {
  /** Whether age >= minAge */
  verified: boolean;
  /** The minimum age that was proven */
  minAge: number;
  /** The DID the proof is bound to (if provided) */
  requesterDid?: string;
}

// Credential Proof
export interface CredentialProofInput {
  /** Credential hash (kept secret); the signed message */
  credentialHash: string;
  /** Credential expiry timestamp, in seconds since the epoch */
  expiryTimestamp: number;
  /**
   * Issuer's signature (kept secret): a hex-encoded 64-byte Ed25519
   * signature over the UTF-8 bytes of credentialHash. It covers only the
   * hash — credentialType and expiryTimestamp are asserted by the caller.
   */
  issuerSignature: string;
  /** Issuer's public key: a hex-encoded 32-byte Ed25519 public key */
  issuerPublicKey: string;
  /** Type of credential being proven */
  credentialType: string;
}

export interface CredentialProofOutput {
  /** Whether credential is valid */
  valid: boolean;
  /** Credential type */
  credentialType: string;
  /** Issuer public key, canonical lowercase hex */
  issuerPublicKey: string;
}

// Range Proof
export interface RangeProofInput {
  /** The secret value */
  value: number;
  /** Minimum of range */
  minValue: number;
  /** Maximum of range */
  maxValue: number;
}

export interface RangeProofOutput {
  /** Whether value is in range */
  inRange: boolean;
  /** The range that was checked */
  range: { min: number; max: number };
}
