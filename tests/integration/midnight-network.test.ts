/**
 * Integration tests for Midnight network (Ledger v7)
 *
 * Prerequisites:
 * - Start Midnight network: make dev (or docker compose up -d)
 *
 * Run: pnpm test:integration
 */

import { describe, it, expect, beforeAll } from "vitest";
import { AgeVerification } from "../../sdk/src/proofs/age-verification.js";
import { isNetworkAvailable, initializeClient, getClientState } from "../../sdk/src/midnight/client.js";

const PROOF_SERVER_URL = process.env.MIDNIGHT_PROOF_SERVER_URL || "http://localhost:6300";
const INDEXER_URL = process.env.MIDNIGHT_INDEXER_URL || "http://localhost:8088";

/** Shared matcher for the "not yet implemented" error thrown by on-chain proof generation. */
const NOT_IMPLEMENTED_RE = /issue #7/;

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
    it("should throw when generating proof with Midnight (not yet implemented)", async () => {
      if (!isNetworkUp) {
        console.log("Skipping: Network not available");
        return;
      }

      const verifier = new AgeVerification({
        proofServerUrl: PROOF_SERVER_URL,
        indexerUrl: INDEXER_URL,
      });

      // On-chain proof generation is not yet implemented (see issue #7).
      // When the network is available, generate() should throw rather than
      // returning a proof that cannot be verified.
      await expect(
        verifier.generate({
          birthDate: new Date("1990-01-15"),
          minAge: 18,
        })
      ).rejects.toThrow(NOT_IMPLEMENTED_RE);
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
    it("should throw for both verifiers (on-chain not yet implemented)", async () => {
      if (!isNetworkUp) {
        console.log("Skipping: Network not available");
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

      // Both should throw — on-chain generation not yet implemented.
      // TODO(#7): Once full deployment is wired, assert different contractAddresses.
      await expect(
        verifier1.generate({ birthDate: new Date("1990-01-15"), minAge: 18 })
      ).rejects.toThrow(NOT_IMPLEMENTED_RE);

      await expect(
        verifier2.generate({ birthDate: new Date("1990-01-15"), minAge: 18 })
      ).rejects.toThrow(NOT_IMPLEMENTED_RE);
    });
  });
});
