/**
 * Integration tests for Midnight network
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

      const response = await fetch(`${INDEXER_URL}/api/v1/graphql`, {
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

      const isValid = await verifier.verify(proof);
      expect(isValid).toBe(true);
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

      const proof = await verifier.generate({
        birthDate: new Date("2015-01-15"), // ~11 years old
        minAge: 18,
      });

      expect(proof.publicSignals.verified).toBe(false);
    });
  });

  describe("Fallback Behavior", () => {
    it("should fall back to placeholder when network unavailable", async () => {
      const verifier = new AgeVerification({
        proofServerUrl: "http://localhost:99999", // Invalid port
        networkCheckTimeoutMs: 100,
      });

      const proof = await verifier.generate({
        birthDate: new Date("1990-01-15"),
        minAge: 18,
      });

      expect(proof.circuitId).toBe("age_verification");
      expect(proof.publicSignals.verified).toBe(true);
      expect(proof.publicSignals.network).toBe("mocked");
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
});
