import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SwarmpitClient } from "../client.js";
import { toolResult, toolError } from "./helpers.js";

export function registerNetworkTools(
  server: McpServer,
  client: SwarmpitClient
): void {
  server.tool(
    "list_networks",
    "List all Docker Swarm networks",
    {},
    async () => {
      try {
        const networks = await client.listNetworks();
        return toolResult(networks);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_network",
    "Get details of a specific Docker Swarm network",
    { id: z.string().describe("Network ID or name") },
    async ({ id }) => {
      try {
        const network = await client.getNetwork(id);
        return toolResult(network);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "create_network",
    "Create a Docker Swarm network",
    {
      networkName: z.string().describe("Network name"),
      driver: z.string().default("overlay").describe("Network driver (default: overlay)"),
      attachable: z.boolean().default(false).describe("Whether containers can attach to this network"),
      internal: z.boolean().default(false).describe("Restrict external access"),
    },
    async ({ networkName, driver, attachable, internal }) => {
      try {
        await client.createNetwork({
          networkName,
          driver,
          attachable,
          internal,
          ingress: false,
          enableIPv6: false,
          ipam: { subnet: "", gateway: "" },
          options: [],
        });
        return toolResult({ created: true, networkName });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "delete_network",
    "Delete a Docker Swarm network. DESTRUCTIVE: requires confirm=true",
    {
      id: z.string().describe("Network ID or name"),
      confirm: z.boolean().describe("Must be true to confirm deletion"),
    },
    async ({ id, confirm }) => {
      if (!confirm) {
        return toolError("Destructive operation: set confirm=true to delete this network");
      }
      try {
        await client.deleteNetwork(id);
        return toolResult({ deleted: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_network_services",
    "List services using a specific network",
    { id: z.string().describe("Network ID or name") },
    async ({ id }) => {
      try {
        const services = await client.getNetworkServices(id);
        return toolResult(services);
      } catch (e) {
        return toolError(e);
      }
    }
  );
}
