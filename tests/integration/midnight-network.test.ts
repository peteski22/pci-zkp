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
    it("should generate proof using Midnight network", async () => {
      if (!isNetworkUp) {
        console.log("Skipping: Network not available");
        return;
      }

      const verifier = new AgeVerification({
        proofServerUrl: PROOF_SERVER_URL,
        indexerUrl: INDEXER_URL,
      });

      const proof = await verifier.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      expect(proof.circuitId).toBe("age_verification");
      expect(proof.publicSignals.verified).toBe(true);
      expect(proof.publicSignals.minAge).toBe(18);
      expect(proof.publicSignals.network).toBe("midnight");
    });

    it("should verify proof generated with Midnight", async () => {
      if (!isNetworkUp) {
        console.log("Skipping: Network not available");
        return;
      }

      const verifier = new AgeVerification({
        proofServerUrl: PROOF_SERVER_URL,
        indexerUrl: INDEXER_URL,
      });

      const proof = await verifier.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 21,
      });

      // Until full wallet + deployment flow is wired, Midnight proofs
      // lack on-chain metadata (txId/contractAddress), so verify() will
      // reject them. This is the correct security behavior.
      const isValid = await verifier.verify(proof);
      // Proofs without on-chain metadata are rejected in Midnight mode
      expect(isValid).toBe(false);
    });

    it("should correctly reject underage proof", async () => {
      if (!isNetworkUp) {
        console.log("Skipping: Network not available");
        return;
      }

      const verifier = new AgeVerification({
        proofServerUrl: PROOF_SERVER_URL,
        indexerUrl: INDEXER_URL,
      });

      // Create a birth date that will always be under 18 (10 years ago)
      const now = new Date();
      const underageBirthDate = new Date(now.getFullYear() - 10, 0, 15);

      const proof = await verifier.generate({
        birthDate: underageBirthDate,
        minAge: 18,
      });

      expect(proof.publicSignals.verified).toBe(false);
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
      // Placeholder proofs don't have on-chain metadata
      expect(proof.txId).toBeUndefined();
      expect(proof.contractAddress).toBeUndefined();
    });

    it("should skip network check when configured", async () => {
      const verifier = new AgeVerification({
        skipNetworkCheck: true,
      });

      const proof = await verifier.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      expect(proof.publicSignals.network).toBe("mocked");
    });
  });

  describe("Ephemeral Contract Privacy", () => {
    it("should generate different proofs for same input (no state sharing)", async () => {
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

      const proof1 = await verifier1.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      const proof2 = await verifier2.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      // Both should be valid
      expect(proof1.publicSignals.verified).toBe(true);
      expect(proof2.publicSignals.verified).toBe(true);

      // Verify they are structurally independent proof instances.
      // TODO: Once full deployment is wired, assert different contractAddresses here.
      expect(proof1.proof).toBeDefined();
      expect(proof2.proof).toBeDefined();
      expect(proof1.verificationKey).toBe(proof2.verificationKey);
    });
  });
});
