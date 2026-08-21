import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { createMultiServer } from "../tools/multi-server.js";
import { registerServiceTools } from "../tools/services.js";
import { registerUtilTools } from "../tools/util.js";

function mockServer() {
  const handlers: Record<string, Function> = {};
  const schemas: Record<string, Record<string, unknown>> = {};
  return {
    handlers,
    schemas,
    tool(name: string, _desc: string, schema: Record<string, unknown>, handler: Function) {
      handlers[name] = handler;
      schemas[name] = schema;
    },
  };
}

const SERVERS = [
  { name: "prod", url: "https://prod.example.com", token: "prod-token" },
  { name: "play", url: "https://play.example.com", token: "play-token" },
];

/** Registers a probe tool that reports which server's client it was routed to. */
function probeSetup(defaultServer?: string) {
  const real = mockServer();
  const multi = createMultiServer(real as never, SERVERS, defaultServer);
  const seen: string[] = [];
  for (const [name, client] of multi.clients) {
    (client as unknown as Record<string, Function>).listNodes = () => {
      seen.push(name);
      return Promise.resolve([]);
    };
  }
  multi.server.tool("probe", "probe", {}, async (args: any) => {
    await (multi.client as unknown as Record<string, Function>).listNodes();
    return { args };
  });
  return { real, multi, seen };
}

describe("multi-server dispatch", () => {
  it("routes a call to the named server", async () => {
    const { real, seen } = probeSetup("prod");
    await real.handlers.probe({ server: "play" });
    assert.deepEqual(seen, ["play"]);
  });

  it("falls back to the configured default", async () => {
    const { real, seen } = probeSetup("prod");
    await real.handlers.probe({});
    assert.deepEqual(seen, ["prod"]);
  });

  it("errors instead of guessing when no default is configured", async () => {
    const { real, seen } = probeSetup(undefined);
    const result: any = await real.handlers.probe({});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No server specified.*prod, play/s);
    assert.deepEqual(seen, []);
  });

  it("errors on an unknown server name", async () => {
    const { real, seen } = probeSetup("prod");
    const result: any = await real.handlers.probe({ server: "nope" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown server "nope"/);
    assert.deepEqual(seen, []);
  });

  it("strips the server arg before the handler sees it", async () => {
    const { real } = probeSetup("prod");
    const result: any = await real.handlers.probe({ server: "play", id: "svc1" });
    assert.deepEqual(result.args, { id: "svc1" });
  });

  it("keeps concurrent calls on their own server", async () => {
    const real = mockServer();
    const multi = createMultiServer(real as never, SERVERS, "prod");
    for (const [name, client] of multi.clients) {
      (client as unknown as Record<string, Function>).getService = async () => {
        await new Promise((r) => setTimeout(r, name === "prod" ? 20 : 1));
        return { serviceName: name };
      };
    }
    multi.server.tool("probe", "probe", {}, async () =>
      (multi.client as unknown as Record<string, Function>).getService("x")
    );

    const [a, b] = await Promise.all([
      real.handlers.probe({ server: "prod" }),
      real.handlers.probe({ server: "play" }),
    ]);
    assert.equal((a as any).serviceName, "prod");
    assert.equal((b as any).serviceName, "play");
  });
});

describe("multi-server tool schemas", () => {
  it("adds a server enum to every tool when several are configured", () => {
    const real = mockServer();
    const multi = createMultiServer(real as never, SERVERS, "prod");
    registerServiceTools(multi.server as never, multi.client, "all");

    const schema = real.schemas.get_service as Record<string, any>;
    assert.ok(schema.server, "expected a server param");
    assert.deepEqual(schema.server._def.innerType._def.values, ["prod", "play"]);
    assert.match(schema.server.description, /Defaults to prod/);
    assert.ok(schema.id, "existing params are preserved");
  });

  it("adds nothing at all for a single server", () => {
    const real = mockServer();
    const multi = createMultiServer(real as never, [SERVERS[0]], "prod");
    registerServiceTools(multi.server as never, multi.client, "all");

    assert.equal(real.schemas.get_service.server, undefined);
    assert.deepEqual(Object.keys(real.schemas.list_services), []);
  });

  it("says the param is required when no default is configured", () => {
    const real = mockServer();
    const multi = createMultiServer(real as never, SERVERS, undefined);
    registerServiceTools(multi.server as never, multi.client, "all");
    assert.match((real.schemas.get_service.server as any).description, /Required/);
  });
});

describe("loadConfig multi-server", () => {
  const saved = { ...process.env };
  let dir: string;

  const clearEnv = () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SWARMPIT_")) delete process.env[key];
    }
  };

  beforeEach(() => {
    clearEnv();
    dir = mkdtempSync(join(tmpdir(), "mcp-multi-"));
  });

  afterEach(() => {
    clearEnv();
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the legacy single-server env as a server named default", () => {
    process.env.SWARMPIT_URL = "https://one.example.com/";
    process.env.SWARMPIT_TOKEN = "t";

    const config = loadConfig();
    assert.deepEqual(config.servers, [
      { name: "default", url: "https://one.example.com", token: "t" },
    ]);
    assert.equal(config.defaultServer, "default");
    assert.equal(config.url, "https://one.example.com");
    assert.equal(config.token, "t");
  });

  it("loads servers from SWARMPIT_CONFIG_FILE, including tokenFile", () => {
    const tokenPath = join(dir, "prod-token");
    writeFileSync(tokenPath, "prod-secret\n");
    const cfgPath = join(dir, "swarmpit-config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        default: "prod",
        servers: {
          prod: { url: "https://prod.example.com//", tokenFile: tokenPath },
          play: { url: "https://play.example.com", token: "play-secret" },
        },
      })
    );
    process.env.SWARMPIT_CONFIG_FILE = cfgPath;

    const config = loadConfig();
    assert.deepEqual(config.servers, [
      { name: "prod", url: "https://prod.example.com", token: "prod-secret" },
      { name: "play", url: "https://play.example.com", token: "play-secret" },
    ]);
    assert.equal(config.defaultServer, "prod");
  });

  it("loads servers from SWARMPIT_SERVERS with per-name env vars", () => {
    process.env.SWARMPIT_SERVERS = "prod, swarmpit-play";
    process.env.SWARMPIT_PROD_URL = "https://prod.example.com";
    process.env.SWARMPIT_PROD_TOKEN = "a";
    process.env.SWARMPIT_SWARMPIT_PLAY_URL = "https://play.example.com";
    process.env.SWARMPIT_SWARMPIT_PLAY_TOKEN = "b";
    process.env.SWARMPIT_DEFAULT_SERVER = "swarmpit-play";

    const config = loadConfig();
    assert.deepEqual(config.servers.map((s) => s.name), ["prod", "swarmpit-play"]);
    assert.equal(config.defaultServer, "swarmpit-play");
  });

  it("leaves defaultServer unset when several servers and no explicit default", () => {
    process.env.SWARMPIT_SERVERS = "a,b";
    process.env.SWARMPIT_A_URL = "https://a.example.com";
    process.env.SWARMPIT_A_TOKEN = "a";
    process.env.SWARMPIT_B_URL = "https://b.example.com";
    process.env.SWARMPIT_B_TOKEN = "b";

    const config = loadConfig();
    assert.equal(config.defaultServer, undefined);
    assert.equal(config.url, undefined);
  });

  it("throws when a listed server has no URL", () => {
    process.env.SWARMPIT_SERVERS = "prod";
    process.env.SWARMPIT_PROD_TOKEN = "a";
    assert.throws(() => loadConfig(), /SWARMPIT_PROD_URL is not set/);
  });

  it("throws when a listed server has no token", () => {
    process.env.SWARMPIT_SERVERS = "prod";
    process.env.SWARMPIT_PROD_URL = "https://prod.example.com";
    assert.throws(() => loadConfig(), /SWARMPIT_PROD_TOKEN_FILE/);
  });

  it("throws when the default names an unconfigured server", () => {
    process.env.SWARMPIT_SERVERS = "prod";
    process.env.SWARMPIT_PROD_URL = "https://prod.example.com";
    process.env.SWARMPIT_PROD_TOKEN = "a";
    process.env.SWARMPIT_DEFAULT_SERVER = "ghost";
    assert.throws(() => loadConfig(), /SWARMPIT_DEFAULT_SERVER="ghost"/);
  });

  it("throws when the config file defines no servers", () => {
    const cfgPath = join(dir, "empty.json");
    writeFileSync(cfgPath, JSON.stringify({ servers: {} }));
    process.env.SWARMPIT_CONFIG_FILE = cfgPath;
    assert.throws(() => loadConfig(), /defines no servers/);
  });

  it("config file takes precedence over SWARMPIT_SERVERS and legacy vars", () => {
    const cfgPath = join(dir, "cfg.json");
    writeFileSync(cfgPath, JSON.stringify({ servers: { only: { url: "https://only.example.com", token: "t" } } }));
    process.env.SWARMPIT_CONFIG_FILE = cfgPath;
    process.env.SWARMPIT_SERVERS = "ignored";
    process.env.SWARMPIT_URL = "https://ignored.example.com";
    process.env.SWARMPIT_TOKEN = "ignored";

    assert.deepEqual(loadConfig().servers.map((s) => s.name), ["only"]);
  });
});

describe("swarmpit_info", () => {
  it("lists every configured server", async () => {
    const real = mockServer();
    registerUtilTools(real as never, {
      servers: SERVERS,
      defaultServer: "prod",
      redact: "all",
      redactPatterns: [],
      url: SERVERS[0].url,
      token: SERVERS[0].token,
    });

    const result: any = await real.handlers.swarmpit_info({});
    const info = JSON.parse(result.content[0].text);
    assert.deepEqual(info.servers, [
      { name: "prod", url: "https://prod.example.com" },
      { name: "play", url: "https://play.example.com" },
    ]);
    assert.equal(info.defaultServer, "prod");
    assert.equal(result.content[0].text.includes("prod-token"), false);
  });
});
