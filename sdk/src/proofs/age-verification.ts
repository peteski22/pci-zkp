/**
 * Age Verification - Prove age without revealing birth date
 *
 * Uses Midnight's Compact contract when network is available,
 * falls back to placeholder proofs for offline/testing scenarios.
 *
 * Privacy model: Each proof interaction deploys a FRESH ephemeral contract.
 * This prevents cross-verifier correlation — Company A and Company B cannot
 * link proofs to the same user.
 */

import type { Proof, ProofConfig, AgeProofInput } from "../types.js";
import { isOnChainProof } from "../types.js";
import {
  getClientState,
  initializeClient,
  queryContractState,
  queryTransaction,
  type MidnightConfig,
} from "../midnight/client.js";
import {
  getOrCreateWallet,
  resolveContractAssetsPath,
  deployAndVerifyAge,
  type WalletConfig,
} from "../midnight/index.js";

export class AgeVerification {
  private initialized = false;
  private useMidnight = false;

  constructor(private readonly config: ProofConfig & MidnightConfig) {}

  /**
   * Calculate age from birth date and current date.
   */
  private calculateAge(birthDate: Date, currentDate: Date): number {
    let age = currentDate.getFullYear() - birthDate.getFullYear();
    const birthdayPassed =
      currentDate.getMonth() > birthDate.getMonth() ||
      (currentDate.getMonth() === birthDate.getMonth() &&
        currentDate.getDate() >= birthDate.getDate());
    if (!birthdayPassed) {
      age--;
    }
    return age;
  }

  /**
   * Initialize the verifier, connecting to Midnight if available
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) {
      return this.useMidnight;
    }

    this.useMidnight = await initializeClient(this.config);
    this.initialized = true;

    return this.useMidnight;
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
        ? (() => {
            // Parse date-only strings (YYYY-MM-DD) as local dates to avoid
            // timezone shift: new Date("YYYY-MM-DD") parses as UTC midnight,
            // which rolls back a day in negative UTC offsets (e.g. EST).
            const parts = input.birthDate!.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (parts) {
              return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
            }
            return new Date(input.birthDate!);
          })()
        : null;

    if (!birthDate || isNaN(birthDate.getTime())) {
      return {
        verificationMethod: "offline",
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

    // Ensure initialized
    await this.initialize();

    // Try to use Midnight network if available
    const clientState = getClientState();
    if (clientState.connected && clientState.providers) {
      return this.generateWithMidnight(birthDate, minAge, currentDate, input.requesterDid);
    }

    // On mainnet, never fall back to placeholder proofs — this is a security gap.
    // Placeholder proofs are only acceptable for development/testing networks.
    if (this.config.network === "mainnet") {
      throw new Error(
        "Midnight network unavailable. Placeholder proofs are disabled on mainnet for security."
      );
    }

    // Fall back to placeholder proof (non-mainnet only)
    return this.generatePlaceholder(birthDate, minAge, currentDate, input.requesterDid);
  }

  /**
   * Generate proof using real Midnight network.
   *
   * 1. Creates/reuses an HD wallet singleton
   * 2. Waits for wallet sync
   * 3. Deploys a fresh ephemeral contract (privacy: no cross-verifier linkability)
   * 4. Calls verifyAge circuit — auto-generates ZK proof, submits tx
   * 5. Returns OnChainProof with real on-chain metadata
   */
  private async generateWithMidnight(
    birthDate: Date,
    minAge: number,
    currentDate: Date,
    requesterDid?: string
  ): Promise<Proof> {
    const walletConfig = this.buildWalletConfig();
    const wallet = await getOrCreateWallet(walletConfig);
    await wallet.waitForSync(30_000);

    const assetsPath = resolveContractAssetsPath(this.config.contractAssetsPath);

    const result = await deployAndVerifyAge(
      wallet,
      walletConfig,
      birthDate,
      minAge,
      currentDate,
      assetsPath,
    );

    // Chain-verifiable: verified flag is read from on-chain contract state.
    // Self-reported: minAge, requesterDid, network are caller-supplied metadata —
    // they are NOT verified on-chain. Consumers must not trust these fields for
    // security decisions. Binding minAge/requesterDid into the circuit's disclosed
    // state requires a contract change (tracked separately).
    const publicSignals: Record<string, unknown> = {
      verified: result.verified,
      minAge,
      network: this.config.network ?? "standalone",
    };

    if (requesterDid) {
      publicSignals.requesterDid = requesterDid;
    }

    return {
      verificationMethod: "on-chain",
      proof: result.txId,
      publicSignals,
      verificationKey: "age_verification_vk_midnight",
      circuitId: "age_verification",
      timestamp: new Date(),
      txId: result.txId,
      contractAddress: result.contractAddress,
      blockHeight: result.blockHeight,
    };
  }

  /**
   * Build a WalletConfig from the current MidnightConfig.
   */
  private buildWalletConfig(): WalletConfig {
    const indexerUrl = this.config.indexerUrl ?? "http://localhost:8088";

    // Derive WebSocket URL from HTTP URL
    const indexerBase = new URL(indexerUrl);
    const wsBase = new URL(indexerUrl);
    wsBase.protocol = indexerBase.protocol === "https:" ? "wss:" : "ws:";

    const normalisedPath = indexerBase.pathname.replace(/\/+$/, "");
    // Accept either /api/v4/graphql (canonical for Ledger 8) or /api/v3/graphql
    // (backwards-compat alias still served by indexer-standalone 4.x).
    const hasGraphqlPath =
      normalisedPath.endsWith("/api/v4/graphql") ||
      normalisedPath.endsWith("/api/v3/graphql");

    const httpUrl = hasGraphqlPath
      ? indexerBase.href
      : new URL("api/v4/graphql", indexerBase.href.endsWith("/") ? indexerBase.href : `${indexerBase.href}/`).href;

    const wsUrl = hasGraphqlPath
      ? new URL(`${normalisedPath}/ws`, wsBase.origin).href
      : new URL("api/v4/graphql/ws", wsBase.href.endsWith("/") ? wsBase.href : `${wsBase.href}/`).href;

    return {
      seed: this.config.walletSeed,
      network: this.config.network ?? "standalone",
      indexerUrl: httpUrl,
      indexerWsUrl: wsUrl,
      nodeUrl: this.config.nodeUrl ?? "ws://localhost:9944",
      proofServerUrl: this.config.proofServerUrl ?? "http://localhost:6300",
    };
  }

  /**
   * Generate placeholder proof (when Midnight not available)
   */
  private generatePlaceholder(
    birthDate: Date,
    minAge: number,
    currentDate: Date,
    requesterDid?: string
  ): Proof {
    const verified = this.calculateAge(birthDate, currentDate) >= minAge;

    // Build public signals - includes requesterDid if provided (binds proof to identity)
    const publicSignals: Record<string, unknown> = {
      verified,
      minAge,
      network: "mocked",
    };

    // Include requesterDid in public signals if provided
    // This binds the proof to a specific ephemeral DID
    if (requesterDid) {
      publicSignals.requesterDid = requesterDid;
    }

    return {
      verificationMethod: "offline",
      proof: this.generatePlaceholderProofData(),
      publicSignals,
      verificationKey: "age_verification_vk_placeholder",
      circuitId: "age_verification",
      timestamp: new Date(),
    };
  }

  /**
   * Verify an age verification proof
   *
   * For Midnight proofs with on-chain metadata (txId + contractAddress):
   *   1. Queries the contract state via the indexer
   *   2. Confirms the transaction exists at the claimed block height
   *   3. Returns the on-chain verification result
   *
   * For proofs without on-chain metadata:
   *   - In Midnight mode: rejects (cannot verify without on-chain data)
   *   - In offline mode: accepts (placeholder trust for testing)
   *
   * @param proof The proof to verify
   * @param expectedDid Optional DID to verify the proof is bound to
   */
  async verify(proof: Proof, expectedDid?: string): Promise<boolean> {
    if (proof.circuitId !== "age_verification") {
      throw new Error("Invalid circuit ID for age verification");
    }

    // Ensure we know whether the Midnight network is available.
    await this.initialize();

    const signals = proof.publicSignals as {
      verified?: boolean;
      minAge?: number;
      requesterDid?: string;
      network?: string;
    };

    // Check basic structure
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

    // When Midnight is active, verify on-chain
    if (this.useMidnight) {
      return this.verifyMidnightProof(proof);
    }

    // On mainnet, reject placeholder proofs in the verify path too —
    // they should never be accepted in a production environment.
    if (this.config.network === "mainnet") {
      return false;
    }

    // Placeholder proofs are trusted only in offline/test mode
    return true;
  }

  /**
   * Verify a Midnight-generated proof via on-chain data
   *
   * Verification strategy (Midnight has no off-chain verification API):
   * 1. Require on-chain proof (verificationMethod === "on-chain")
   * 2. Query the contract state from the indexer to read the `verified` field
   * 3. Confirm the transaction exists on-chain at the claimed block height
   *
   * SECURITY NOTE: The indexer does not currently expose which contract a
   * transaction targets, so we verify tx existence and contract state
   * independently. This is acceptable because each contract is ephemeral
   * (single-use, deployed per proof interaction). An attacker who deploys
   * their own contract can only set `verified=true` on their own instance —
   * the contractAddress in the proof binds to the specific instance.
   * A future indexer API upgrade should allow binding txId → contractAddress.
   *
   * Offline proofs are rejected — they lack the on-chain record needed for
   * cryptographic verification.
   */
  private async verifyMidnightProof(proof: Proof): Promise<boolean> {
    // Require on-chain metadata for verification
    if (!isOnChainProof(proof)) {
      // Offline proof — cannot verify via on-chain data.
      return false;
    }

    const clientState = getClientState();
    if (!clientState.config?.indexerUrl) {
      // Midnight is active but config is missing — cannot verify.
      return false;
    }
    const indexerUrl = clientState.config.indexerUrl;

    // 1. Query contract state from the indexer
    const contractState = await queryContractState(indexerUrl, proof.contractAddress);
    if (!contractState) {
      return false;
    }

    // 2. Check the on-chain verified field matches the proof's claim.
    if (contractState.verified === undefined) {
      // Contract state does not contain a 'verified' field — schema mismatch.
      return false;
    }
    if (contractState.verified !== proof.publicSignals.verified) {
      return false;
    }

    // 3. Confirm the transaction exists on-chain (see SECURITY NOTE above).
    const txResult = await queryTransaction(indexerUrl, proof.txId);
    if (!txResult) {
      return false;
    }

    // 4. Verify block height matches.
    if (txResult.blockHeight !== proof.blockHeight) {
      return false;
    }

    return true;
  }

  private generatePlaceholderProofData(): string {
    return Buffer.from(
      JSON.stringify({
        type: "age_verification",
        version: "1.0",
        placeholder: true,
      })
    ).toString("base64");
  }

}
