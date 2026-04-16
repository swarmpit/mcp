import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SwarmpitConfig } from "../config.js";
import { SwarmpitClient } from "../client.js";
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
  const client = new SwarmpitClient(config.url, config.token);
  const redact = config.redact;

  registerUtilTools(server, config);
  registerServiceTools(server, client, redact);
  registerStackTools(server, client, redact);
  registerNetworkTools(server, client);
  registerNodeTools(server, client);
  registerTaskTools(server, client);
  registerVolumeTools(server, client);
  registerSecretTools(server, client, redact);
  registerConfigTools(server, client, redact);
  registerAdminTools(server, client);
  registerDashboardTools(server, client);
  registerTimeseriesTools(server, client);
}
