import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SwarmpitClient } from "../client.js";
import { toolResult, toolError } from "./helpers.js";

export function registerTimeseriesTools(
  server: McpServer,
  client: SwarmpitClient
): void {
  server.tool(
    "get_nodes_timeseries",
    "Get timeseries data for all nodes (CPU, memory, disk over time)",
    {},
    async () => {
      try {
        const ts = await client.getNodesTimeseries();
        return toolResult(ts);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_services_cpu_timeseries",
    "Get CPU usage timeseries for all services",
    {},
    async () => {
      try {
        const ts = await client.getServicesCpuTimeseries();
        return toolResult(ts);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_services_memory_timeseries",
    "Get memory usage timeseries for all services",
    {},
    async () => {
      try {
        const ts = await client.getServicesMemoryTimeseries();
        return toolResult(ts);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_task_timeseries",
    "Get timeseries data for a specific task",
    { name: z.string().describe("Task name") },
    async ({ name }) => {
      try {
        const ts = await client.getTaskTimeseries(name);
        return toolResult(ts);
      } catch (e) {
        return toolError(e);
      }
    }
  );
}
