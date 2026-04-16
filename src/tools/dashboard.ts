import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SwarmpitClient } from "../client.js";
import { toolResult, toolError } from "./helpers.js";

export function registerDashboardTools(
  server: McpServer,
  client: SwarmpitClient
): void {
  server.tool(
    "pin_node_to_dashboard",
    "Pin a node to the Swarmpit dashboard",
    { id: z.string().describe("Node ID") },
    async ({ id }) => {
      try {
        await client.pinNodeToDashboard(id);
        return toolResult({ pinned: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "unpin_node_from_dashboard",
    "Remove a node from the Swarmpit dashboard",
    { id: z.string().describe("Node ID") },
    async ({ id }) => {
      try {
        await client.unpinNodeFromDashboard(id);
        return toolResult({ unpinned: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "pin_service_to_dashboard",
    "Pin a service to the Swarmpit dashboard",
    { id: z.string().describe("Service ID or name") },
    async ({ id }) => {
      try {
        await client.pinServiceToDashboard(id);
        return toolResult({ pinned: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "unpin_service_from_dashboard",
    "Remove a service from the Swarmpit dashboard",
    { id: z.string().describe("Service ID or name") },
    async ({ id }) => {
      try {
        await client.unpinServiceFromDashboard(id);
        return toolResult({ unpinned: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );
}
