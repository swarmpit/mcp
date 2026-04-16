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

  server.tool(
    "get_node_tasks",
    "List all tasks running on a specific node",
    { id: z.string().describe("Node ID") },
    async ({ id }) => {
      try {
        const tasks = await client.getNodeTasks(id);
        return toolResult(tasks);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "edit_node",
    "Edit a Docker Swarm node (e.g. change availability, role, labels)",
    {
      id: z.string().describe("Node ID"),
      spec: z.record(z.unknown()).describe("Node specification updates"),
    },
    async ({ id, spec }) => {
      try {
        await client.editNode(id, spec);
        return toolResult({ updated: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "delete_node",
    "Remove a Docker Swarm node. DESTRUCTIVE: requires confirm=true",
    {
      id: z.string().describe("Node ID"),
      confirm: z.boolean().describe("Must be true to confirm deletion"),
    },
    async ({ id, confirm }) => {
      if (!confirm) {
        return toolError("Destructive operation: set confirm=true to remove this node");
      }
      try {
        await client.deleteNode(id);
        return toolResult({ deleted: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );
}
