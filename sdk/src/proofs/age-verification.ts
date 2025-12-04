/**
 * Age Verification - Prove age without revealing birth date
 */

import type { Proof, ProofConfig, AgeProofInput, AgeProofOutput } from "../types.js";

export class AgeVerification {
  constructor(private readonly _config: ProofConfig) {
    // Config reserved for future Midnight SDK integration
    void this._config;
  }

  /**
   * Generate an age verification proof
   *
   * Proves: age >= minAge
   * Reveals: minAge threshold, whether verified
   * Hides: exact birth date
   */
  async generate(input: AgeProofInput): Promise<Proof> {
    const currentDate = input.currentDate ?? new Date();

    // Calculate age (this is done privately in the circuit)
    const birthYear = input.birthDate.getFullYear();
    const birthMonth = input.birthDate.getMonth();
    const birthDay = input.birthDate.getDate();

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

    const verified = age >= input.minAge;

    // TODO: Integrate with Midnight SDK for actual ZKP generation
    // For now, return a placeholder proof structure
    const proof: Proof = {
      proof: this.generatePlaceholderProof(),
      publicSignals: {
        verified,
        minAge: input.minAge,
      } satisfies AgeProofOutput,
      verificationKey: "age_verification_vk_placeholder",
      circuitId: "age_verification",
      timestamp: new Date(),
    };

    return proof;
  }

  /**
   * Verify an age verification proof
   */
  async verify(proof: Proof): Promise<boolean> {
    if (proof.circuitId !== "age_verification") {
      throw new Error("Invalid circuit ID for age verification");
    }

    // TODO: Implement actual ZKP verification via Midnight SDK
    // For now, just check that the proof structure is valid
    const signals = proof.publicSignals as unknown as AgeProofOutput;
    return (
      typeof signals.verified === "boolean" &&
      typeof signals.minAge === "number"
    );
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
