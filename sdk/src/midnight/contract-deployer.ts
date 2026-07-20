/**
 * Ephemeral Contract Deployment for Age Verification
 *
 * Each proof interaction deploys a FRESH contract instance to prevent
 * cross-verifier correlation (Company A and B cannot link proofs to the same user).
 *
 * Flow:
 * 1. Load compiled contract assets from disk
 * 2. Create age witnesses (private birth date → ZK circuit)
 * 3. Build MidnightProviders (public data, proof, wallet, zk config, private state)
 * 4. Deploy fresh contract with initial private state
 * 5. Call verifyAge circuit — generates ZK proof, submits tx
 * 6. Return DeploymentResult with txId, contractAddress, blockHeight
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type { MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import { createAgeWitnesses, parseDateForCircuit } from "./witnesses.js";
import {
  createWalletAndMidnightProvider,
  type ManagedWallet,
  type WalletConfig,
} from "./wallet.js";

export interface DeploymentResult {
  txId: string;
  contractAddress: string;
  blockHeight: number;
  verified: boolean;
}

/**
 * Resolve the path to compiled contract assets (managed/ directory).
 *
 * Priority: explicit path > default relative path from contract/managed.
 *
 * The returned directory is the root that Compact 0.31.0 produces — it holds
 * `contract/`, `keys/`, `zkir/`, and `compiler/` subdirectories.
 * NodeZkConfigProvider reads `keys/` and `zkir/` from this base directory.
 *
 * @throws Error if the resolved path does not exist
 */
export function resolveContractAssetsPath(contractAssetsPath?: string): string {
  if (contractAssetsPath) {
    if (!existsSync(contractAssetsPath)) {
      throw new Error(
        `Contract assets not found at: ${contractAssetsPath}\n` +
          "Run the Compact compiler to generate contract assets: cd contract && pnpm run compact"
      );
    }
    return contractAssetsPath;
  }

  // Default: look relative to the SDK package (../../../contract/managed)
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const defaultPath = resolve(thisDir, "..", "..", "..", "contract", "managed");

  if (!existsSync(defaultPath)) {
    throw new Error(
      `Compiled contract assets not found at default path: ${defaultPath}\n` +
        "The Compact contract must be compiled before on-chain proofs can be generated.\n" +
        "Install the compiler: compact update 0.31.0\n" +
        "Then compile: cd contract && pnpm run compact"
    );
  }

  return defaultPath;
}

/**
 * Deploy a fresh ephemeral contract and call verifyAge.
 *
 * Each call deploys a new contract instance for privacy — no cross-verifier linkability.
 */
export async function deployAndVerifyAge(
  wallet: ManagedWallet,
  config: WalletConfig,
  birthDate: Date,
  minAge: number,
  currentDate: Date,
  contractAssetsPath: string,
): Promise<DeploymentResult> {
  if (!Number.isInteger(minAge) || minAge < 0) {
    throw new RangeError("minAge must be a non-negative integer");
  }

  // 1. Create wallet/midnight provider (bridges facade to midnight-js-contracts)
  const walletAndMidnightProvider = await createWalletAndMidnightProvider(wallet);

  // 2. Load compiled contract and build ZK config provider
  const zkConfigProvider = new NodeZkConfigProvider<string>(contractAssetsPath);

  // 3. Build the compiled contract with witnesses
  // The Contract type is loaded dynamically from compiled assets (may not exist at build time).
  // Type assertions are unavoidable since the contract module doesn't exist at compile time.
  const { Contract } = await loadContractModule(contractAssetsPath);

  // Create witness functions that provide the private birth date to the ZK circuit.
  // The birth date never leaves the device — only the proof that age >= threshold.
  const ageWitnesses = createAgeWitnesses(birthDate);

  // The compiled contract types are fully dynamic (loaded at runtime from compactc output).
  // Type assertions are unavoidable — the contract module doesn't exist at compile time.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const makeContract = CompiledContract.make as (...args: any[]) => any;
  const withWitnesses = CompiledContract.withWitnesses as (...args: any[]) => any;
  const withAssets = CompiledContract.withCompiledFileAssets as (...args: any[]) => any;
  const compiledContract = makeContract("proofs", Contract).pipe(
    withWitnesses(ageWitnesses),
    withAssets(contractAssetsPath),
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // 4. Assemble all providers
  //
  // levelPrivateStateProvider (midnight-js 4.x) requires an `accountId` and a
  // `privateStoragePasswordProvider`. Each proof interaction deploys a fresh
  // ephemeral contract, so we generate a fresh account id per call and use an
  // in-memory random password — the on-disk private state is throwaway.
  const ephemeralId = randomUUID();
  const ephemeralPassword = randomUUID();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers: MidnightProviders<any, any, any> = {
    privateStateProvider: levelPrivateStateProvider({
      accountId: `pci-age-verification-${ephemeralId}`,
      privateStoragePasswordProvider: () => ephemeralPassword,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexerUrl, config.indexerWsUrl),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServerUrl, zkConfigProvider),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };

  // 5. Deploy + call inside try/finally so the ephemeral private-state entry
  // is removed even if the tx fails. levelPrivateStateProvider exposes clear()
  // (nukes all contract private states in this scope) and remove(id) — see
  // docs.midnight.network/api-reference/midnight-js/midnight-js-types/interfaces/PrivateStateProvider.
  // The provider itself has no close/dispose; the underlying LevelDB dir will
  // remain empty on disk but functional state is released.
  const privateStateId = "ageVerificationPrivateState";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deployed = await (deployContract as any)(providers, {
      compiledContract,
      privateStateId,
      initialPrivateState: {},
    });

    const contractAddress = deployed.deployTxData.public.contractAddress;

    // 6. Call verifyAge circuit
    const { year, month, day } = parseDateForCircuit(currentDate);

    // The callTx interface is dynamically typed from the compiled contract.
    // The circuit can return verified=false for underage users without throwing,
    // so we must read the actual on-chain state after the tx.
    const contract = deployed as unknown as {
      callTx: {
        verifyAge(
          minAge: bigint,
          currentYear: bigint,
          currentMonth: bigint,
          currentDay: bigint,
        ): Promise<{ txHash: string; blockHeight: number }>;
        getVerified(): Promise<{ txHash: string; blockHeight: number; result: boolean }>;
      };
    };

    const result = await contract.callTx.verifyAge(
      BigInt(minAge),
      year,
      month,
      day,
    );

    // Read the actual verified state from the contract (the circuit sets it via disclose())
    const verifiedResult = await contract.callTx.getVerified();

    return {
      txId: result.txHash,
      contractAddress: String(contractAddress),
      blockHeight: result.blockHeight,
      verified: verifiedResult.result,
    };
  } finally {
    // Best-effort cleanup — swallow errors so the outer flow always terminates.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const psp = providers.privateStateProvider as any;
      if (typeof psp?.remove === "function") {
        await psp.remove(privateStateId);
      } else if (typeof psp?.clear === "function") {
        await psp.clear();
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Attempt to load the compiled contract module from the managed directory.
 *
 * Compact 0.31.0 emits ESM at `<managed>/contract/index.js`. Older 0.28.0
 * output (`<managed>/index.cjs`) is also accepted for backwards compatibility
 * while transitional builds may still be around.
 */
async function loadContractModule(assetsPath: string): Promise<{
  Contract: unknown;
  witnesses: unknown;
}> {
  // Compact 0.31.0 layout: managed/contract/index.js (ESM).
  const esmPath = resolve(assetsPath, "contract", "index.js");
  if (existsSync(esmPath)) {
    return import(pathToFileURL(esmPath).href);
  }

  // Legacy 0.28.0 layout: managed/index.cjs (assetsPath IS the managed/ dir).
  const legacyCjs = resolve(assetsPath, "index.cjs");
  if (existsSync(legacyCjs)) {
    return import(pathToFileURL(legacyCjs).href);
  }
  const legacyEsm = resolve(assetsPath, "index.js");
  if (existsSync(legacyEsm)) {
    return import(pathToFileURL(legacyEsm).href);
  }

  throw new Error(
    `No compiled contract module found under ${assetsPath}. Looked for:\n` +
      `  ${esmPath}\n  ${legacyCjs}\n  ${legacyEsm}\n` +
      "Ensure the Compact contract has been compiled with: cd contract && pnpm run compact"
  );
}
