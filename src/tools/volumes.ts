import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SwarmpitClient } from "../client.js";
import { toolResult, toolError } from "./helpers.js";

export function registerVolumeTools(
  server: McpServer,
  client: SwarmpitClient
): void {
  server.tool(
    "list_volumes",
    "List all Docker Swarm volumes",
    {},
    async () => {
      try {
        const volumes = await client.listVolumes();
        return toolResult(volumes);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_volume",
    "Get details of a specific Docker Swarm volume",
    { name: z.string().describe("Volume name") },
    async ({ name }) => {
      try {
        const volume = await client.getVolume(name);
        return toolResult(volume);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "create_volume",
    "Create a Docker Swarm volume",
    {
      volumeName: z.string().describe("Volume name"),
      driver: z.string().default("local").describe("Volume driver (default: local)"),
    },
    async ({ volumeName, driver }) => {
      try {
        await client.createVolume({ volumeName, driver, options: [] });
        return toolResult({ created: true, volumeName });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "delete_volume",
    "Delete a Docker Swarm volume. DESTRUCTIVE: requires confirm=true",
    {
      name: z.string().describe("Volume name"),
      confirm: z.boolean().describe("Must be true to confirm deletion"),
    },
    async ({ name, confirm }) => {
      if (!confirm) {
        return toolError("Destructive operation: set confirm=true to delete this volume");
      }
      try {
        await client.deleteVolume(name);
        return toolResult({ deleted: true, name });
      } catch (e) {
        return toolError(e);
      }
    }
  );
}
