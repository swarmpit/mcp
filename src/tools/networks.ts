import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SwarmpitClient } from "../client.js";
import { toolResult, toolError } from "./helpers.js";

export function registerNetworkTools(
  server: McpServer,
  client: SwarmpitClient
): void {
  server.tool(
    "list_networks",
    "List all Docker Swarm networks",
    {},
    async () => {
      try {
        const networks = await client.listNetworks();
        return toolResult(networks);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_network",
    "Get details of a specific Docker Swarm network",
    { id: z.string().describe("Network ID or name") },
    async ({ id }) => {
      try {
        const network = await client.getNetwork(id);
        return toolResult(network);
      } catch (e) {
        return toolError(e);
      }
    }
  );
}
