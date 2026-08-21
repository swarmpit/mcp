import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SwarmpitClient } from "../client.js";
import { reduceTimeseries, type ReduceOptions } from "../timeseries.js";
import { toolResult, toolError } from "./helpers.js";

const reduceParams = {
  points: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Number of buckets to downsample each series into (default 12)"),
  agg: z
    .enum(["avg", "max", "min"])
    .optional()
    .describe("How to combine samples within a bucket (default avg)"),
  match: z.string().optional().describe("Only include series whose name contains this substring"),
  stats_only: z
    .boolean()
    .optional()
    .describe("Return only min/max/avg/last per metric, dropping the sample arrays"),
};

interface ReduceArgs {
  points?: number;
  agg?: "avg" | "max" | "min";
  match?: string;
  stats_only?: boolean;
}

const toOptions = (a: ReduceArgs): ReduceOptions => ({
  points: a.points,
  agg: a.agg,
  match: a.match,
  statsOnly: a.stats_only,
});

const NOTE =
  "Raw responses often exceed 100KB, so series are downsampled by default — raise points for detail, or set stats_only for just the summary.";

export function registerTimeseriesTools(
  server: McpServer,
  client: SwarmpitClient
): void {
  server.tool(
    "get_nodes_timeseries",
    `Get timeseries data for all nodes (CPU, memory, disk over time). ${NOTE}`,
    reduceParams,
    async (args: ReduceArgs) => {
      try {
        const ts = await client.getNodesTimeseries();
        return toolResult(reduceTimeseries(ts, toOptions(args)));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_services_cpu_timeseries",
    `Get CPU usage timeseries for all services. ${NOTE}`,
    reduceParams,
    async (args: ReduceArgs) => {
      try {
        const ts = await client.getServicesCpuTimeseries();
        return toolResult(reduceTimeseries(ts, toOptions(args)));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_services_memory_timeseries",
    `Get memory usage timeseries for all services. ${NOTE}`,
    reduceParams,
    async (args: ReduceArgs) => {
      try {
        const ts = await client.getServicesMemoryTimeseries();
        return toolResult(reduceTimeseries(ts, toOptions(args)));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_task_timeseries",
    `Get timeseries data for a specific task. ${NOTE}`,
    { name: z.string().describe("Task name"), ...reduceParams },
    async ({ name, ...args }: ReduceArgs & { name: string }) => {
      try {
        const ts = await client.getTaskTimeseries(name);
        return toolResult(reduceTimeseries(ts, toOptions(args)));
      } catch (e) {
        return toolError(e);
      }
    }
  );
}
