import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SwarmpitClient } from "../client.js";
import { toolResult, toolError } from "./helpers.js";

export function registerTaskTools(
  server: McpServer,
  client: SwarmpitClient
): void {
  server.tool(
    "list_tasks",
    "List all Docker Swarm tasks across all services",
    {},
    async () => {
      try {
        const tasks = await client.listTasks();
        return toolResult(tasks);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_task",
    "Get details of a specific Docker Swarm task",
    { id: z.string().describe("Task ID") },
    async ({ id }) => {
      try {
        const task = await client.getTask(id);
        return toolResult(task);
      } catch (e) {
        return toolError(e);
      }
    }
  );
}
