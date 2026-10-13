import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../tools/register.js";

describe("MCP transport safety", () => {
  for (const redact of ["all", "sensitive", "none"] as const) {
    it(`enforces ${redact} through registered tools and fan-out`, async () => {
      const secret = "synthetic-transport-password";
      const service = { id: "audit", variables: [{ name: "DB_PASSWORD", value: secret }] };
      const originalFetch = globalThis.fetch;
      let requests = 0;
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        requests++;
        assert.equal(init.method, "GET");
        assert.match(url, /^https:\/\/(first|second)\.invalid\/api\//);
        const payload = new URL(url).pathname === "/api/stacks"
          ? [{ stackName: "audit", services: [service] }]
          : [service];
        return new Response(JSON.stringify(payload));
      }) as typeof fetch;
      const server = new McpServer({ name: "audit-test", version: "1.0.0" });
      const client = new Client({ name: "audit-client", version: "1.0.0" });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      registerAllTools(server, {
        servers: [
          { name: "first", url: "https://first.invalid", token: "synthetic-first-token" },
          { name: "second", url: "https://second.invalid", token: "synthetic-second-token" },
        ],
        defaultServer: "first", redact, redactPatterns: [],
      });
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const listing = await client.listTools();
        assert.equal(listing.tools.length, 73);
        for (const name of ["get_network_services", "get_volume_services", "list_stacks"]) {
          const result = await client.callTool({ name, arguments: { server: "*", id: "audit", name: "audit" } });
          assert.equal(result.isError, undefined);
          const text = JSON.stringify(result);
          assert.equal(text.includes(secret), redact === "none");
          assert.ok(text.includes("first"));
          assert.ok(text.includes("second"));
        }
        assert.equal(requests, 6);
        const rejected = await client.callTool({
          name: "edit_user", arguments: { id: "audit", spec: { password: { $env: "MCP_AUDIT_UNSET_PASSWORD" } } },
        });
        assert.equal(rejected.isError, true);
        assert.equal(requests, 6, "unsupported password edits must not call the API");
      } finally {
        await client.close();
        await server.close();
        globalThis.fetch = originalFetch;
      }
    });
  }
});
