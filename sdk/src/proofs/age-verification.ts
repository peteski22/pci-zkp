/**
 * Age Verification - Prove age without revealing birth date
 */

import type { Proof, ProofConfig, AgeProofInput } from "../types.js";

export class AgeVerification {
  constructor(private readonly _config: ProofConfig) {
    // Config reserved for future Midnight SDK integration
    void this._config;
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
        ? new Date(input.birthDate)
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
    };

    // Include requesterDid in public signals if provided
    // This binds the proof to a specific ephemeral DID
    if (input.requesterDid) {
      publicSignals.requesterDid = input.requesterDid;
    }

    // TODO: Integrate with Midnight SDK for actual ZKP generation
    // For now, return a placeholder proof structure
    const proof: Proof = {
      proof: this.generatePlaceholderProof(),
      publicSignals,
      verificationKey: "age_verification_vk_placeholder",
      circuitId: "age_verification",
      timestamp: new Date(),
    };

    return proof;
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

    // TODO: Implement actual ZKP verification via Midnight SDK
    // For now, just check that the proof structure is valid
    const signals = proof.publicSignals as { verified?: boolean; minAge?: number; requesterDid?: string };

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

    return true;
  }

  private generatePlaceholderProof(): string {
    // Placeholder - in production this would be actual ZKP data
    return Buffer.from(
      JSON.stringify({
        type: "age_verification",
        version: "1.0",
        placeholder: true,
      })
    ).toString("base64");
  }
}
