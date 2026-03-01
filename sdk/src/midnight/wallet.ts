/**
 * Midnight HD Wallet Management
 *
 * Creates and manages HD wallets for Midnight ZK proof transactions.
 * Handles seed management, key derivation, and wallet facade lifecycle.
 *
 * Based on the official counter example patterns (midnightntwrk/example-counter).
 *
 * Security: seed buffers are zeroed after HD derivation; seeds are never logged.
 */

import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import {
  UnshieldedWallet,
  InMemoryTransactionHistoryStorage,
  createKeystore,
  PublicKey,
  type UnshieldedKeystore,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import {
  ZswapSecretKeys,
  DustSecretKey,
  LedgerParameters,
  Intent,
} from "@midnight-ntwrk/ledger-v7";
import { getNetworkId, setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import * as Rx from "rxjs";
import type { MidnightNetwork } from "./client.js";
import type { WalletProvider, MidnightProvider } from "@midnight-ntwrk/midnight-js-types";

export interface WalletConfig {
  /** Hex-encoded wallet seed (64+ hex chars = 32+ bytes) */
  seed?: string;
  /** Target network */
  network: MidnightNetwork;
  /** Indexer GraphQL HTTP URL (with /api/v3/graphql path) */
  indexerUrl: string;
  /** Indexer GraphQL WebSocket URL (with /api/v3/graphql/ws path) */
  indexerWsUrl: string;
  /** Midnight node WebSocket URL (ws:// or wss://) for relay */
  nodeUrl: string;
  /** Proof server URL */
  proofServerUrl: string;
}

export interface DerivedKeys {
  zswapSecretKeys: ZswapSecretKeys;
  dustSecretKey: DustSecretKey;
  /** Derived key seeds indexed by role */
  keys: Record<number, Uint8Array>;
}

export interface ManagedWallet {
  facade: WalletFacade;
  zswapSecretKeys: ZswapSecretKeys;
  dustSecretKey: DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
  shieldedAddress: string;
  unshieldedAddress: string;
  stop(): Promise<void>;
  waitForSync(timeoutMs?: number): Promise<void>;
}

/**
 * Map a MidnightNetwork to the network ID expected by wallet SDK internals.
 * Standalone uses "undeployed" per the official counter example.
 */
export function networkToId(network: MidnightNetwork): string {
  switch (network) {
    case "standalone":
      return "undeployed";
    case "testnet":
      return "testnet";
    case "preview":
      return "preview";
    case "preprod":
      return "preprod";
    case "mainnet":
      return "mainnet";
  }
}

/**
 * Resolve the wallet seed from config, env, or random generation.
 *
 * Priority: config.seed > MIDNIGHT_WALLET_SEED env var > random (non-mainnet only).
 * Mainnet always requires an explicit seed — random seeds would lose funds.
 *
 * @throws Error if mainnet and no seed provided
 * @throws Error if seed is not valid hex or too short (< 64 hex chars = 32 bytes)
 */
export function resolveSeed(config: Pick<WalletConfig, "seed" | "network">): string {
  const seed = config.seed || process.env.MIDNIGHT_WALLET_SEED;

  if (seed) {
    const trimmed = seed.trim();
    if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
      throw new Error("Wallet seed must be a hex string");
    }
    if (trimmed.length % 2 !== 0) {
      throw new Error("Wallet seed must have an even number of hex characters (each byte is 2 hex chars)");
    }
    if (trimmed.length < 64) {
      throw new Error("Wallet seed must be at least 32 bytes (64 hex characters)");
    }
    return trimmed;
  }

  if (config.network === "mainnet") {
    throw new Error(
      "Mainnet requires an explicit wallet seed (config.seed or MIDNIGHT_WALLET_SEED env var). " +
        "Random seeds are disabled on mainnet to prevent fund loss."
    );
  }

  // Generate random seed for non-mainnet
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive HD wallet keys from a hex seed.
 *
 * Uses BIP-44-style derivation: account 0, roles [Zswap, NightExternal, Dust], index 0.
 * The seed buffer is zeroed after derivation.
 */
export function deriveKeys(seedHex: string): DerivedKeys {
  const seedBytes = Buffer.from(seedHex, "hex");
  let hdWallet: { clear(): void } | null = null;

  try {
    const result = HDWallet.fromSeed(seedBytes);

    if (result.type !== "seedOk") {
      throw new Error("Failed to initialize HDWallet from seed");
    }

    hdWallet = result.hdWallet;

    const derived = result.hdWallet
      .selectAccount(0)
      .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
      .deriveKeysAt(0);

    if (derived.type !== "keysDerived") {
      throw new Error("Failed to derive keys");
    }

    const zswapSecretKeys = ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
    const dustSecretKey = DustSecretKey.fromSeed(derived.keys[Roles.Dust]);

    return { zswapSecretKeys, dustSecretKey, keys: derived.keys };
  } finally {
    seedBytes.fill(0);
    hdWallet?.clear();
  }
}

/**
 * Build the configuration for ShieldedWallet.
 *
 * Requires: networkId, indexerClientConnection, provingServerUrl, relayURL.
 */
function buildShieldedConfig(config: WalletConfig) {
  return {
    networkId: networkToId(config.network),
    indexerClientConnection: {
      indexerHttpUrl: config.indexerUrl,
      indexerWsUrl: config.indexerWsUrl,
    },
    provingServerUrl: new URL(config.proofServerUrl),
    relayURL: new URL(ensureWsProtocol(config.nodeUrl)),
  };
}

/**
 * Build the configuration for UnshieldedWallet.
 *
 * Requires: networkId, indexerClientConnection, txHistoryStorage.
 */
function buildUnshieldedConfig(config: WalletConfig) {
  return {
    networkId: networkToId(config.network),
    indexerClientConnection: {
      indexerHttpUrl: config.indexerUrl,
      indexerWsUrl: config.indexerWsUrl,
    },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  };
}

/**
 * Build the configuration for DustWallet.
 *
 * Requires: networkId, costParameters, indexerClientConnection,
 * provingServerUrl, relayURL.
 */
function buildDustConfig(config: WalletConfig) {
  return {
    networkId: networkToId(config.network),
    // Cost parameters from official counter example (midnightntwrk/example-counter)
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
    indexerClientConnection: {
      indexerHttpUrl: config.indexerUrl,
      indexerWsUrl: config.indexerWsUrl,
    },
    provingServerUrl: new URL(config.proofServerUrl),
    relayURL: new URL(ensureWsProtocol(config.nodeUrl)),
  };
}

/**
 * Ensure a URL uses WebSocket protocol (ws:// or wss://).
 * Accepts ws://, wss://, http://, or https:// and normalizes to ws(s).
 */
function ensureWsProtocol(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (parsed.protocol === "https:") parsed.protocol = "wss:";
  return parsed.href;
}

/**
 * Create a WalletProvider & MidnightProvider from a ManagedWallet.
 *
 * This provider bridges the wallet facade into the midnight-js-contracts
 * provider interface, handling balancing, signing, and submission.
 *
 * Includes the signRecipe workaround for the wallet-sdk 1.0.0 bug where
 * hardcoded 'pre-proof' markers fail for proven intents.
 */
export async function createWalletAndMidnightProvider(
  wallet: ManagedWallet,
): Promise<WalletProvider & MidnightProvider> {
  const state = await Rx.firstValueFrom(
    wallet.facade.state().pipe(Rx.filter((s) => s.isSynced)),
  );

  return {
    getCoinPublicKey() {
      return state.shielded.coinPublicKey.toHexString();
    },
    getEncryptionPublicKey() {
      return state.shielded.encryptionPublicKey.toHexString();
    },
    async balanceTx(tx, ttl?) {
      const recipe = await wallet.facade.balanceUnboundTransaction(
        tx,
        {
          shieldedSecretKeys: wallet.zswapSecretKeys,
          dustSecretKey: wallet.dustSecretKey,
        },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );

      const signFn = (payload: Uint8Array) =>
        wallet.unshieldedKeystore.signData(payload);

      // Sign transaction intents (workaround for wallet-sdk 1.0.0 bug)
      signRecipeIntents(recipe.baseTransaction, signFn, "proof");
      if (recipe.balancingTransaction) {
        signRecipeIntents(recipe.balancingTransaction, signFn, "pre-proof");
      }

      return wallet.facade.finalizeRecipe(recipe);
    },
    submitTx(tx) {
      return wallet.facade.submitTransaction(tx) as Promise<string>;
    },
  };
}

/**
 * Sign transaction intents, working around the wallet-sdk 1.0.0 bug.
 *
 * The bug hardcodes 'pre-proof' markers which fails for proven intents
 * containing actual proof data. This function manually deserializes with
 * the correct marker and applies signatures.
 */
function signRecipeIntents(
  tx: { intents?: Map<number, unknown> },
  signFn: (payload: Uint8Array) => string,
  proofMarker: "proof" | "pre-proof",
): void {
  if (!tx.intents || tx.intents.size === 0) return;

  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment) as { serialize(): Uint8Array; signatureData(s: number): Uint8Array };
    if (!intent) continue;

    const cloned = Intent.deserialize(
      "signature",
      proofMarker,
      "pre-binding",
      intent.serialize(),
    );

    const sigData = cloned.signatureData(segment);
    const signature = signFn(sigData);

    if (cloned.fallibleUnshieldedOffer) {
      const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
        (_: unknown, i: number) =>
          cloned.fallibleUnshieldedOffer!.signatures.at(i) ?? signature,
      );
      cloned.fallibleUnshieldedOffer =
        cloned.fallibleUnshieldedOffer.addSignatures(sigs);
    }

    if (cloned.guaranteedUnshieldedOffer) {
      const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
        (_: unknown, i: number) =>
          cloned.guaranteedUnshieldedOffer!.signatures.at(i) ?? signature,
      );
      cloned.guaranteedUnshieldedOffer =
        cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
    }

    tx.intents.set(segment, cloned);
  }
}

/**
 * Create a fully configured ManagedWallet.
 *
 * Builds ShieldedWallet + UnshieldedWallet + DustWallet, wraps them in a
 * WalletFacade, starts the facade, and returns the managed wallet.
 */
export async function createWallet(config: WalletConfig): Promise<ManagedWallet> {
  const seedHex = resolveSeed(config);
  const { zswapSecretKeys, dustSecretKey, keys } = deriveKeys(seedHex);

  // Set network ID globally (required by wallet-sdk internals — single network per process)
  const desiredNetworkId = networkToId(config.network);
  const currentNetworkId = getNetworkId();
  if (currentNetworkId !== undefined && currentNetworkId !== desiredNetworkId) {
    throw new Error(
      `Global network ID is already set to "${currentNetworkId}", which differs from requested "${desiredNetworkId}". ` +
        "Multiple different Midnight networks in a single process are not supported."
    );
  }
  setNetworkId(desiredNetworkId);

  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

  // Zero derived key buffers now that they've been consumed by ZswapSecretKeys,
  // DustSecretKey, and createKeystore. The secret keys are held by those objects.
  for (const role of Object.keys(keys)) {
    const buf = keys[Number(role)];
    if (buf instanceof Uint8Array) buf.fill(0);
  }

  // Create sub-wallets
  const shieldedWallet = ShieldedWallet(buildShieldedConfig(config))
    .startWithSecretKeys(zswapSecretKeys);

  const unshieldedWallet = UnshieldedWallet(buildUnshieldedConfig(config))
    .startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));

  const dustWallet = DustWallet(buildDustConfig(config))
    .startWithSecretKey(dustSecretKey, LedgerParameters.initialParameters().dust);

  // Create facade and start
  const facade = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
  await facade.start(zswapSecretKeys, dustSecretKey);

  // Get addresses
  const shieldedAddr = await shieldedWallet.getAddress();
  const unshieldedAddr = await unshieldedWallet.getAddress();

  return {
    facade,
    zswapSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
    shieldedAddress: shieldedAddr.coinPublicKeyString(),
    unshieldedAddress: unshieldedAddr.hexString,

    async stop() {
      await facade.stop();
      zswapSecretKeys.clear();
      dustSecretKey.clear();
    },

    async waitForSync(timeoutMs = 60_000) {
      await Rx.firstValueFrom(
        facade.state().pipe(
          Rx.throttleTime(2_000),
          Rx.filter((state) => state.isSynced),
          Rx.timeout(timeoutMs),
        ),
      );
    },
  };
}

// Module-level singleton with pending-promise guard.
// Only one network per process is supported — setNetworkId() is a global side effect.
let walletInstance: ManagedWallet | null = null;
let walletPending: Promise<ManagedWallet> | null = null;
let walletNetwork: string | null = null;

/**
 * Get or create a singleton wallet instance.
 *
 * Uses a pending-promise guard to prevent duplicate wallet creation
 * when multiple callers invoke this concurrently.
 *
 * Only one network per process is supported (setNetworkId is global).
 * Throws if called with a different network than the existing wallet.
 */
export async function getOrCreateWallet(config: WalletConfig): Promise<ManagedWallet> {
  if (walletInstance || walletPending) {
    if (walletNetwork && walletNetwork !== config.network) {
      throw new Error(
        `Wallet already initialized for network "${walletNetwork}". ` +
          `Cannot switch to "${config.network}" — only one network per process is supported. ` +
          `Call destroyWallet() first to switch networks.`
      );
    }
    if (walletInstance) return walletInstance;
    return walletPending!;
  }

  walletNetwork = config.network;
  walletPending = createWallet(config).then((wallet) => {
    walletInstance = wallet;
    walletPending = null;
    return wallet;
  }).catch((err) => {
    walletPending = null;
    walletNetwork = null;
    throw err;
  });

  return walletPending;
}

/**
 * Destroy the singleton wallet (for tests and cleanup).
 */
export async function destroyWallet(): Promise<void> {
  if (walletPending) {
    try {
      const wallet = await walletPending;
      await wallet.stop();
    } catch {
      // Ignore errors during cleanup
    }
  }
  if (walletInstance) {
    await walletInstance.stop();
  }
  walletInstance = null;
  walletPending = null;
  walletNetwork = null;
}
