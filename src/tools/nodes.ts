import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SwarmpitClient } from "../client.js";
import { toolResult, toolError } from "./helpers.js";

export function registerNodeTools(
  server: McpServer,
  client: SwarmpitClient
): void {
  server.tool(
    "list_nodes",
    "List all Docker Swarm nodes",
    {},
    async () => {
      try {
        const nodes = await client.listNodes();
        return toolResult(nodes);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_node",
    "Get details of a specific Docker Swarm node",
    { id: z.string().describe("Node ID") },
    async ({ id }) => {
      try {
        const node = await client.getNode(id);
        return toolResult(node);
      } catch (e) {
        return toolError(e);
      }
    }
  );
}
