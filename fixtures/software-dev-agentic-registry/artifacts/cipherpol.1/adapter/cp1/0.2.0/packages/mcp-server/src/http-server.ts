import { timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./create-server.js";

const PORT = Number(process.env.PORT ?? 3900);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

if (!AUTH_TOKEN) {
  console.error("MCP_AUTH_TOKEN must be set — refusing to start an unauthenticated remote MCP server.");
  process.exit(1);
}

function isAuthorized(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(AUTH_TOKEN!);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// Bound to 0.0.0.0 so other containers (Caddy) can reach it over the
// compose network — it's never exposed directly to the host or internet.
// The SDK's built-in DNS-rebinding host-header check is skipped here since
// Caddy forwards the public Host header verbatim; the bearer token below is
// this server's actual access control.
const app = createMcpExpressApp({ host: "0.0.0.0" });

app.use((req, res, next) => {
  if (!isAuthorized(req.headers.authorization)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

app.post("/mcp", async (req, res) => {
  const server = createMcpServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP request failed:", e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
});

app.listen(PORT, "0.0.0.0", () => {
  console.error(`ai-knowledge-base MCP server listening on :${PORT}/mcp`);
});
