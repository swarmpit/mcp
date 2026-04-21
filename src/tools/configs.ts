import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RedactMode } from "../config.js";
import { SwarmpitClient } from "../client.js";
import { toolResult, toolError, resolveData } from "./helpers.js";

function redactConfig(config: Record<string, unknown>, redact: RedactMode): Record<string, unknown> {
  if (redact === "none") return config;
  const { data, ...rest } = config;
  return { ...rest, data: data ? "[REDACTED]" : undefined };
}

export function registerConfigTools(
  server: McpServer,
  client: SwarmpitClient,
  redact: RedactMode
): void {
  server.tool(
    "list_configs",
    "List all Docker Swarm configs",
    {},
    async () => {
      try {
        const configs = await client.listConfigs();
        return toolResult(configs.map((c) => redactConfig(c, redact)));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_config",
    "Get details of a specific Docker Swarm config",
    { id: z.string().describe("Config ID or name") },
    async ({ id }) => {
      try {
        const config = await client.getConfig(id);
        return toolResult(redactConfig(config, redact));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "create_config",
    "Create a Docker Swarm config. Data can be plain, { $env: VAR_NAME } to resolve from env, or { $file: /path } to read from a local file (avoids sending large content through LLM context).",
    {
      configName: z.string().describe("Config name"),
      data: z.union([
        z.string(),
        z.object({ $env: z.string() }).describe('Reference to local env var'),
        z.object({ $file: z.string() }).describe('Read from local file path'),
      ]).describe("Config data — string, { $env: VAR_NAME }, or { $file: /path }"),
    },
    async ({ configName, data }) => {
      try {
        const resolved = resolveData(data);
        await client.createConfig({ configName, data: resolved });
        return toolResult({ created: true, configName });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "delete_config",
    "Delete a Docker Swarm config. DESTRUCTIVE: requires confirm=true",
    {
      id: z.string().describe("Config ID or name"),
      confirm: z.boolean().describe("Must be true to confirm deletion"),
    },
    async ({ id, confirm }) => {
      if (!confirm) {
        return toolError("Destructive operation: set confirm=true to delete this config");
      }
      try {
        await client.deleteConfig(id);
        return toolResult({ deleted: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_config_services",
    "List services using a specific config",
    { id: z.string().describe("Config ID or name") },
    async ({ id }) => {
      try {
        const services = await client.getConfigServices(id);
        return toolResult(services);
      } catch (e) {
        return toolError(e);
      }
    }
  );
}
