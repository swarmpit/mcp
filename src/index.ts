#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { SwarmpitClient } from "./client.js";
import { setExtraRedactPatterns } from "./sanitize.js";
import { registerAllTools } from "./tools/register.js";

async function checkConnection(url: string, token: string): Promise<void> {
  const client = new SwarmpitClient(url, token, 10_000);
  try {
    await client.listNodes();
    console.error(`mcp-swarmpit: connected to ${url}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`mcp-swarmpit: WARNING — cannot reach ${url}: ${msg}`);
    console.error(`mcp-swarmpit: tools will be available but API calls may fail`);
  }
}

async function main() {
  const config = loadConfig();

  if (config.redactPatterns.length > 0) {
    setExtraRedactPatterns(config.redactPatterns);
    console.error(`mcp-swarmpit: extra redact patterns: ${config.redactPatterns.join(", ")}`);
  }

  await checkConnection(config.url, config.token);

  const server = new McpServer({
    name: "mcp-swarmpit",
    version: "0.1.0",
  });

  registerAllTools(server, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-swarmpit: running on stdio");
}

main().catch((err) => {
  console.error("mcp-swarmpit fatal:", err);
  process.exit(1);
});

process.on("SIGINT", () => process.exit(0));
