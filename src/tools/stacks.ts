import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RedactMode } from "../config.js";
import { SwarmpitClient } from "../client.js";
import {
  sanitizeServices,
  sanitizeComposeYaml,
  resolveComposeEnvRefs,
  restoreComposeRedactions,
} from "../sanitize.js";
import { toolResult, toolError, resolveData } from "./helpers.js";
import { diffCompose } from "../compose-diff.js";

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

  const composeInput = z.union([
    z.string(),
    z.object({ $file: z.string() }).describe('Read compose from local file path'),
  ]);

  server.tool(
    "create_stack",
    "Create a new Docker Swarm stack from compose YAML. Use $env:VAR_NAME for secret values, or { $file: /path } to read from a local file.",
    {
      name: z.string().describe("Stack name"),
      compose: composeInput.describe("Compose YAML string or { $file: /path }"),
      comment: z
        .string()
        .optional()
        .describe(
          "Short one-line title for this change, recorded in the stack's compose history (e.g. 'bump api to 2.3.0, raise memory limit'). Write it as you would a commit subject."
        ),
    },
    async ({ name, compose, comment }) => {
      try {
        const yaml = resolveData(compose);
        const resolved = resolveComposeEnvRefs(yaml);
        await client.createStack({ name, spec: { compose: resolved } }, comment);
        return toolResult({ created: true, name });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "update_stack",
    "Update a Docker Swarm stack. [REDACTED] values are preserved. Use $env:VAR_NAME for new secrets, or { $file: /path } to read from a local file. Use dry_run first to see what would change.",
    {
      name: z.string().describe("Stack name"),
      compose: composeInput.describe("Compose YAML string or { $file: /path }. Leave [REDACTED] for unchanged secrets."),
      dry_run: z
        .boolean()
        .optional()
        .describe("Report what would change without writing anything"),
      comment: z
        .string()
        .optional()
        .describe(
          "Short one-line title for this change, recorded in the stack's compose history (e.g. 'bump api to 2.3.0, raise memory limit'). Write it as you would a commit subject."
        ),
    },
    async ({ name, compose, dry_run, comment }) => {
      try {
        const yaml = resolveData(compose);
        // Live service state is the source of truth — the stored stack file goes
        // stale whenever a var is changed via update_service_env or the UI.
        const [live, file] = await Promise.all([
          client.getStackCompose(name).catch(() => ({ compose: "" })),
          client.getStackFile(name).catch(() => ({ compose: "" })),
        ]);
        const { yaml: restored, stale, unresolved } = restoreComposeRedactions(yaml, [live.compose, file.compose]);
        if (unresolved.length) {
          throw new Error(
            `Refusing to write: [REDACTED] has no live or stored value at ${unresolved.join(", ")}. ` +
              "Use the real value, $env:VAR, or drop the key."
          );
        }
        const resolved = resolveComposeEnvRefs(restored);
        const staleWarning = stale.length
          ? {
              warning:
                `Stack file was stale for ${stale.join(", ")} — restored the live service value, not the stored stack-file value.`,
            }
          : {};

        if (dry_run) {
          // diffCompose only ever emits an env value the redaction mode would
          // have shown anyway; changed secrets come back as names.
          return toolResult({
            dryRun: true,
            name,
            changes: diffCompose(live.compose, resolved, { redact }),
            ...staleWarning,
          });
        }

        await client.updateStack(name, resolved, comment);

        return toolResult({ updated: true, name, ...staleWarning });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "redeploy_stack",
    "Redeploy all services in a Docker Swarm stack",
    { name: z.string().describe("Stack name"),
      comment: z
        .string()
        .optional()
        .describe(
          "Short one-line title for this change, recorded in the stack's compose history (e.g. 'bump api to 2.3.0, raise memory limit'). Write it as you would a commit subject."
        ),
    },
    async ({ name, comment }) => {
      try {
        await client.redeployStack(name, comment);
        return toolResult({ redeployed: true, name });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "rollback_stack",
    "Rollback all services in a Docker Swarm stack to their previous version",
    { name: z.string().describe("Stack name"),
      comment: z
        .string()
        .optional()
        .describe(
          "Short one-line title for this change, recorded in the stack's compose history (e.g. 'bump api to 2.3.0, raise memory limit'). Write it as you would a commit subject."
        ),
    },
    async ({ name, comment }) => {
      try {
        await client.rollbackStack(name, comment);
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
    "get_stack_history",
    "List past compose revisions of a stack (newest first). Returns metadata only unless index is given — the composes are large. Requires a Swarmpit version with /api/stacks/{name}/history.",
    {
      name: z.string().describe("Stack name"),
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Return the compose of this entry (0 = most recent)"),
      diff: z
        .boolean()
        .optional()
        .describe("With index: diff that revision against the live stack instead of returning its compose"),
    },
    async ({ name, index, diff }) => {
      try {
        const history = await client.getStackHistory(name);
        const entries = [...history].reverse();
        const summary = entries.map((e, i) => ({
          index: i,
          at: e.at,
          by: e.by,
          ...(e.comment ? { comment: e.comment } : {}),
          ...(e.trigger ? { trigger: e.trigger } : {}),
        }));

        if (index === undefined) return toolResult({ name, entries: summary });

        const entry = entries[index];
        if (!entry) {
          return toolError(`No history entry at index ${index} — the stack has ${entries.length}`);
        }
        const compose = entry.spec?.compose ?? "";

        if (diff) {
          const live = await client.getStackCompose(name).catch(() => ({ compose: "" }));
          return toolResult({
            name,
            entry: summary[index],
            changesSinceThisRevision: diffCompose(compose, live.compose, { redact }),
          });
        }

        return toolResult({
          name,
          entry: summary[index],
          compose: redact === "none" ? compose : sanitizeComposeYaml(compose, redact === "all"),
        });
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
    "Upload/create a compose file for a stack. Accepts a string or { $file: /path }.",
    {
      name: z.string().describe("Stack name"),
      compose: composeInput.describe("Compose YAML string or { $file: /path }"),
    },
    async ({ name, compose }) => {
      try {
        const yaml = resolveData(compose);
        const resolved = resolveComposeEnvRefs(yaml);
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
