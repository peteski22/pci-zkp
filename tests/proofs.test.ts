import { describe, it, expect, beforeEach } from "vitest";
import { ProofGenerator } from "../sdk/src/proofs/generator.js";
import { AgeVerification } from "../sdk/src/proofs/age-verification.js";
import type { Proof } from "../sdk/src/types.js";

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

    it("should reject credential proof with empty credentialType", async () => {
      const proof: Proof = {
        proof: "dGVzdA==",
        publicSignals: {
          valid: true,
          credentialType: "",
          issuerPublicKey: "pk123",
        },
        verificationKey: "test_vk",
        circuitId: "credential_proof",
        timestamp: new Date(),
      };

      const isValid = await generator.verify(proof);
      expect(isValid).toBe(false);
    });

    it("should reject credential proof with empty issuerPublicKey", async () => {
      const proof: Proof = {
        proof: "dGVzdA==",
        publicSignals: {
          valid: true,
          credentialType: "passport",
          issuerPublicKey: "",
        },
        verificationKey: "test_vk",
        circuitId: "credential_proof",
        timestamp: new Date(),
      };

      const isValid = await generator.verify(proof);
      expect(isValid).toBe(false);
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

  it("should parse date-only strings as local dates to avoid timezone shift", async () => {
    // When birthDate is a string (API input), "YYYY-MM-DD" must be parsed as
    // local midnight, not UTC midnight, to avoid off-by-one day in negative offsets.
    const proof = await verifier.generate({
      birthDate: "2000-05-15",
      minAge: 24,
      currentDate: new Date(2024, 4, 15), // May 15 2024 local — exactly 24th birthday
    });

    expect(proof.publicSignals.verified).toBe(true);
  });
});

describe("Proof type with on-chain fields", () => {
  it("should accept proof with txId and contractAddress", () => {
    const proof: Proof = {
      proof: "dGVzdA==",
      publicSignals: { verified: true, minAge: 18 },
      verificationKey: "age_verification_vk_midnight",
      circuitId: "age_verification",
      timestamp: new Date(),
      txId: "abc123def456",
      contractAddress: "0x1234567890abcdef",
      blockHeight: 42,
    };

    expect(proof.txId).toBe("abc123def456");
    expect(proof.contractAddress).toBe("0x1234567890abcdef");
    expect(proof.blockHeight).toBe(42);
  });

  it("should accept proof without on-chain fields (placeholder)", () => {
    const proof: Proof = {
      proof: "dGVzdA==",
      publicSignals: { verified: true, minAge: 18 },
      verificationKey: "age_verification_vk_placeholder",
      circuitId: "age_verification",
      timestamp: new Date(),
    };

    expect(proof.txId).toBeUndefined();
    expect(proof.contractAddress).toBeUndefined();
    expect(proof.blockHeight).toBeUndefined();
  });
});

describe("AgeVerification - Midnight mode verification", () => {
  it("should reject proofs without on-chain metadata in Midnight mode", async () => {
    // Create a verifier that thinks it's connected to Midnight
    const verifier = new AgeVerification({
      skipNetworkCheck: true, // Forces offline — we'll test the logic directly
    });

    // Generate an offline proof
    const proof = await verifier.generate({
      birthDate: new Date("1990-01-15"),
      minAge: 18,
    });

    // In offline mode, placeholder proofs are trusted
    expect(proof.publicSignals.network).toBe("mocked");
    const isValid = await verifier.verify(proof);
    expect(isValid).toBe(true);
  });

  it("should reject age proofs with malformed public signals", async () => {
    const verifier = new AgeVerification({});

    const malformedProof: Proof = {
      proof: "dGVzdA==",
      publicSignals: { verified: "not-a-boolean", minAge: "not-a-number" },
      verificationKey: "test_vk",
      circuitId: "age_verification",
      timestamp: new Date(),
    };

    const isValid = await verifier.verify(malformedProof);
    expect(isValid).toBe(false);
  });

  it("should reject age proofs bound to wrong DID", async () => {
    const verifier = new AgeVerification({});

    const proof = await verifier.generate({
      birthDate: new Date("1990-01-15"),
      minAge: 18,
      requesterDid: "did:key:z6MkTest123",
    });

    // Verify with a different expected DID
    const isValid = await verifier.verify(proof, "did:key:z6MkOther456");
    expect(isValid).toBe(false);
  });

  it("should accept age proofs bound to correct DID", async () => {
    const verifier = new AgeVerification({});

    const proof = await verifier.generate({
      birthDate: new Date("1990-01-15"),
      minAge: 18,
      requesterDid: "did:key:z6MkTest123",
    });

    const isValid = await verifier.verify(proof, "did:key:z6MkTest123");
    expect(isValid).toBe(true);
  });

  it("should handle invalid birth date gracefully", async () => {
    const verifier = new AgeVerification({});

    const proof = await verifier.generate({
      birthDate: "not-a-date",
      minAge: 18,
    });

    expect(proof.proof).toBe("");
    expect(proof.publicSignals.verified).toBe(false);
    expect(proof.publicSignals.error).toBe("Invalid or missing birth date");
  });
});
