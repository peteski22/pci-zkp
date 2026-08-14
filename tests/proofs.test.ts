import { generateKeyPairSync, sign as signMessage } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProofGenerator } from "../sdk/src/proofs/generator.js";
import { AgeVerification } from "../sdk/src/proofs/age-verification.js";
import type { Proof, OnChainProof } from "../sdk/src/types.js";
import { isOnChainProof } from "../sdk/src/types.js";
import * as client from "../sdk/src/midnight/client.js";

// Test issuer: real Ed25519 keypair that signs credential hashes the way
// a PCI credential issuer would. The key is exported as JWK to mirror the
// import the implementation uses.
function createIssuer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { x } = publicKey.export({ format: "jwk" });
  const publicKeyHex = Buffer.from(x as string, "base64url").toString("hex");
  const signCredential = (credentialHash: string): string =>
    signMessage(null, Buffer.from(credentialHash, "utf8"), privateKey).toString("hex");
  return { publicKeyHex, signCredential };
}

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
      const issuer = createIssuer();
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: Math.floor(Date.now() / 1000) + 86400, // Tomorrow
        issuerSignature: issuer.signCredential("hash123"),
        issuerPublicKey: issuer.publicKeyHex,
        credentialType: "driver_license",
      });

      expect(proof.circuitId).toBe("credential_proof");
      expect(proof.publicSignals.valid).toBe(true);
      expect(proof.publicSignals.credentialType).toBe("driver_license");
    });

    it("should generate proof for expired credential", async () => {
      const issuer = createIssuer();
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: Math.floor(Date.now() / 1000) - 86400, // Yesterday
        issuerSignature: issuer.signCredential("hash123"),
        issuerPublicKey: issuer.publicKeyHex,
        credentialType: "driver_license",
      });

      expect(proof.publicSignals.valid).toBe(false);
    });
  });

  describe("credential issuer signature verification", () => {
    const expiry = () => Math.floor(Date.now() / 1000) + 86400;

    it("should reject signature made by a different key", async () => {
      const issuer = createIssuer();
      const impostor = createIssuer();
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: expiry(),
        issuerSignature: impostor.signCredential("hash123"),
        issuerPublicKey: issuer.publicKeyHex,
        credentialType: "driver_license",
      });

      expect(proof.publicSignals.valid).toBe(false);
    });

    it("should reject signature over a different credential hash", async () => {
      const issuer = createIssuer();
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: expiry(),
        issuerSignature: issuer.signCredential("other-hash"),
        issuerPublicKey: issuer.publicKeyHex,
        credentialType: "driver_license",
      });

      expect(proof.publicSignals.valid).toBe(false);
    });

    it("should reject malformed signature", async () => {
      const issuer = createIssuer();
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: expiry(),
        issuerSignature: "not-hex-at-all",
        issuerPublicKey: issuer.publicKeyHex,
        credentialType: "driver_license",
      });

      expect(proof.publicSignals.valid).toBe(false);
    });

    it("should reject malformed public key", async () => {
      const issuer = createIssuer();
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: expiry(),
        issuerSignature: issuer.signCredential("hash123"),
        issuerPublicKey: "deadbeef", // Too short for an Ed25519 key
        credentialType: "driver_license",
      });

      expect(proof.publicSignals.valid).toBe(false);
    });

    it("should reject signature of the wrong length", async () => {
      const issuer = createIssuer();
      const truncated = issuer.signCredential("hash123").slice(0, 126);
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: expiry(),
        issuerSignature: truncated,
        issuerPublicKey: issuer.publicKeyHex,
        credentialType: "driver_license",
      });

      expect(proof.publicSignals.valid).toBe(false);
    });

    it("should reject a well-formed key that is not a valid Ed25519 point", async () => {
      const issuer = createIssuer();
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: expiry(),
        issuerSignature: issuer.signCredential("hash123"),
        issuerPublicKey: "ff".repeat(32),
        credentialType: "driver_license",
      });

      expect(proof.publicSignals.valid).toBe(false);
    });

    it("should publish the issuer key in canonical lowercase hex", async () => {
      const issuer = createIssuer();
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: expiry(),
        issuerSignature: issuer.signCredential("hash123"),
        issuerPublicKey: issuer.publicKeyHex.toUpperCase(),
        credentialType: "driver_license",
      });

      expect(proof.publicSignals.valid).toBe(true);
      expect(proof.publicSignals.issuerPublicKey).toBe(issuer.publicKeyHex.toLowerCase());
    });
  });

  describe("credential input validation", () => {
    const validInput = () => {
      const issuer = createIssuer();
      return {
        credentialHash: "hash123",
        expiryTimestamp: Math.floor(Date.now() / 1000) + 86400,
        issuerSignature: issuer.signCredential("hash123"),
        issuerPublicKey: issuer.publicKeyHex,
        credentialType: "driver_license",
      };
    };

    it("should reject a non-finite expiry timestamp", async () => {
      const proof = await generator.generateCredentialProof({
        ...validInput(),
        expiryTimestamp: Number.NaN,
      });

      expect(proof.publicSignals.valid).toBe(false);
    });

    it("should reject a non-integer expiry timestamp", async () => {
      const proof = await generator.generateCredentialProof({
        ...validInput(),
        expiryTimestamp: "99999999999" as unknown as number,
      });

      expect(proof.publicSignals.valid).toBe(false);
    });

    it("should reject an empty credential type", async () => {
      const proof = await generator.generateCredentialProof({
        ...validInput(),
        credentialType: "",
      });

      // verify() rejects an empty credentialType, so generate() must not
      // claim the credential is valid.
      expect(proof.publicSignals.valid).toBe(false);
    });

    it("should reject an empty credential hash", async () => {
      const proof = await generator.generateCredentialProof({
        ...validInput(),
        credentialHash: "",
      });

      expect(proof.publicSignals.valid).toBe(false);
    });

    it("should reject missing fields without throwing", async () => {
      // Input arrives from an HTTP layer, so fields may be absent entirely.
      const proof = await generator.generateCredentialProof({
        ...validInput(),
        credentialType: undefined as unknown as string,
        credentialHash: undefined as unknown as string,
      });

      expect(proof.publicSignals.valid).toBe(false);
    });
  });

  describe("trusted issuer registry", () => {
    const expiry = () => Math.floor(Date.now() / 1000) + 86400;

    it("should accept issuer present in the trusted registry", async () => {
      const issuer = createIssuer();
      const trustingGenerator = new ProofGenerator({
        trustedIssuers: [issuer.publicKeyHex.toUpperCase()],
      });
      const proof = await trustingGenerator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: expiry(),
        issuerSignature: issuer.signCredential("hash123"),
        issuerPublicKey: issuer.publicKeyHex,
        credentialType: "driver_license",
      });

      expect(proof.publicSignals.valid).toBe(true);
    });

    it("should reject issuer absent from the trusted registry", async () => {
      const issuer = createIssuer();
      const untrusted = createIssuer();
      const trustingGenerator = new ProofGenerator({
        trustedIssuers: [issuer.publicKeyHex],
      });
      const proof = await trustingGenerator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: expiry(),
        issuerSignature: untrusted.signCredential("hash123"),
        issuerPublicKey: untrusted.publicKeyHex,
        credentialType: "driver_license",
      });

      expect(proof.publicSignals.valid).toBe(false);
    });

    it("should accept any issuer with a valid signature when no registry is configured", async () => {
      const issuer = createIssuer();
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: expiry(),
        issuerSignature: issuer.signCredential("hash123"),
        issuerPublicKey: issuer.publicKeyHex,
        credentialType: "driver_license",
      });

      expect(proof.publicSignals.valid).toBe(true);
    });

    it("should reject every issuer when the registry is empty", async () => {
      const issuer = createIssuer();
      const trustingGenerator = new ProofGenerator({ trustedIssuers: [] });
      const proof = await trustingGenerator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: expiry(),
        issuerSignature: issuer.signCredential("hash123"),
        issuerPublicKey: issuer.publicKeyHex,
        credentialType: "driver_license",
      });

      expect(proof.publicSignals.valid).toBe(false);
    });

    it("should reject a malformed registry entry at construction", () => {
      // A misconfigured allow-list must fail loudly, not silently reject
      // every credential as though the issuer were untrusted.
      expect(() => new ProofGenerator({ trustedIssuers: ["not-a-key"] })).toThrow(
        /trusted issuer/i
      );
    });

    it("should name the offending entry when the registry is malformed", () => {
      const issuer = createIssuer();
      expect(
        () => new ProofGenerator({ trustedIssuers: [issuer.publicKeyHex, "0xdeadbeef"] })
      ).toThrow(/index 1/i);
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
      const issuer = createIssuer();
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: Math.floor(Date.now() / 1000) + 86400,
        issuerSignature: issuer.signCredential("hash123"),
        issuerPublicKey: issuer.publicKeyHex,
        credentialType: "passport",
      });

      const isValid = await generator.verify(proof);
      expect(isValid).toBe(true);
    });

    it("should reject expired credential proof", async () => {
      const issuer = createIssuer();
      const proof = await generator.generateCredentialProof({
        credentialHash: "hash123",
        expiryTimestamp: Math.floor(Date.now() / 1000) - 86400, // Yesterday
        issuerSignature: issuer.signCredential("hash123"),
        issuerPublicKey: issuer.publicKeyHex,
        credentialType: "driver_license",
      });

      // The proof has valid=false because credential is expired
      expect(proof.publicSignals.valid).toBe(false);
      // verify() should reject proofs where valid is false
      const isValid = await generator.verify(proof);
      expect(isValid).toBe(false);
    });

    it("should reject credential proof with empty credentialType", async () => {
      const proof: Proof = {
        verificationMethod: "offline",
        proof: "dGVzdA==",
        publicSignals: {
          valid: true,
          credentialType: "",
          issuerPublicKey: createIssuer().publicKeyHex,
        },
        verificationKey: "test_vk",
        circuitId: "credential_proof",
        timestamp: new Date(),
      };

      const isValid = await generator.verify(proof);
      expect(isValid).toBe(false);
    });

    it("should reject credential proof whose issuerPublicKey is not a 32-byte hex key", async () => {
      const proof: Proof = {
        verificationMethod: "offline",
        proof: "dGVzdA==",
        publicSignals: {
          valid: true,
          credentialType: "passport",
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
        verificationMethod: "offline",
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

describe("Proof discriminated union", () => {
  it("should accept on-chain proof with all required fields", () => {
    const proof: Proof = {
      verificationMethod: "on-chain",
      proof: "dGVzdA==",
      publicSignals: { verified: true, minAge: 18 },
      verificationKey: "age_verification_vk_midnight",
      circuitId: "age_verification",
      timestamp: new Date(),
      txId: "abc123def456",
      contractAddress: "0x1234567890abcdef",
      blockHeight: 42,
    };

    expect(isOnChainProof(proof)).toBe(true);
    if (isOnChainProof(proof)) {
      expect(proof.txId).toBe("abc123def456");
      expect(proof.contractAddress).toBe("0x1234567890abcdef");
      expect(proof.blockHeight).toBe(42);
    }
  });

  it("should accept offline proof without on-chain fields", () => {
    const proof: Proof = {
      verificationMethod: "offline",
      proof: "dGVzdA==",
      publicSignals: { verified: true, minAge: 18 },
      verificationKey: "age_verification_vk_placeholder",
      circuitId: "age_verification",
      timestamp: new Date(),
    };

    expect(isOnChainProof(proof)).toBe(false);
  });
});

describe("AgeVerification - Midnight mode verification", () => {
  it("should accept placeholder proofs in offline mode", async () => {
    const verifier = new AgeVerification({
      forceOffline: true, // Forces offline mode — placeholder proofs are trusted
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
      verificationMethod: "offline",
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

describe("AgeVerification - verifyMidnightProof branches", () => {
  // Helper: build a valid on-chain proof for testing.
  function makeOnChainProof(overrides: Partial<OnChainProof> = {}): Proof {
    return {
      verificationMethod: "on-chain" as const,
      proof: "dGVzdA==",
      publicSignals: { verified: true, minAge: 18 },
      verificationKey: "age_verification_vk_midnight",
      circuitId: "age_verification",
      timestamp: new Date(),
      txId: "tx123",
      contractAddress: "0xcontract",
      blockHeight: 10,
      ...overrides,
    };
  }

  // Force the verifier into Midnight mode via mocks.
  function mockMidnightMode() {
    vi.spyOn(client, "initializeClient").mockResolvedValue(true);
    vi.spyOn(client, "getClientState").mockReturnValue({
      connected: true,
      network: "standalone",
      config: { indexerUrl: "http://localhost:8088" },
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should reject offline proof in Midnight mode", async () => {
    mockMidnightMode();

    const verifier = new AgeVerification({});
    const proof: Proof = {
      verificationMethod: "offline",
      proof: "dGVzdA==",
      publicSignals: { verified: true, minAge: 18 },
      verificationKey: "age_verification_vk_midnight",
      circuitId: "age_verification",
      timestamp: new Date(),
    };

    const isValid = await verifier.verify(proof);
    expect(isValid).toBe(false);
  });

  it("should reject proof when indexer config is missing", async () => {
    vi.spyOn(client, "initializeClient").mockResolvedValue(true);
    vi.spyOn(client, "getClientState").mockReturnValue({
      connected: true,
      network: "standalone",
      config: {},
    });

    const verifier = new AgeVerification({});
    const proof = makeOnChainProof();

    const isValid = await verifier.verify(proof);
    expect(isValid).toBe(false);
  });

  it("should reject proof when contract state is not found", async () => {
    mockMidnightMode();
    vi.spyOn(client, "queryContractState").mockResolvedValue(null);

    const verifier = new AgeVerification({});
    const proof = makeOnChainProof();

    const isValid = await verifier.verify(proof);
    expect(isValid).toBe(false);
  });

  it("should reject proof when contract state has no verified field", async () => {
    mockMidnightMode();
    vi.spyOn(client, "queryContractState").mockResolvedValue({ someOtherField: true });

    const verifier = new AgeVerification({});
    const proof = makeOnChainProof();

    const isValid = await verifier.verify(proof);
    expect(isValid).toBe(false);
  });

  it("should reject proof when on-chain verified disagrees with proof claim", async () => {
    mockMidnightMode();
    vi.spyOn(client, "queryContractState").mockResolvedValue({ verified: false });

    const verifier = new AgeVerification({});
    const proof = makeOnChainProof({ publicSignals: { verified: true, minAge: 18 } });

    const isValid = await verifier.verify(proof);
    expect(isValid).toBe(false);
  });

  it("should reject proof when transaction is not found on-chain", async () => {
    mockMidnightMode();
    vi.spyOn(client, "queryContractState").mockResolvedValue({ verified: true });
    vi.spyOn(client, "queryTransaction").mockResolvedValue(null);

    const verifier = new AgeVerification({});
    const proof = makeOnChainProof();

    const isValid = await verifier.verify(proof);
    expect(isValid).toBe(false);
  });

  it("should reject proof when block height does not match", async () => {
    mockMidnightMode();
    vi.spyOn(client, "queryContractState").mockResolvedValue({ verified: true });
    vi.spyOn(client, "queryTransaction").mockResolvedValue({ blockHeight: 99 });

    const verifier = new AgeVerification({});
    const proof = makeOnChainProof({ blockHeight: 10 });

    const isValid = await verifier.verify(proof);
    expect(isValid).toBe(false);
  });

  it("should accept valid on-chain proof with matching state and transaction", async () => {
    mockMidnightMode();
    vi.spyOn(client, "queryContractState").mockResolvedValue({ verified: true });
    vi.spyOn(client, "queryTransaction").mockResolvedValue({ blockHeight: 10 });

    const verifier = new AgeVerification({});
    const proof = makeOnChainProof();

    const isValid = await verifier.verify(proof);
    expect(isValid).toBe(true);
  });

});

describe("AgeVerification - mainnet fallback protection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should throw error on mainnet when network is unavailable instead of falling back", async () => {
    const verifier = new AgeVerification({
      network: "mainnet",
      forceOffline: true, // Forces offline
    });

    await expect(
      verifier.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      })
    ).rejects.toThrow("Placeholder proofs are disabled on mainnet");
  });

  it("should allow placeholder fallback on standalone network", async () => {
    const verifier = new AgeVerification({
      network: "standalone",
      forceOffline: true,
    });

    const proof = await verifier.generate({
      birthDate: new Date("1990-01-15"),
      minAge: 18,
    });

    expect(proof.publicSignals.network).toBe("mocked");
    expect(proof.publicSignals.verified).toBe(true);
  });

  it("should allow placeholder fallback on preview network", async () => {
    const verifier = new AgeVerification({
      network: "preview",
      forceOffline: true,
    });

    const proof = await verifier.generate({
      birthDate: new Date("1990-01-15"),
      minAge: 18,
    });

    expect(proof.publicSignals.network).toBe("mocked");
  });

  it("should allow placeholder fallback on preprod network", async () => {
    const verifier = new AgeVerification({
      network: "preprod",
      forceOffline: true,
    });

    const proof = await verifier.generate({
      birthDate: new Date("1990-01-15"),
      minAge: 18,
    });

    expect(proof.publicSignals.network).toBe("mocked");
  });
});

describe("MidnightNetwork type union", () => {
  it("should accept all valid network types in MidnightConfig", () => {
    const networks: Array<client.ClientState["network"]> = [
      "standalone",
      "testnet",
      "preview",
      "preprod",
      "mainnet",
      "mocked",
    ];

    // Type-level check: all values are assignable to the union
    expect(networks).toHaveLength(6);
  });
});
