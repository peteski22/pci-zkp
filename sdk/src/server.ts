/**
 * PCI ZKP Service HTTP Server
 *
 * HTTP server that exposes proof generation endpoints.
 * Proof handlers are registered via the barrel file in ./proofs/index.ts
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { ProofConfig } from "./types.js";
import type { MidnightConfig, MidnightNetwork } from "./midnight/client.js";
import * as proofModules from "./proofs/index.js";

const PORT = parseInt(process.env.PORT || "8084", 10);

const VALID_NETWORKS = [
  "standalone",
  "testnet",
  "preview",
  "preprod",
  "mainnet",
] as const satisfies readonly MidnightNetwork[];

function parseMidnightNetwork(raw: string | undefined): MidnightNetwork | undefined {
  if (!raw) return undefined;
  if ((VALID_NETWORKS as readonly string[]).includes(raw)) return raw as MidnightNetwork;
  throw new Error(
    `Invalid MIDNIGHT_NETWORK '${raw}'. Must be one of: ${VALID_NETWORKS.join(", ")}`
  );
}

interface ProofHandler {
  generate(input: unknown): Promise<unknown>;
}

// Proof handlers registry
const proofHandlers: Record<string, ProofHandler> = {};

/**
 * Load all proof handlers from the barrel export.
 *
 * Reads Midnight network configuration from environment variables and
 * passes it through to each proof handler constructor so that handlers
 * can connect to the correct node, indexer, and proof server.
 */
function loadProofHandlers(): void {
  const network = parseMidnightNetwork(process.env.MIDNIGHT_NETWORK);

  const config: ProofConfig & MidnightConfig = {
    ...(process.env.PROOF_SERVER_URL && { proverEndpoint: process.env.PROOF_SERVER_URL }),
    ...(( process.env.MIDNIGHT_PROOF_SERVER_URL || process.env.PROOF_SERVER_URL) && {
      proofServerUrl: process.env.MIDNIGHT_PROOF_SERVER_URL ?? process.env.PROOF_SERVER_URL,
    }),
    ...(process.env.MIDNIGHT_NODE_URL && { nodeUrl: process.env.MIDNIGHT_NODE_URL }),
    ...(process.env.MIDNIGHT_INDEXER_URL && { indexerUrl: process.env.MIDNIGHT_INDEXER_URL }),
    ...(network && { network }),
    ...(process.env.MIDNIGHT_WALLET_SEED && { walletSeed: process.env.MIDNIGHT_WALLET_SEED }),
  };

  for (const [name, HandlerClass] of Object.entries(proofModules)) {
    if (typeof HandlerClass !== "function") continue;

    const handler = new HandlerClass(config) as ProofHandler;

    // Register with lowercase name (e.g., "ageverification")
    const lowerName = name.toLowerCase();
    proofHandlers[lowerName] = handler;

    // Also register short name (e.g., "age" from "AgeVerification")
    const shortName = name.replace(/Verification|Proof$/i, "").toLowerCase();
    if (shortName !== lowerName) {
      proofHandlers[shortName] = handler;
    }

    console.log(`[ZKP] Loaded proof handler: ${shortName}`);
  }
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const { method, url } = req;

  // CORS preflight
  if (method === "OPTIONS") {
    sendJson(res, {});
    return;
  }

  if (method === "GET" && url === "/health") {
    sendJson(res, { status: "healthy", service: "pci-zkp" });
    return;
  }

  if (method === "GET" && url === "/") {
    sendJson(res, {
      service: "pci-zkp",
      version: "0.1.0",
      supportedProofTypes: [...new Set(Object.keys(proofHandlers))],
      endpoints: ["/health", "/proofs/:type"],
    });
    return;
  }

  // Handle POST /proofs/:type
  if (method === "POST" && url?.startsWith("/proofs/")) {
    const proofType = url.split("/")[2];
    const handler = proofHandlers[proofType];

    if (!handler) {
      sendJson(res, {
        error: `Unknown proof type: ${proofType}`,
        available: [...new Set(Object.keys(proofHandlers))]
      }, 400);
      return;
    }

    try {
      const body = await readBody(req);
      const input = JSON.parse(body);

      // Generate proof using the handler
      // Handler is responsible for parsing its own input format
      const proof = await handler.generate(input);

      console.log(`[ZKP] Generated ${proofType} proof`);
      sendJson(res, { status: "success", proof });
    } catch (err) {
      console.error(`[ZKP] Error generating ${proofType} proof:`, err);
      sendJson(res, { error: "Proof generation failed" }, 500);
    }
    return;
  }

  sendJson(res, { error: "Not found" }, 404);
}

// Load handlers and start server
loadProofHandlers();

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Request error:", err);
    sendJson(res, { error: "Internal server error" }, 500);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`PCI ZKP Service starting on port ${PORT}`);
  console.log(`Loaded proof types: ${[...new Set(Object.keys(proofHandlers))].join(", ")}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
