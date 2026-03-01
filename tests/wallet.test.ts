import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveSeed,
  deriveKeys,
  networkToId,
} from "../sdk/src/midnight/wallet.js";

describe("Wallet - resolveSeed", () => {
  const originalEnv = process.env.MIDNIGHT_WALLET_SEED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MIDNIGHT_WALLET_SEED;
    } else {
      process.env.MIDNIGHT_WALLET_SEED = originalEnv;
    }
  });

  it("should use config seed when provided", () => {
    const seed = "a".repeat(64);
    const result = resolveSeed({ seed, network: "standalone" });
    expect(result).toBe(seed);
  });

  it("should use MIDNIGHT_WALLET_SEED env var when config seed is absent", () => {
    const envSeed = "b".repeat(64);
    process.env.MIDNIGHT_WALLET_SEED = envSeed;
    const result = resolveSeed({ network: "standalone" });
    expect(result).toBe(envSeed);
  });

  it("should prefer config seed over env var", () => {
    const configSeed = "c".repeat(64);
    process.env.MIDNIGHT_WALLET_SEED = "d".repeat(64);
    const result = resolveSeed({ seed: configSeed, network: "standalone" });
    expect(result).toBe(configSeed);
  });

  it("should generate random seed for non-mainnet when no seed provided", () => {
    delete process.env.MIDNIGHT_WALLET_SEED;
    const result = resolveSeed({ network: "standalone" });
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should generate different random seeds on each call", () => {
    delete process.env.MIDNIGHT_WALLET_SEED;
    const seed1 = resolveSeed({ network: "standalone" });
    const seed2 = resolveSeed({ network: "standalone" });
    expect(seed1).not.toBe(seed2);
  });

  it("should throw on mainnet with no seed", () => {
    delete process.env.MIDNIGHT_WALLET_SEED;
    expect(() => resolveSeed({ network: "mainnet" })).toThrow(
      "Mainnet requires an explicit wallet seed"
    );
  });

  it("should accept explicit seed on mainnet", () => {
    const seed = "e".repeat(64);
    const result = resolveSeed({ seed, network: "mainnet" });
    expect(result).toBe(seed);
  });

  it("should throw on invalid hex characters", () => {
    expect(() =>
      resolveSeed({ seed: "g".repeat(64), network: "standalone" })
    ).toThrow("Wallet seed must be a hex string");
  });

  it("should throw on too-short seed", () => {
    expect(() =>
      resolveSeed({ seed: "ab".repeat(15), network: "standalone" })
    ).toThrow("Wallet seed must be at least 32 bytes");
  });

  it("should accept longer-than-minimum seeds", () => {
    const seed = "a".repeat(128); // 64 bytes
    const result = resolveSeed({ seed, network: "standalone" });
    expect(result).toBe(seed);
  });
});

describe("Wallet - deriveKeys", () => {
  // Known deterministic seed for reproducible key derivation tests
  const testSeed = "0123456789abcdef".repeat(4); // 64 hex chars = 32 bytes

  it("should derive keys from a valid seed", () => {
    const result = deriveKeys(testSeed);

    expect(result.zswapSecretKeys).toBeDefined();
    expect(result.dustSecretKey).toBeDefined();
    expect(result.keys).toBeDefined();
  });

  it("should produce deterministic keys from same seed", () => {
    const result1 = deriveKeys(testSeed);
    const result2 = deriveKeys(testSeed);

    // The coinPublicKey derived from the same seed should be identical
    expect(result1.zswapSecretKeys.coinPublicKey).toBe(
      result2.zswapSecretKeys.coinPublicKey
    );
  });

  it("should produce different keys from different seeds", () => {
    const otherSeed = "fedcba9876543210".repeat(4);
    const result1 = deriveKeys(testSeed);
    const result2 = deriveKeys(otherSeed);

    expect(result1.zswapSecretKeys.coinPublicKey).not.toBe(
      result2.zswapSecretKeys.coinPublicKey
    );
  });

  it("should include Zswap, NightExternal, and Dust role keys", () => {
    const result = deriveKeys(testSeed);

    // Roles: Zswap=3, NightExternal=0, Dust=2
    expect(result.keys[3]).toBeInstanceOf(Uint8Array); // Zswap
    expect(result.keys[0]).toBeInstanceOf(Uint8Array); // NightExternal
    expect(result.keys[2]).toBeInstanceOf(Uint8Array); // Dust
  });
});

describe("Wallet - networkToId", () => {
  it("should map standalone to undeployed", () => {
    expect(networkToId("standalone")).toBe("undeployed");
  });

  it("should map preview to preview", () => {
    expect(networkToId("preview")).toBe("preview");
  });

  it("should map preprod to preprod", () => {
    expect(networkToId("preprod")).toBe("preprod");
  });

  it("should map mainnet to mainnet", () => {
    expect(networkToId("mainnet")).toBe("mainnet");
  });

  it("should map testnet to testnet", () => {
    expect(networkToId("testnet")).toBe("testnet");
  });
});
