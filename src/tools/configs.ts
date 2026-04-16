import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RedactMode } from "../config.js";
import { SwarmpitClient } from "../client.js";
import { toolResult, toolError } from "./helpers.js";

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
    "Create a Docker Swarm config",
    {
      configName: z.string().describe("Config name"),
      data: z.string().describe("Config data (plaintext)"),
    },
    async ({ configName, data }) => {
      try {
        await client.createConfig({ configName, data });
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
}
