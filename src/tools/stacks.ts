import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RedactMode } from "../config.js";
import { SwarmpitClient } from "../client.js";
import { sanitizeServices, sanitizeComposeYaml, resolveComposeEnvRefs, restoreRedactedValues } from "../sanitize.js";
import { toolResult, toolError } from "./helpers.js";

export function registerStackTools(
  server: McpServer,
  client: SwarmpitClient,
  redact: RedactMode
): void {
  server.tool(
    "list_stacks",
    "List all Docker Swarm stacks",
    {},
    async () => {
      try {
        const stacks = await client.listStacks();
        return toolResult(stacks);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_stack",
    "Get stack details including services and compose file",
    { name: z.string().describe("Stack name") },
    async ({ name }) => {
      try {
        const [services, file] = await Promise.all([
          client.getStackServices(name),
          client.getStackFile(name).catch(() => ({ compose: "" })),
        ]);
        if (redact === "none") {
          return toolResult({ name, services, compose: file.compose });
        }
        const redactAll = redact === "all";
        return toolResult({
          name,
          services: sanitizeServices(services, redactAll),
          compose: sanitizeComposeYaml(file.compose, redactAll),
        });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "create_stack",
    "Create a new Docker Swarm stack from a compose YAML. Use $env:VAR_NAME for secret values.",
    {
      name: z.string().describe("Stack name"),
      compose: z.string().describe("Docker Compose YAML. Use $env:VAR_NAME for secrets."),
    },
    async ({ name, compose }) => {
      try {
        const resolved = resolveComposeEnvRefs(compose);
        await client.createStack({ name, spec: { compose: resolved } });
        return toolResult({ created: true, name });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "update_stack",
    "Update a Docker Swarm stack. [REDACTED] values are preserved. Use $env:VAR_NAME for new secrets.",
    {
      name: z.string().describe("Stack name"),
      compose: z.string().describe("Updated compose YAML. Leave [REDACTED] for unchanged secrets."),
    },
    async ({ name, compose }) => {
      try {
        const current = await client.getStackFile(name).catch(() => ({ compose: "" }));
        const restored = restoreRedactedValues(compose, current.compose);
        const resolved = resolveComposeEnvRefs(restored);
        await client.updateStack(name, resolved);
        return toolResult({ updated: true, name });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "redeploy_stack",
    "Redeploy all services in a Docker Swarm stack",
    { name: z.string().describe("Stack name") },
    async ({ name }) => {
      try {
        await client.redeployStack(name);
        return toolResult({ redeployed: true, name });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "rollback_stack",
    "Rollback all services in a Docker Swarm stack to their previous version",
    { name: z.string().describe("Stack name") },
    async ({ name }) => {
      try {
        await client.rollbackStack(name);
        return toolResult({ rolledBack: true, name });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "deactivate_stack",
    "Deactivate (stop) all services in a Docker Swarm stack",
    { name: z.string().describe("Stack name") },
    async ({ name }) => {
      try {
        await client.deactivateStack(name);
        return toolResult({ deactivated: true, name });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "delete_stack",
    "Delete a Docker Swarm stack. DESTRUCTIVE: requires confirm=true",
    {
      name: z.string().describe("Stack name"),
      confirm: z.boolean().describe("Must be true to confirm deletion"),
    },
    async ({ name, confirm }) => {
      if (!confirm) {
        return toolError("Destructive operation: set confirm=true to delete this stack");
      }
      try {
        await client.deleteStack(name);
        return toolResult({ deleted: true, name });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_stack_tasks",
    "List all tasks (containers) in a stack",
    { name: z.string().describe("Stack name") },
    async ({ name }) => {
      try {
        const tasks = await client.getStackTasks(name);
        return toolResult(tasks);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_stack_volumes",
    "List all volumes in a stack",
    { name: z.string().describe("Stack name") },
    async ({ name }) => {
      try {
        const volumes = await client.getStackVolumes(name);
        return toolResult(volumes);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_stack_networks",
    "List all networks in a stack",
    { name: z.string().describe("Stack name") },
    async ({ name }) => {
      try {
        const networks = await client.getStackNetworks(name);
        return toolResult(networks);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_stack_compose",
    "Get the generated compose YAML for a stack",
    { name: z.string().describe("Stack name") },
    async ({ name }) => {
      try {
        const compose = await client.getStackCompose(name);
        if (redact === "none") return toolResult(compose);
        return toolResult({ compose: sanitizeComposeYaml(compose.compose, redact === "all") });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_stack_secrets",
    "List all secrets in a stack",
    { name: z.string().describe("Stack name") },
    async ({ name }) => {
      try {
        const secrets = await client.getStackSecrets(name);
        return toolResult(secrets);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_stack_configs",
    "List all configs in a stack",
    { name: z.string().describe("Stack name") },
    async ({ name }) => {
      try {
        const configs = await client.getStackConfigs(name);
        return toolResult(configs);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "create_stack_file",
    "Upload/create a compose file for a stack",
    {
      name: z.string().describe("Stack name"),
      compose: z.string().describe("Docker Compose YAML"),
    },
    async ({ name, compose }) => {
      try {
        const resolved = resolveComposeEnvRefs(compose);
        await client.createStackFile(name, resolved);
        return toolResult({ created: true, name });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "delete_stack_file",
    "Delete the compose file for a stack. DESTRUCTIVE: requires confirm=true",
    {
      name: z.string().describe("Stack name"),
      confirm: z.boolean().describe("Must be true to confirm deletion"),
    },
    async ({ name, confirm }) => {
      if (!confirm) {
        return toolError("Destructive operation: set confirm=true to delete this stack file");
      }
      try {
        await client.deleteStackFile(name);
        return toolResult({ deleted: true, name });
      } catch (e) {
        return toolError(e);
      }
    }
  );
}
