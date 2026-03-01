import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { resolveContractAssetsPath } from "../sdk/src/midnight/contract-deployer.js";

describe("ContractDeployer - resolveContractAssetsPath", () => {
  it("should return explicit path when it exists", () => {
    // Use the platform temp directory (works on all OSes)
    const tmp = tmpdir();
    const result = resolveContractAssetsPath(tmp);
    expect(result).toBe(tmp);
  });

  it("should throw when explicit path does not exist", () => {
    expect(() =>
      resolveContractAssetsPath("/nonexistent/path/to/managed")
    ).toThrow("Contract assets not found at");
  });

  it("should throw with helpful message when default path does not exist", () => {
    // With no argument, it looks for the default contract/src/managed/proofs path
    // which won't exist in the test environment (compactc not installed)
    expect(() => resolveContractAssetsPath()).toThrow(
      /Compact contract must be compiled|Contract assets not found/
    );
  });

  it("should include compilation instructions in error message", () => {
    expect(() => resolveContractAssetsPath("/nonexistent/managed")).toThrow(
      /compact/i
    );
  });
});

describe("ContractDeployer - deployAndVerifyAge", () => {
  it("should be importable", async () => {
    // Verify the function exists and is exported
    const mod = await import("../sdk/src/midnight/contract-deployer.js");
    expect(typeof mod.deployAndVerifyAge).toBe("function");
  });

  it("should export DeploymentResult type shape", async () => {
    // Type-level test: verify the DeploymentResult interface shape
    const result = {
      txId: "abc123",
      contractAddress: "0x1234",
      blockHeight: 42,
      verified: true,
    } satisfies import("../sdk/src/midnight/contract-deployer.js").DeploymentResult;

    expect(result.txId).toBe("abc123");
    expect(result.contractAddress).toBe("0x1234");
    expect(result.blockHeight).toBe(42);
    expect(result.verified).toBe(true);
  });
});
