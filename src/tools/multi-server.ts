import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { SwarmpitServerConfig } from "../config.js";
import { SwarmpitClient } from "../client.js";
import { toolResult, toolError } from "./helpers.js";

type ToolRegistrar = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any, ...rest: any[]) => unknown
) => unknown;

const activeClient = new AsyncLocalStorage<SwarmpitClient>();

/**
 * Stands in for a SwarmpitClient and forwards every call to the client of the
 * server selected by the in-flight tool call. Lets the resource registrars stay
 * single-server — they never learn that more than one target exists.
 */
function clientProxy(): SwarmpitClient {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        return (...args: unknown[]) => {
          const client = activeClient.getStore();
          if (!client) {
            throw new Error("No Swarmpit server selected for this call");
          }
          return (client as unknown as Record<string, Function>)[prop as string](...args);
        };
      },
    }
  ) as SwarmpitClient;
}

export interface MultiServer {
  /** McpServer stand-in handed to the resource registrars. */
  server: { tool: ToolRegistrar };
  /** Client stand-in handed to the resource registrars. */
  client: SwarmpitClient;
  /** Real clients, by server name — for the startup health check. */
  clients: Map<string, SwarmpitClient>;
}

const MUTATING_PREFIXES = [
  "create_",
  "update_",
  "edit_",
  "delete_",
  "scale_",
  "stop_",
  "redeploy_",
  "rollback_",
  "deactivate_",
  "pin_",
  "unpin_",
];

/**
 * Fan-out is offered only for reads. A write must always name exactly one
 * target — "apply this to every cluster I have" is not a thing a tool call
 * should be able to express by accident.
 */
export function supportsFanOut(toolName: string): boolean {
  if (MUTATING_PREFIXES.some((p) => toolName.startsWith(p))) return false;
  return toolName.startsWith("list_") || toolName.startsWith("get_") || toolName === "service_logs";
}

/** Unwrap a CallToolResult into something worth nesting under a server name. */
function unwrap(result: any): { ok: boolean; value: unknown } {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return { ok: !result?.isError, value: result };
  if (result?.isError) return { ok: false, value: text };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: true, value: text };
  }
}

export function createMultiServer(
  realServer: { tool: ToolRegistrar },
  servers: SwarmpitServerConfig[],
  defaultServer: string | undefined
): MultiServer {
  const clients = new Map(servers.map((s) => [s.name, new SwarmpitClient(s.url, s.token)]));
  const names = servers.map((s) => s.name);
  const single = servers.length === 1;

  const nameEnum = () => z.enum(names as [string, ...string[]]);
  const targetHint = defaultServer
    ? `Defaults to ${defaultServer}.`
    : `Required — no default is configured.`;

  // A single server keeps the exact schemas it has today — no extra parameter,
  // no extra tokens, existing configs behave identically.
  const serverParam = (fanOut: boolean) => {
    if (single) return undefined;
    return {
      server: (fanOut
        ? z.union([nameEnum(), z.literal("*"), z.array(nameEnum())])
        : nameEnum()
      )
        .optional()
        .describe(
          fanOut
            ? `Target Swarmpit instance: ${names.join(", ")}. Pass "*" or a list of names to query several at once and get results grouped by server. ${targetHint}`
            : `Target Swarmpit instance: ${names.join(", ")}. ${targetHint}`
        ),
    };
  };

  const resolveName = (requested?: string): string => {
    const name = requested ?? defaultServer;
    if (!name) {
      throw new Error(
        `No server specified and no default configured. Pass server: one of ${names.join(", ")}`
      );
    }
    if (!clients.has(name)) {
      throw new Error(`Unknown server "${name}". Configured servers: ${names.join(", ")}`);
    }
    return name;
  };

  const resolveTargets = (requested: unknown): string[] => {
    if (requested === "*") return [...names];
    if (Array.isArray(requested)) {
      if (requested.length === 0) throw new Error("server: [] selects nothing — omit it or pass names");
      return [...new Set(requested.map((n) => resolveName(String(n))))];
    }
    return [resolveName(requested as string | undefined)];
  };

  const server: { tool: ToolRegistrar } = {
    tool(name, description, schema, handler) {
      const fanOut = !single && supportsFanOut(name);
      const extra = serverParam(fanOut);
      return realServer.tool(
        name,
        description,
        extra ? { ...schema, ...extra } : schema,
        async (args: any, ...rest: any[]) => {
          const { server: requested, ...toolArgs } = args ?? {};

          let targets: string[];
          try {
            targets = resolveTargets(requested);
          } catch (e) {
            return toolError(e);
          }

          // Shape follows the request form, not the resolved count: asking for
          // "*" or a list always gets grouped results, even if it names one
          // server, so the caller can parse the reply without guessing.
          const grouped = requested === "*" || Array.isArray(requested);
          if (!grouped) {
            return activeClient.run(clients.get(targets[0])!, () => handler(toolArgs, ...rest));
          }

          // One cluster being down or lacking the resource must not fail the
          // whole query — report per server and let the caller judge.
          const settled = await Promise.all(
            targets.map(async (target) => {
              try {
                const result = await activeClient.run(clients.get(target)!, () =>
                  handler(toolArgs, ...rest)
                );
                return { target, ...unwrap(result) };
              } catch (e) {
                return { target, ok: false, value: e instanceof Error ? e.message : String(e) };
              }
            })
          );

          const results = Object.fromEntries(
            settled.map((s) => [s.target, s.ok ? s.value : { error: s.value }])
          );
          const failed = settled.filter((s) => !s.ok).map((s) => s.target);

          return toolResult({
            queried: targets,
            ...(failed.length ? { failed } : {}),
            results,
          });
        }
      );
    },
  };

  return { server, client: clientProxy(), clients };
}
