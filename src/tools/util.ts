import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SwarmpitConfig } from "../config.js";
import { toolResult } from "./helpers.js";

export function registerUtilTools(
  server: McpServer,
  config: SwarmpitConfig
): void {
  server.tool(
    "swarmpit_info",
    "Show the configured Swarmpit instances and redaction mode",
    {},
    async () => {
      return toolResult({
        servers: config.servers.map((s) => ({ name: s.name, url: s.url })),
        defaultServer: config.defaultServer,
        redact: config.redact,
        ...(config.url ? { url: config.url } : {}),
      });
    }
  );
}
