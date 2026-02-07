/**
 * Age Verification - Prove age without revealing birth date
 *
 * Uses Midnight's Compact contract when network is available,
 * falls back to placeholder proofs for offline/testing scenarios.
 */

import type { Proof, ProofConfig, AgeProofInput } from "../types.js";
import { getClientState, initializeClient, type MidnightConfig } from "../midnight/client.js";
import { createAgeWitnesses, parseDateForCircuit } from "../midnight/witnesses.js";

export class AgeVerification {
  private initialized = false;
  private useMidnight = false;

  constructor(private readonly config: ProofConfig & MidnightConfig) {}

  /**
   * Initialize the verifier, connecting to Midnight if available
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) {
      return this.useMidnight;
    }

    this.useMidnight = await initializeClient(this.config);
    this.initialized = true;

    return this.useMidnight;
  }

  /**
   * Generate an age verification proof
   *
   * Proves: age >= minAge
   * Reveals: minAge threshold, whether verified, requesterDid (if provided)
   * Hides: exact birth date
   *
   * Accepts either typed input or raw API input with birthDate as string
   */
  async generate(input: AgeProofInput | { birthDate?: string; minAge?: number; requesterDid?: string }): Promise<Proof> {
    // Parse input - handle both Date objects and ISO strings
    const birthDate = input.birthDate instanceof Date
      ? input.birthDate
      : input.birthDate
        ? (() => {
            // Parse date-only strings (YYYY-MM-DD) as local dates to avoid
            // timezone shift: new Date("YYYY-MM-DD") parses as UTC midnight,
            // which rolls back a day in negative UTC offsets (e.g. EST).
            const parts = input.birthDate!.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (parts) {
              return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
            }
            return new Date(input.birthDate!);
          })()
        : null;

    if (!birthDate || isNaN(birthDate.getTime())) {
      return {
        proof: "",
        publicSignals: { verified: false, error: "Invalid or missing birth date" },
        verificationKey: "",
        circuitId: "age_verification",
        timestamp: new Date(),
      };
    }

    const minAge = input.minAge ?? 18;
    // Use provided currentDate or default to now
    const currentDate = ('currentDate' in input && input.currentDate instanceof Date)
      ? input.currentDate
      : new Date();

    // Ensure initialized
    await this.initialize();

    // Try to use Midnight network if available
    const clientState = getClientState();
    if (clientState.connected && clientState.providers) {
      return this.generateWithMidnight(birthDate, minAge, currentDate, input.requesterDid);
    }

    // Fall back to placeholder proof
    return this.generatePlaceholder(birthDate, minAge, currentDate, input.requesterDid);
  }

  /**
   * Generate proof using real Midnight network
   */
  private async generateWithMidnight(
    birthDate: Date,
    minAge: number,
    currentDate: Date,
    requesterDid?: string
  ): Promise<Proof> {
    // Prepare circuit inputs (used when full Midnight integration is complete)
    const current = parseDateForCircuit(currentDate);
    const witnesses = createAgeWitnesses(birthDate);
    const circuitInputs = {
      minAge: BigInt(minAge),
      currentYear: current.year,
      currentMonth: current.month,
      currentDay: current.day,
    };

    // Mark as intentionally unused until full integration
    void witnesses;
    void circuitInputs;

    // TODO: Full Midnight contract deployment and circuit execution
    // This requires:
    // 1. Deploy or connect to existing contract instance
    // 2. Call verifyAge circuit with witnesses and public inputs
    // 3. Extract proof and ledger state from transaction result
    //
    // For now, generate a "real-network-pending" proof that indicates
    // the infrastructure is ready but contract interaction needs runtime testing

    // Calculate the expected result (for the proof structure)
    const birthYear = birthDate.getFullYear();
    const birthMonth = birthDate.getMonth() + 1;
    const birthDay = birthDate.getDate();

    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1;
    const currentDay = currentDate.getDate();

    let age = currentYear - birthYear;
    const birthdayPassed =
      currentMonth > birthMonth ||
      (currentMonth === birthMonth && currentDay >= birthDay);
    if (!birthdayPassed) {
      age--;
    }

    const verified = age >= minAge;

    const publicSignals: Record<string, unknown> = {
      verified,
      minAge,
      network: "midnight",
    };

    if (requesterDid) {
      publicSignals.requesterDid = requesterDid;
    }

    return {
      proof: this.generateMidnightProofData(verified, minAge),
      publicSignals,
      verificationKey: "age_verification_vk_midnight",
      circuitId: "age_verification",
      timestamp: new Date(),
    };
  }

  /**
   * Generate placeholder proof (when Midnight not available)
   */
  private generatePlaceholder(
    birthDate: Date,
    minAge: number,
    currentDate: Date,
    requesterDid?: string
  ): Proof {
    // Calculate age (this is done privately in the circuit)
    const birthYear = birthDate.getFullYear();
    const birthMonth = birthDate.getMonth();
    const birthDay = birthDate.getDate();

    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth();
    const currentDay = currentDate.getDate();

    let age = currentYear - birthYear;
    const birthdayPassed =
      currentMonth > birthMonth ||
      (currentMonth === birthMonth && currentDay >= birthDay);
    if (!birthdayPassed) {
      age--;
    }

    const verified = age >= minAge;

    // Build public signals - includes requesterDid if provided (binds proof to identity)
    const publicSignals: Record<string, unknown> = {
      verified,
      minAge,
      network: "mocked",
    };

    // Include requesterDid in public signals if provided
    // This binds the proof to a specific ephemeral DID
    if (requesterDid) {
      publicSignals.requesterDid = requesterDid;
    }

    return {
      proof: this.generatePlaceholderProofData(),
      publicSignals,
      verificationKey: "age_verification_vk_placeholder",
      circuitId: "age_verification",
      timestamp: new Date(),
    };
  }

  /**
   * Verify an age verification proof
   *
   * @param proof The proof to verify
   * @param expectedDid Optional DID to verify the proof is bound to
   */
  async verify(proof: Proof, expectedDid?: string): Promise<boolean> {
    if (proof.circuitId !== "age_verification") {
      throw new Error("Invalid circuit ID for age verification");
    }

    const signals = proof.publicSignals as {
      verified?: boolean;
      minAge?: number;
      requesterDid?: string;
      network?: string;
    };

    // Check basic structure
    const structureValid =
      typeof signals.verified === "boolean" &&
      typeof signals.minAge === "number";

    if (!structureValid) {
      return false;
    }

    // If expectedDid provided, verify the proof is bound to it
    if (expectedDid && signals.requesterDid !== expectedDid) {
      return false;
    }

    // If proof was generated with Midnight, verify cryptographically
    if (signals.network === "midnight") {
      return this.verifyMidnightProof(proof);
    }

    // Placeholder proofs are trusted for testing
    return true;
  }

  /**
   * Verify a Midnight-generated proof
   *
   * WARNING: This is currently a stub that always returns true.
   * Real cryptographic verification is not yet implemented.
   *
   * TODO: Implement actual ZKP verification via Midnight SDK:
   * 1. Import and invoke Midnight SDK's proof verification API
   * 2. Validate proof structure before calling SDK
   * 3. Use appropriate verification key/params for the circuit
   * 4. Return SDK's boolean result (false on verification failure)
   * 5. Handle errors gracefully without leaking sensitive data
   *
   * @see https://docs.midnight.network/ for SDK documentation
   */
  private async verifyMidnightProof(_proof: Proof): Promise<boolean> {
    // SECURITY: This stub always returns true - do not use in production
    // until real verification is implemented
    return true;
  }

  private generatePlaceholderProofData(): string {
    return Buffer.from(
      JSON.stringify({
        type: "age_verification",
        version: "1.0",
        placeholder: true,
      })
    ).toString("base64");
  }

  private generateMidnightProofData(verified: boolean, minAge: number): string {
    return Buffer.from(
      JSON.stringify({
        type: "age_verification",
        version: "1.0",
        network: "midnight",
        verified,
        minAge,
        // In production, this would be the actual ZK proof bytes
        pendingFullIntegration: true,
      })
    ).toString("base64");
  }
}
