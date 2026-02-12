/**
 * Midnight Network Client (Ledger v7)
 *
 * Handles connection to Midnight services (node, proof server, indexer)
 * and provides wallet setup + ephemeral contract deployment.
 *
 * Each proof interaction deploys a fresh contract instance to prevent
 * cross-verifier correlation (Company A and B cannot link proofs to the same user).
 */

import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import {
  type DeployedContract,
  deployContract,
  findDeployedContract,
} from "@midnight-ntwrk/midnight-js-contracts";
import type { FinalizedTxData } from "@midnight-ntwrk/midnight-js-types";

export interface MidnightConfig {
  /** Proof server URL (default: http://localhost:6300) */
  proofServerUrl?: string;
  /** Indexer URL (default: http://localhost:8088) */
  indexerUrl?: string;
  /** Node WebSocket URL (default: ws://localhost:9944) */
  nodeUrl?: string;
  /** Network type */
  network?: "standalone" | "testnet";
  /** Skip network check (for testing) */
  skipNetworkCheck?: boolean;
  /** Network check timeout in ms (default: 1000) */
  networkCheckTimeoutMs?: number;
  /** Path to compiled contract assets (managed/ directory) */
  contractAssetsPath?: string;
}

export interface MidnightProviders {
  publicDataProvider: ReturnType<typeof indexerPublicDataProvider>;
}

const DEFAULT_CONFIG: Required<MidnightConfig> = {
  proofServerUrl: "http://localhost:6300",
  indexerUrl: "http://localhost:8088",
  nodeUrl: "ws://localhost:9944",
  network: "standalone",
  skipNetworkCheck: false,
  networkCheckTimeoutMs: 1000,
  contractAssetsPath: "",
};

/**
 * Build indexer GraphQL URLs from a base indexer URL.
 * Ledger v7 uses /api/v3/ paths.
 */
function buildIndexerUrls(indexerUrl: string): { httpUrl: string; wsUrl: string } {
  const indexerBase = new URL(indexerUrl);
  const base = indexerBase.href.endsWith("/") ? indexerBase.href : `${indexerBase.href}/`;

  const httpUrl = new URL("api/v3/graphql", base).href;

  const wsBase = new URL(base);
  wsBase.protocol = indexerBase.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = new URL("api/v3/graphql/ws", wsBase.href).href;

  return { httpUrl, wsUrl };
}

/**
 * Create Midnight providers for contract interaction
 */
export function createProviders(config: MidnightConfig = {}): MidnightProviders {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Note: proofProvider requires zkConfigProvider (compiled contract assets),
  // so it's created per-deployment in the proof generation flow, not here.
  const { httpUrl, wsUrl } = buildIndexerUrls(mergedConfig.indexerUrl);
  const publicDataProvider = indexerPublicDataProvider(httpUrl, wsUrl);

  return {
    publicDataProvider,
  };
}

/**
 * Check if Midnight network is available.
 *
 * Verifies both the proof server (GET /health) and the indexer
 * (lightweight GraphQL introspection query). Both must respond
 * successfully for the network to be considered available.
 */
export async function isNetworkAvailable(config: MidnightConfig = {}): Promise<boolean> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  if (mergedConfig.skipNetworkCheck) {
    return false;
  }

  const timeout = mergedConfig.networkCheckTimeoutMs;

  try {
    const [proofServerResult, indexerResult] = await Promise.all([
      fetch(`${mergedConfig.proofServerUrl}/health`, {
        signal: AbortSignal.timeout(timeout),
      }).then((r) => r.ok).catch(() => false),
      fetch(buildIndexerUrls(mergedConfig.indexerUrl).httpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
        signal: AbortSignal.timeout(timeout),
      }).then((r) => r.ok).catch(() => false),
    ]);

    return proofServerResult && indexerResult;
  } catch {
    return false;
  }
}

/** GraphQL response shape with optional errors array. */
interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Query contract state from the indexer via GraphQL.
 *
 * Returns the raw contract state data if the contract exists on-chain,
 * or null if not found. GraphQL-level errors are logged for diagnostics.
 */
export async function queryContractState(
  indexerUrl: string,
  contractAddress: string,
): Promise<Record<string, unknown> | null> {
  const { httpUrl } = buildIndexerUrls(indexerUrl);

  const query = `
    query ContractState($address: HexString!) {
      contractState(contractAddress: $address) {
        data
      }
    }
  `;

  try {
    const response = await fetch(httpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { address: contractAddress },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const result = (await response.json()) as GraphQLResponse<{
      contractState?: { data: Record<string, unknown> };
    }>;

    if (result.errors?.length) {
      console.warn("queryContractState: GraphQL errors:", result.errors);
    }

    return result.data?.contractState?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Query a transaction by ID from the indexer to verify it exists on-chain.
 *
 * Returns the block height if the transaction is confirmed, or null if not found.
 * GraphQL-level errors are logged for diagnostics.
 */
export async function queryTransaction(
  indexerUrl: string,
  txId: string,
): Promise<{ blockHeight: number } | null> {
  const { httpUrl } = buildIndexerUrls(indexerUrl);

  const query = `
    query Transaction($txId: HexString!) {
      transaction(txHash: $txId) {
        block {
          height
        }
      }
    }
  `;

  try {
    const response = await fetch(httpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { txId },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const result = (await response.json()) as GraphQLResponse<{
      transaction?: { block?: { height: number } };
    }>;

    if (result.errors?.length) {
      console.warn("queryTransaction: GraphQL errors:", result.errors);
    }

    const height = result.data?.transaction?.block?.height;
    if (height === undefined || height === null) return null;

    return { blockHeight: height };
  } catch {
    return null;
  }
}

/**
 * Client state - tracks whether we're connected to real network or using mocks.
 */
export interface ClientState {
  connected: boolean;
  network: "standalone" | "testnet" | "mocked";
  providers?: MidnightProviders;
  config?: MidnightConfig;
}

/**
 * Module-level singleton shared by all AgeVerification instances.
 * This is appropriate for single-tenant use; multi-tenant or concurrent
 * contexts (e.g. serverless) would need per-instance state instead.
 */
let clientState: ClientState = {
  connected: false,
  network: "mocked",
};

/**
 * Initialize Midnight client
 *
 * Sets up providers for proof generation and indexer queries.
 * Wallet setup and contract deployment happen per-proof in the age verification flow.
 *
 * @returns true if connected to real network, false if falling back to mocks
 */
export async function initializeClient(config: MidnightConfig = {}): Promise<boolean> {
  const available = await isNetworkAvailable(config);

  if (available) {
    clientState = {
      connected: true,
      network: config.network ?? "standalone",
      providers: createProviders(config),
      config,
    };
    return true;
  }

  clientState = {
    connected: false,
    network: "mocked",
  };
  return false;
}

/**
 * Get current client state
 */
export function getClientState(): ClientState {
  return { ...clientState };
}

// Re-export Midnight SDK contract utilities for use by proof generators
export { deployContract, findDeployedContract };
export type { DeployedContract, FinalizedTxData };
