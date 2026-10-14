import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SwarmpitConfig } from "../config.js";
import { createMultiServer } from "./multi-server.js";
import { registerUtilTools } from "./util.js";
import { registerServiceTools } from "./services.js";
import { registerStackTools } from "./stacks.js";
import { registerNetworkTools } from "./networks.js";
import { registerNodeTools } from "./nodes.js";
import { registerTaskTools } from "./tasks.js";
import { registerVolumeTools } from "./volumes.js";
import { registerSecretTools } from "./secrets.js";
import { registerConfigTools } from "./configs.js";
import { registerAdminTools } from "./admin.js";
import { registerDashboardTools } from "./dashboard.js";
import { registerTimeseriesTools } from "./timeseries.js";

export function registerAllTools(
  server: McpServer,
  config: SwarmpitConfig
): void {
  const multi = createMultiServer(server as never, config.servers, config.defaultServer);
  const scoped = multi.server as unknown as McpServer;
  const client = multi.client;
  const redact = config.redact;

  // swarmpit_info describes the whole process, so it registers unscoped.
  registerUtilTools(server, config);

  registerServiceTools(scoped, client, redact);
  registerStackTools(scoped, client, redact);
  registerNetworkTools(scoped, client, redact);
  registerNodeTools(scoped, client);
  registerTaskTools(scoped, client);
  registerVolumeTools(scoped, client, redact);
  registerSecretTools(scoped, client, redact);
  registerConfigTools(scoped, client, redact);
  registerAdminTools(scoped, client, redact);
  registerDashboardTools(scoped, client);
  registerTimeseriesTools(scoped, client);
}
