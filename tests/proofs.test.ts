import { describe, it, expect, beforeEach } from "vitest";
import { ProofGenerator } from "../sdk/src/proofs/generator.js";
import { AgeVerification } from "../sdk/src/proofs/age-verification.js";

describe("ProofGenerator", () => {
  let generator: ProofGenerator;

  beforeEach(() => {
    generator = new ProofGenerator();
  });

  describe("age verification", () => {
    it("should generate proof for age over threshold", async () => {
      const proof = await generator.generateAgeProof({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      expect(proof.circuitId).toBe("age_verification");
      expect(proof.publicSignals.verified).toBe(true);
      expect(proof.publicSignals.minAge).toBe(18);
    });

    it("should generate proof for age under threshold", async () => {
      // Someone born recently
      const proof = await generator.generateAgeProof({
        birthDate: new Date("2020-01-15"),
        minAge: 18,
      });

      expect(proof.publicSignals.verified).toBe(false);
    });

    it("should handle custom current date", async () => {
      const proof = await generator.generateAgeProof({
        birthDate: new Date("2000-06-15"),
        minAge: 21,
        currentDate: new Date("2021-01-01"), // Before 21st birthday
      });

      expect(proof.publicSignals.verified).toBe(false);
    });
  });

  describe("credential verification", () => {
    it("should generate proof for valid credential", async () => {
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: Math.floor(Date.now() / 1000) + 86400, // Tomorrow
        issuerSignature: "sig123",
        issuerPublicKey: "pk123",
        credentialType: "driver_license",
      });

      expect(proof.circuitId).toBe("credential_proof");
      expect(proof.publicSignals.valid).toBe(true);
      expect(proof.publicSignals.credentialType).toBe("driver_license");
    });

    it("should generate proof for expired credential", async () => {
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: Math.floor(Date.now() / 1000) - 86400, // Yesterday
        issuerSignature: "sig123",
        issuerPublicKey: "pk123",
        credentialType: "driver_license",
      });

      expect(proof.publicSignals.valid).toBe(false);
    });
  });

  describe("proof verification", () => {
    it("should verify age proof", async () => {
      const proof = await generator.generateAgeProof({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      const isValid = await generator.verify(proof);
      expect(isValid).toBe(true);
    });

    it("should verify credential proof", async () => {
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: Math.floor(Date.now() / 1000) + 86400,
        issuerSignature: "sig123",
        issuerPublicKey: "pk123",
        credentialType: "passport",
      });

      const isValid = await generator.verify(proof);
      expect(isValid).toBe(true);
    });
  });
});

describe("AgeVerification", () => {
  let verifier: AgeVerification;

  beforeEach(() => {
    verifier = new AgeVerification({});
  });

  it("should correctly calculate age accounting for birthday", async () => {
    // Born Dec 15, checking on Dec 1 - should be one year younger
    const proof = await verifier.generate({
      birthDate: new Date("2000-12-15"),
      minAge: 24,
      currentDate: new Date("2024-12-01"),
    });

    // Age is 23 (birthday hasn't passed)
    expect(proof.publicSignals.verified).toBe(false);
  });

  it("should correctly calculate age after birthday", async () => {
    // Born Dec 15, checking on Dec 20 - birthday has passed
    const proof = await verifier.generate({
      birthDate: new Date("2000-12-15"),
      minAge: 24,
      currentDate: new Date("2024-12-20"),
    });

    // Age is 24
    expect(proof.publicSignals.verified).toBe(true);
  });
});
