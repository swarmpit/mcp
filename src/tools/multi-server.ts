import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { SwarmpitServerConfig } from "../config.js";
import { SwarmpitClient } from "../client.js";
import { toolError } from "./helpers.js";

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

export function createMultiServer(
  realServer: { tool: ToolRegistrar },
  servers: SwarmpitServerConfig[],
  defaultServer: string | undefined
): MultiServer {
  const clients = new Map(servers.map((s) => [s.name, new SwarmpitClient(s.url, s.token)]));
  const names = servers.map((s) => s.name);
  const single = servers.length === 1;

  // A single server keeps the exact schemas it has today — no extra parameter,
  // no extra tokens, existing configs behave identically.
  const serverParam = single
    ? undefined
    : {
        server: z
          .enum(names as [string, ...string[]])
          .optional()
          .describe(
            defaultServer
              ? `Target Swarmpit instance: ${names.join(", ")}. Defaults to ${defaultServer}.`
              : `Target Swarmpit instance: ${names.join(", ")}. Required — no default is configured.`
          ),
      };

  const resolve = (requested?: string): SwarmpitClient => {
    const name = requested ?? defaultServer;
    if (!name) {
      throw new Error(
        `No server specified and no default configured. Pass server: one of ${names.join(", ")}`
      );
    }
    const client = clients.get(name);
    if (!client) {
      throw new Error(`Unknown server "${name}". Configured servers: ${names.join(", ")}`);
    }
    return client;
  };

  const server: { tool: ToolRegistrar } = {
    tool(name, description, schema, handler) {
      return realServer.tool(
        name,
        description,
        serverParam ? { ...schema, ...serverParam } : schema,
        async (args: any, ...rest: any[]) => {
          const { server: requested, ...toolArgs } = args ?? {};
          let client: SwarmpitClient;
          try {
            client = resolve(requested);
          } catch (e) {
            return toolError(e);
          }
          return activeClient.run(client, () => handler(toolArgs, ...rest));
        }
      );
    },
  };

  return { server, client: clientProxy(), clients };
}
