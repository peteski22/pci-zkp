/**
 * PCI ZKP Service HTTP Server
 *
 * Simple HTTP server for the ZKP Service API.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";

const PORT = parseInt(process.env.PORT || "8084", 10);

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
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

  if (method === "GET" && url === "/health") {
    sendJson(res, { status: "healthy", service: "pci-zkp" });
    return;
  }

  if (method === "GET" && url === "/") {
    sendJson(res, {
      service: "pci-zkp",
      version: "0.1.0",
      endpoints: ["/health", "/proofs/age", "/proofs/credential"],
    });
    return;
  }

  if (method === "POST" && url === "/proofs/age") {
    try {
      const body = await readBody(req);
      const input = JSON.parse(body);
      // Placeholder - would generate actual ZK proof
      sendJson(res, {
        status: "success",
        proof: {
          verified: true,
          publicSignals: { ageOver: input.minAge || 18 },
        },
      });
    } catch {
      sendJson(res, { error: "Invalid request" }, 400);
    }
    return;
  }

  sendJson(res, { error: "Not found" }, 404);
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Request error:", err);
    sendJson(res, { error: "Internal server error" }, 500);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`PCI ZKP Service starting on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
