/**
 * Integration tests for Midnight network (Ledger v7)
 *
 * Prerequisites:
 * - Start Midnight network: make dev (or docker compose up -d)
 *
 * Run: pnpm test:integration
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AgeVerification } from "../../sdk/src/proofs/age-verification.js";
import { isNetworkAvailable, initializeClient, getClientState } from "../../sdk/src/midnight/client.js";
import { isOnChainProof } from "../../sdk/src/types.js";

const PROOF_SERVER_URL = process.env.MIDNIGHT_PROOF_SERVER_URL || "http://localhost:6300";
const INDEXER_URL = process.env.MIDNIGHT_INDEXER_URL || "http://localhost:8088";

/** Path to compiled contract assets — only exists if compactc has been run. */
const CONTRACT_ASSETS_PATH = resolve(
  new URL(import.meta.url).pathname,
  "..",
  "..",
  "..",
  "contract",
  "src",
  "managed",
  "proofs",
);
const hasContractAssets = existsSync(CONTRACT_ASSETS_PATH);

describe("Midnight Network Integration", () => {
  let isNetworkUp = false;

  beforeAll(async () => {
    // Check if Midnight network is running
    isNetworkUp = await isNetworkAvailable({
      proofServerUrl: PROOF_SERVER_URL,
      networkCheckTimeoutMs: 5000,
    });

    if (!isNetworkUp) {
      console.log("Skipping integration tests: Midnight network not running");
      console.log("Start with: make dev (or docker compose up -d)");
    }
  });

  describe("Network Connectivity", () => {
    it("should detect proof server", async () => {
      if (!isNetworkUp) {
        console.log("Skipping: Network not available");
        return;
      }

      const response = await fetch(`${PROOF_SERVER_URL}/health`);
      expect(response.ok).toBe(true);
    });

    it("should detect indexer", async () => {
      if (!isNetworkUp) {
        console.log("Skipping: Network not available");
        return;
      }

      // Ledger v7 uses /api/v3/ paths
      const response = await fetch(`${INDEXER_URL}/api/v3/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
      });
      expect(response.ok).toBe(true);
    });

    it("should initialize client successfully", async () => {
      if (!isNetworkUp) {
        console.log("Skipping: Network not available");
        return;
      }

      const connected = await initializeClient({
        proofServerUrl: PROOF_SERVER_URL,
        indexerUrl: INDEXER_URL,
      });

      expect(connected).toBe(true);

      const state = getClientState();
      expect(state.connected).toBe(true);
      expect(state.network).toBe("standalone");
      expect(state.config).toBeDefined();
    });
  });

  describe("Age Verification with Network", () => {
    it("should attempt on-chain proof when network is available", async () => {
      if (!isNetworkUp) {
        console.log("Skipping: Network not available");
        return;
      }

      const verifier = new AgeVerification({
        proofServerUrl: PROOF_SERVER_URL,
        indexerUrl: INDEXER_URL,
      });

      if (!hasContractAssets) {
        // Without compiled contract assets, should throw about missing assets
        await expect(
          verifier.generate({
            birthDate: new Date("1990-01-15"),
            minAge: 18,
          })
        ).rejects.toThrow(/Compact contract must be compiled|Contract assets not found/);
      } else {
        // With compiled contract assets, should return an on-chain proof
        const proof = await verifier.generate({
          birthDate: new Date("1990-01-15"),
          minAge: 18,
        });

        expect(proof.circuitId).toBe("age_verification");
        expect(isOnChainProof(proof)).toBe(true);
        if (isOnChainProof(proof)) {
          expect(proof.txId).toBeDefined();
          expect(proof.contractAddress).toBeDefined();
          expect(proof.blockHeight).toBeGreaterThan(0);
          expect(proof.publicSignals.verified).toBe(true);
        }
      }
    });
  });

  describe("Fallback Behavior", () => {
    it("should fall back to placeholder when network unavailable", async () => {
      const verifier = new AgeVerification({
        proofServerUrl: "http://localhost:59999", // Unlikely-to-be-listening port
        networkCheckTimeoutMs: 100,
      });

      const proof = await verifier.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      expect(proof.circuitId).toBe("age_verification");
      expect(proof.publicSignals.verified).toBe(true);
      expect(proof.publicSignals.network).toBe("mocked");
      // Placeholder proofs are offline
      expect(proof.verificationMethod).toBe("offline");
    });

    it("should skip network check when configured", async () => {
      const verifier = new AgeVerification({
        forceOffline: true,
      });

      const proof = await verifier.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      expect(proof.publicSignals.network).toBe("mocked");
    });
  });

  describe("Ephemeral Contract Privacy", () => {
    it("should use different contract addresses for different verifiers", async () => {
      if (!isNetworkUp || !hasContractAssets) {
        console.log("Skipping: Requires network + compiled contract assets");
        return;
      }

      const verifier1 = new AgeVerification({
        proofServerUrl: PROOF_SERVER_URL,
        indexerUrl: INDEXER_URL,
      });

      const verifier2 = new AgeVerification({
        proofServerUrl: PROOF_SERVER_URL,
        indexerUrl: INDEXER_URL,
      });

      const proof1 = await verifier1.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      const proof2 = await verifier2.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      // Each proof deploys a fresh ephemeral contract — addresses must differ
      if (isOnChainProof(proof1) && isOnChainProof(proof2)) {
        expect(proof1.contractAddress).not.toBe(proof2.contractAddress);
      }
    });
  });
});
