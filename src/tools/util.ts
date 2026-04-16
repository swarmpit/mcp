import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SwarmpitConfig } from "../config.js";
import { toolResult } from "./helpers.js";

export function registerUtilTools(
  server: McpServer,
  config: SwarmpitConfig
): void {
  server.tool(
    "swarmpit_info",
    "Show the connected Swarmpit instance URL and redaction mode",
    {},
    async () => {
      return toolResult({
        url: config.url,
        redact: config.redact,
      });
    }
  );
}
