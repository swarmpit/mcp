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
}
