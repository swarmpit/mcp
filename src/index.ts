#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type SwarmpitServerConfig } from "./config.js";
import { SwarmpitClient } from "./client.js";
import { setExtraRedactPatterns } from "./sanitize.js";
import { registerAllTools } from "./tools/register.js";

async function checkConnection(server: SwarmpitServerConfig, label: string): Promise<void> {
  const client = new SwarmpitClient(server.url, server.token, 10_000);
  try {
    await client.listNodes();
    console.error(`mcp-swarmpit: connected to ${label}${server.url}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`mcp-swarmpit: WARNING — cannot reach ${label}${server.url}: ${msg}`);
    console.error(`mcp-swarmpit: tools will be available but API calls may fail`);
  }
}

async function main() {
  const config = loadConfig();

  if (config.redactPatterns.length > 0) {
    setExtraRedactPatterns(config.redactPatterns);
    console.error(`mcp-swarmpit: extra redact patterns: ${config.redactPatterns.join(", ")}`);
  }

  const multi = config.servers.length > 1;
  // One unreachable instance must not stop the others being usable.
  await Promise.all(
    config.servers.map((s) => checkConnection(s, multi ? `${s.name} → ` : ""))
  );
  if (multi && !config.defaultServer) {
    console.error(
      `mcp-swarmpit: no default server — tool calls must name one of: ${config.servers.map((s) => s.name).join(", ")}`
    );
  }

  const server = new McpServer({
    name: "mcp-swarmpit",
    version: "0.2.0",
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
