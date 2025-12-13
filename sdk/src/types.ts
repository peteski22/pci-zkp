/**
 * Type definitions for PCI ZKP SDK
 */

export interface Proof {
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

export interface ProofConfig {
  /** Proof server endpoint (if using remote prover) */
  proverEndpoint?: string;
  /** Network ID for Midnight */
  networkId?: string;
  /** Timeout for proof generation (ms) */
  timeoutMs?: number;
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
  /** Credential hash (kept secret) */
  credentialHash: string;
  /** Credential expiry timestamp */
  expiryTimestamp: number;
  /** Issuer's signature (kept secret) */
  issuerSignature: string;
  /** Issuer's public key */
  issuerPublicKey: string;
  /** Type of credential being proven */
  credentialType: string;
}

export interface CredentialProofOutput {
  /** Whether credential is valid */
  valid: boolean;
  /** Credential type */
  credentialType: string;
  /** Issuer public key */
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
