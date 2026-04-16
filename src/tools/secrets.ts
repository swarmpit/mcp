import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RedactMode } from "../config.js";
import { SwarmpitClient } from "../client.js";
import { toolResult, toolError, resolveEnvRef } from "./helpers.js";

function redactSecret(secret: Record<string, unknown>, redact: RedactMode): Record<string, unknown> {
  if (redact === "none") return secret;
  const { data, ...rest } = secret;
  return { ...rest, data: data ? "[REDACTED]" : undefined };
}

export function registerSecretTools(
  server: McpServer,
  client: SwarmpitClient,
  redact: RedactMode
): void {
  server.tool(
    "list_secrets",
    "List all Docker Swarm secrets",
    {},
    async () => {
      try {
        const secrets = await client.listSecrets();
        return toolResult(secrets.map((s) => redactSecret(s, redact)));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_secret",
    "Get details of a specific Docker Swarm secret",
    { id: z.string().describe("Secret ID or name") },
    async ({ id }) => {
      try {
        const secret = await client.getSecret(id);
        return toolResult(redactSecret(secret, redact));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "create_secret",
    "Create a Docker Swarm secret. Use { $env: VAR_NAME } for the data to resolve locally.",
    {
      secretName: z.string().describe("Secret name"),
      data: z.union([
        z.string(),
        z.object({ $env: z.string() }).describe('Reference to local env var'),
      ]).describe("Secret data — plain string or { $env: VAR_NAME }"),
    },
    async ({ secretName, data }) => {
      try {
        const resolved = resolveEnvRef(data);
        await client.createSecret({ secretName, data: resolved });
        return toolResult({ created: true, secretName });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "delete_secret",
    "Delete a Docker Swarm secret. DESTRUCTIVE: requires confirm=true",
    {
      id: z.string().describe("Secret ID or name"),
      confirm: z.boolean().describe("Must be true to confirm deletion"),
    },
    async ({ id, confirm }) => {
      if (!confirm) {
        return toolError("Destructive operation: set confirm=true to delete this secret");
      }
      try {
        await client.deleteSecret(id);
        return toolResult({ deleted: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_secret_services",
    "List services using a specific secret",
    { id: z.string().describe("Secret ID or name") },
    async ({ id }) => {
      try {
        const services = await client.getSecretServices(id);
        return toolResult(services);
      } catch (e) {
        return toolError(e);
      }
    }
  );
}
