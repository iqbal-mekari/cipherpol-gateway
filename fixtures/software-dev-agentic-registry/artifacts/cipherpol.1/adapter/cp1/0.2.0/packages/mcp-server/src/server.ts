import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./create-server.js";

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe; stdout is the MCP channel.
  console.error("ai-knowledge-base MCP server running on stdio");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
