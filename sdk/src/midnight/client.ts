/**
 * Midnight Network Client
 *
 * Handles connection to Midnight services (node, proof server, indexer)
 * and provides contract deployment/interaction capabilities.
 */

import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";

export interface MidnightConfig {
  /** Proof server URL (default: http://localhost:6300) */
  proofServerUrl?: string;
  /** Indexer URL (default: http://localhost:8088) */
  indexerUrl?: string;
  /** Network type */
  network?: "standalone" | "testnet";
  /** Skip network check (for testing) */
  skipNetworkCheck?: boolean;
  /** Network check timeout in ms (default: 1000) */
  networkCheckTimeoutMs?: number;
}

export interface MidnightProviders {
  proofProvider: ReturnType<typeof httpClientProofProvider>;
  publicDataProvider: ReturnType<typeof indexerPublicDataProvider>;
}

const DEFAULT_CONFIG: Required<MidnightConfig> = {
  proofServerUrl: "http://localhost:6300",
  indexerUrl: "http://localhost:8088",
  network: "standalone",
  skipNetworkCheck: false,
  networkCheckTimeoutMs: 1000,
};

/**
 * Create Midnight providers for contract interaction
 */
export function createProviders(config: MidnightConfig = {}): MidnightProviders {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  const proofProvider = httpClientProofProvider(mergedConfig.proofServerUrl);
  const publicDataProvider = indexerPublicDataProvider(
    `${mergedConfig.indexerUrl}/api/v1/graphql`,
    `${mergedConfig.indexerUrl.replace("http", "ws")}/api/v1/graphql/ws`
  );

  return {
    proofProvider,
    publicDataProvider,
  };
}

/**
 * Check if Midnight network is available
 */
export async function isNetworkAvailable(config: MidnightConfig = {}): Promise<boolean> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Skip check if configured (for testing)
  if (config.skipNetworkCheck) {
    return false;
  }

  const timeout = config.networkCheckTimeoutMs ?? 1000;

  try {
    const response = await fetch(`${mergedConfig.proofServerUrl}/health`, {
      signal: AbortSignal.timeout(timeout),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Client state - tracks whether we're connected to real network or using mocks
 */
export interface ClientState {
  connected: boolean;
  network: "standalone" | "testnet" | "mocked";
  providers?: MidnightProviders;
}

let clientState: ClientState = {
  connected: false,
  network: "mocked",
};

/**
 * Initialize Midnight client
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
