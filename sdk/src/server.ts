/**
 * PCI ZKP Service HTTP Server
 *
 * Generic HTTP server that dynamically loads proof handlers from ./proofs/
 * To add a new proof type, just add a file to the proofs directory.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = parseInt(process.env.PORT || "8084", 10);
const __dirname = dirname(fileURLToPath(import.meta.url));

interface ProofHandler {
  generate: (input: unknown) => Promise<unknown>;
}

// Dynamically loaded proof handlers
const proofHandlers: Record<string, ProofHandler> = {};

/**
 * Load all proof handlers from the proofs directory
 */
async function loadProofHandlers(): Promise<void> {
  const proofsDir = join(__dirname, "proofs");
  const files = readdirSync(proofsDir).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".js")
  );

  for (const file of files) {
    // Skip non-handler files
    if (file === "generator.ts" || file === "index.ts") continue;

    const proofType = file.replace(/\.(ts|js)$/, "").replace(/-/g, "_");

    try {
      const module = await import(`./proofs/${file.replace(".ts", ".js")}`);

      // Find the exported class (assumes PascalCase class name)
      const className = Object.keys(module).find(
        (k) => typeof module[k] === "function" && k !== "default"
      );

      if (className && module[className]) {
        const HandlerClass = module[className];
        proofHandlers[proofType.replace(/_/g, "")] = new HandlerClass({
          proofServerUrl: process.env.PROOF_SERVER_URL,
        });
        // Also register with the original name pattern
        const shortName = file.replace(/\.(ts|js)$/, "").split("-")[0];
        proofHandlers[shortName] = proofHandlers[proofType.replace(/_/g, "")];
        console.log(`[ZKP] Loaded proof handler: ${shortName}`);
      }
    } catch (err) {
      console.error(`[ZKP] Failed to load handler ${file}:`, err);
    }
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

// Start server after loading handlers
loadProofHandlers().then(() => {
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
});
