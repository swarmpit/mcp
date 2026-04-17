import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RedactMode } from "../config.js";
import { SwarmpitClient } from "../client.js";
import { sanitizeService, sanitizeServices } from "../sanitize.js";
import { toolResult, toolError, resolveEnvRef, prepareServiceForUpdate } from "./helpers.js";

export function registerServiceTools(
  server: McpServer,
  client: SwarmpitClient,
  redact: RedactMode
): void {
  server.tool(
    "list_services",
    "List all Docker Swarm services",
    {},
    async () => {
      try {
        const services = await client.listServices();
        return toolResult(redact === "none" ? services : sanitizeServices(services, redact === "all"));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_service",
    "Get detailed info for a specific Docker Swarm service",
    { id: z.string().describe("Service ID or name") },
    async ({ id }) => {
      try {
        const service = await client.getService(id);
        return toolResult(redact === "none" ? service : sanitizeService(service, redact === "all"));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "service_logs",
    "Get logs for a Docker Swarm service",
    {
      id: z.string().describe("Service ID or name"),
      since: z.string().optional().describe("Time window as Go duration (e.g. '30s', '5m', '1h', '24h'). Default: 5m"),
    },
    async ({ id, since }) => {
      try {
        const logs = await client.getServiceLogs(id, since);
        return toolResult(logs);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "create_service",
    "Create a new Docker Swarm service",
    { spec: z.record(z.unknown()).describe("Service specification object") },
    async ({ spec }) => {
      try {
        const result = await client.createService(spec);
        return toolResult(result);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "update_service",
    "Update an existing Docker Swarm service",
    {
      id: z.string().describe("Service ID or name"),
      spec: z.record(z.unknown()).describe("Updated service specification"),
    },
    async ({ id, spec }) => {
      try {
        await client.updateService(id, spec);
        return toolResult({ updated: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "redeploy_service",
    "Redeploy a Docker Swarm service, optionally with a new image tag",
    {
      id: z.string().describe("Service ID or name"),
      tag: z.string().optional().describe("Optional new image tag to deploy"),
    },
    async ({ id, tag }) => {
      try {
        await client.redeployService(id, tag);
        return toolResult({ redeployed: true, id, tag: tag ?? "current" });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "rollback_service",
    "Rollback a Docker Swarm service to its previous version",
    { id: z.string().describe("Service ID or name") },
    async ({ id }) => {
      try {
        await client.rollbackService(id);
        return toolResult({ rolledBack: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "scale_service",
    "Scale a Docker Swarm service to a specific number of replicas",
    {
      id: z.string().describe("Service ID or name"),
      replicas: z.number().int().min(0).describe("Desired number of replicas"),
    },
    async ({ id, replicas }) => {
      try {
        const service = await client.getService(id);
        await client.updateService(id, prepareServiceForUpdate({ ...service, replicas }));
        return toolResult({ scaled: true, id, from: service.replicas, to: replicas });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "list_service_tasks",
    "List tasks (containers) for a Docker Swarm service",
    { id: z.string().describe("Service ID or name") },
    async ({ id }) => {
      try {
        const tasks = await client.getServiceTasks(id);
        return toolResult(tasks);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "stop_service",
    "Stop a Docker Swarm service (scale to 0 replicas)",
    { id: z.string().describe("Service ID or name") },
    async ({ id }) => {
      try {
        await client.stopService(id);
        return toolResult({ stopped: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "delete_service",
    "Delete a Docker Swarm service. DESTRUCTIVE: requires confirm=true",
    {
      id: z.string().describe("Service ID or name"),
      confirm: z.boolean().describe("Must be true to confirm deletion"),
    },
    async ({ id, confirm }) => {
      if (!confirm) {
        return toolError("Destructive operation: set confirm=true to delete this service");
      }
      try {
        await client.deleteService(id);
        return toolResult({ deleted: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "update_service_env",
    "Set or remove environment variables on a service. Supports $env references for secret values.",
    {
      id: z.string().describe("Service ID or name"),
      set: z
        .record(
          z.union([
            z.string(),
            z.object({ $env: z.string() }).describe('Reference to local env var, e.g. { "$env": "MY_SECRET" }'),
          ])
        )
        .optional()
        .describe("Env vars to set. Values can be plain strings or { $env: VAR_NAME } references"),
      remove: z.array(z.string()).optional().describe("Env var names to remove"),
    },
    async ({ id, set, remove }) => {
      try {
        const service = await client.getService(id);
        let variables = [...(service.variables ?? [])];

        if (remove?.length) {
          const removeSet = new Set(remove);
          variables = variables.filter((v) => !removeSet.has(v.name));
        }

        const changedNames: string[] = [];
        if (set) {
          for (const [name, rawValue] of Object.entries(set)) {
            const value = resolveEnvRef(rawValue);
            const existing = variables.find((v) => v.name === name);
            if (existing) {
              existing.value = value;
            } else {
              variables.push({ name, value });
            }
            changedNames.push(name);
          }
        }

        await client.updateService(id, prepareServiceForUpdate({ ...service, variables }));
        return toolResult({ updated: true, id, set: changedNames, removed: remove ?? [] });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_service_env",
    "Get specific environment variable values from a service by name",
    {
      id: z.string().describe("Service ID or name"),
      names: z.array(z.string()).describe("Env var names to retrieve"),
    },
    async ({ id, names }) => {
      try {
        const service = await client.getService(id);
        const found: Record<string, string | null> = {};
        for (const name of names) {
          const v = service.variables?.find((v) => v.name === name);
          found[name] = v?.value ?? null;
        }
        return toolResult(found);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_service_compose",
    "Get the compose YAML for a specific service",
    { id: z.string().describe("Service ID or name") },
    async ({ id }) => {
      try {
        const compose = await client.getServiceCompose(id);
        return toolResult(compose);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_service_networks",
    "Get networks attached to a specific service",
    { id: z.string().describe("Service ID or name") },
    async ({ id }) => {
      try {
        const networks = await client.getServiceNetworks(id);
        return toolResult(networks);
      } catch (e) {
        return toolError(e);
      }
    }
  );
}
