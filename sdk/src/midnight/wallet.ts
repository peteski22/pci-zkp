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
import { WalletFacade, WalletEntrySchema } from "@midnight-ntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
  type UnshieldedKeystore,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { InMemoryTransactionHistoryStorage } from "@midnight-ntwrk/wallet-sdk-abstractions";
import {
  ZswapSecretKeys,
  DustSecretKey,
  LedgerParameters,
} from "@midnight-ntwrk/ledger-v8";
import { getNetworkId, setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import * as Rx from "rxjs";
import type { MidnightNetwork } from "./client.js";
import type { WalletProvider, MidnightProvider } from "@midnight-ntwrk/midnight-js-types";

export interface WalletConfig {
  /** Hex-encoded wallet seed (64+ hex chars = 32+ bytes) */
  seed?: string;
  /** Target network */
  network: MidnightNetwork;
  /** Indexer GraphQL HTTP URL (with /api/v4/graphql path) */
  indexerUrl: string;
  /** Indexer GraphQL WebSocket URL (with /api/v4/graphql/ws path) */
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
 * Build a merged Midnight wallet configuration for the `WalletFacade.init`
 * factory. All three sub-wallets (shielded, unshielded, Dust) now require
 * a `txHistoryStorage` (previously unshielded-only), so the object below
 * intentionally supplies one at the top level.
 *
 * NOTE: With wallet-sdk 4.x, `DefaultConfiguration` is an intersection of
 * per-wallet default configuration types whose exact shape shifts between
 * canary/patch releases. The typing here is intentionally loose (`unknown`
 * cast at the `WalletFacade.init` call site) so that the SDK bump does not
 * become a full facade-configuration refactor. Runtime correctness of this
 * config against a real network needs live verification when the local
 * stack is up (see pci-infra Ledger 8 refresh).
 */
function buildFacadeConfig(config: WalletConfig) {
  const indexerClientConnection = {
    indexerHttpUrl: config.indexerUrl,
    indexerWsUrl: config.indexerWsUrl,
  };
  const provingServerUrl = new URL(config.proofServerUrl);
  const relayURL = new URL(ensureWsProtocol(config.nodeUrl));

  return {
    networkId: networkToId(config.network),
    indexerClientConnection,
    provingServerUrl,
    relayURL,
    // Cost parameters from official counter example (midnightntwrk/example-counter).
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
    // In-memory transaction history — the ephemeral, single-use wallets
    // used for ZK proof generation do not require persistent history.
    // WalletEntrySchema is the canonical merged shielded/unshielded/dust
    // entry shape exported by wallet-sdk-facade.
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
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
 * NOTE (wallet-sdk 4.x migration): the private-constructor rework of
 * `WalletFacade` and the associated recipe/signing surface changed shape
 * substantially. The pre-`proof`/`pre-proof` intent-cloning workaround
 * from wallet-sdk 1.0.0 should be obsolete in 4.0.1 — the facade now
 * exposes a first-class `signRecipe(recipe, signSegment)` method. We use
 * that path here, but the exact ordering/segmentation still needs live
 * verification against a running Ledger 8 stack.
 */
export async function createWalletAndMidnightProvider(
  wallet: ManagedWallet,
): Promise<WalletProvider & MidnightProvider> {
  // FacadeState is fully typed by the SDK, but the wallet-sdk 4.x types
  // pull in effect/Schema generics that make the exact `state` type verbose;
  // narrow through `any` at the boundary and use only the fields we need.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = (await Rx.firstValueFrom(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wallet.facade.state().pipe(Rx.filter((s: any) => s.isSynced)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  )) as any;

  const signFn = (payload: Uint8Array) => wallet.unshieldedKeystore.signData(payload);

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

      // wallet-sdk 4.x: use the facade's first-class signRecipe path.
      const signed = await wallet.facade.signRecipe(recipe, signFn);
      return wallet.facade.finalizeRecipe(signed);
    },
    submitTx(tx) {
      return wallet.facade.submitTransaction(tx) as Promise<string>;
    },
  };
}

/**
 * Create a fully configured ManagedWallet.
 *
 * Uses the wallet-sdk 4.x `WalletFacade.init` factory: it wires the three
 * sub-wallets (shielded, unshielded, Dust) plus default submission /
 * pending-tx / proving services, and returns a started facade.
 *
 * @remarks
 * The wallet-sdk 4.x configuration surface uses effect/Schema-heavy
 * generic types whose exact shape moves between canary/patch releases.
 * The `configuration` object is intentionally passed through an `unknown`
 * cast at the boundary — this is a pragmatic bridge for the SDK bump.
 * Full type-safe wiring plus a live-network smoke test is tracked as a
 * follow-up to the SDK version bump.
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

  const configuration = buildFacadeConfig(config);

  // Capture sub-wallet handles so we can query addresses after init.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let shieldedHandle: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let unshieldedHandle: any;

  // See @remarks above for the rationale for the `unknown` cast on init.
  const facade = await WalletFacade.init({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configuration: configuration as any,
    shielded: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      shieldedHandle = ShieldedWallet(configuration as any).startWithSecretKeys(zswapSecretKeys);
      return shieldedHandle;
    },
    unshielded: () => {
      unshieldedHandle = UnshieldedWallet(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        configuration as any,
      ).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));
      return unshieldedHandle;
    },
    dust: () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      DustWallet(configuration as any).startWithSecretKey(
        dustSecretKey,
        LedgerParameters.initialParameters().dust,
      ),
  });

  try {
    const shieldedAddr = await shieldedHandle.getAddress();
    const unshieldedAddr = await unshieldedHandle.getAddress();

    return {
      facade,
      zswapSecretKeys,
      dustSecretKey,
      unshieldedKeystore,
      shieldedAddress: shieldedAddr.coinPublicKeyString(),
      unshieldedAddress: unshieldedAddr.hexString,

      async stop() {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (facade as any).stop?.();
        } finally {
          zswapSecretKeys.clear();
          dustSecretKey.clear();
        }
      },

      async waitForSync(timeoutMs = 60_000) {
        await Rx.firstValueFrom(
          facade.state().pipe(
            Rx.throttleTime(2_000),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            Rx.filter((state: any) => state.isSynced),
            Rx.timeout(timeoutMs),
          ),
        );
      },
    };
  } catch (err) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stopFn = (facade as any).stop;
      if (typeof stopFn === "function") {
        await stopFn.call(facade).catch(() => {});
      }
    } finally {
      zswapSecretKeys.clear();
      dustSecretKey.clear();
    }
    throw err;
  }
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
  let alreadyStopped = false;
  if (walletPending) {
    try {
      const wallet = await walletPending;
      await wallet.stop();
      alreadyStopped = true;
    } catch {
      // Ignore errors during cleanup
    }
  }
  if (!alreadyStopped && walletInstance) {
    await walletInstance.stop();
  }
  walletInstance = null;
  walletPending = null;
  walletNetwork = null;
}
