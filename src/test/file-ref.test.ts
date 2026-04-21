import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerConfigTools } from "../tools/configs.js";
import { registerSecretTools } from "../tools/secrets.js";
import { registerStackTools } from "../tools/stacks.js";

/**
 * Minimal mock that captures tool handlers registered on the MCP server,
 * so we can invoke them directly in tests without the transport layer.
 */
function mockServer(): { handlers: Record<string, Function>; tool: Function } {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    tool(name: string, _desc: string, _schema: unknown, handler: Function) {
      handlers[name] = handler;
    },
  } as unknown as { handlers: Record<string, Function>; tool: Function };
}

function mockClient() {
  const calls: Record<string, unknown[][]> = {};
  const record = (method: string) => (...args: unknown[]) => {
    (calls[method] ||= []).push(args);
    return Promise.resolve(undefined as unknown);
  };
  return {
    calls,
    listSecrets: record("listSecrets"),
    listConfigs: record("listConfigs"),
    createSecret: record("createSecret"),
    createConfig: record("createConfig"),
    createStack: record("createStack"),
    updateStack: record("updateStack"),
    getStackFile: () => Promise.resolve({ compose: "" }),
    createStackFile: record("createStackFile"),
  };
}

describe("$file integration", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-swarmpit-test-"));
    filePath = join(tmpDir, "data.txt");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("create_config reads data from $file", async () => {
    writeFileSync(filePath, "<html>hello from file</html>");
    const server = mockServer();
    const client = mockClient();
    registerConfigTools(server as never, client as never, "sensitive");

    const result = await server.handlers.create_config({
      configName: "my_config",
      data: { $file: filePath },
    });

    assert.equal(result.isError, undefined);
    const [arg] = client.calls.createConfig[0] as [{ configName: string; data: string }];
    assert.equal(arg.configName, "my_config");
    assert.equal(arg.data, "<html>hello from file</html>");
  });

  it("create_secret reads data from $file", async () => {
    writeFileSync(filePath, "super-secret-token");
    const server = mockServer();
    const client = mockClient();
    registerSecretTools(server as never, client as never, "sensitive");

    const result = await server.handlers.create_secret({
      secretName: "api_token",
      data: { $file: filePath },
    });

    assert.equal(result.isError, undefined);
    const [arg] = client.calls.createSecret[0] as [{ secretName: string; data: string }];
    assert.equal(arg.secretName, "api_token");
    assert.equal(arg.data, "super-secret-token");
  });

  it("create_stack reads compose from $file", async () => {
    const compose = "version: '3.3'\nservices:\n  web:\n    image: nginx\n";
    writeFileSync(filePath, compose);
    const server = mockServer();
    const client = mockClient();
    registerStackTools(server as never, client as never, "sensitive");

    const result = await server.handlers.create_stack({
      name: "myapp",
      compose: { $file: filePath },
    });

    assert.equal(result.isError, undefined);
    const [arg] = client.calls.createStack[0] as [{ name: string; spec: { compose: string } }];
    assert.equal(arg.name, "myapp");
    assert.equal(arg.spec.compose, compose);
  });

  it("update_stack reads compose from $file", async () => {
    const compose = "version: '3.3'\nservices:\n  web:\n    image: nginx:updated\n";
    writeFileSync(filePath, compose);
    const server = mockServer();
    const client = mockClient();
    registerStackTools(server as never, client as never, "sensitive");

    const result = await server.handlers.update_stack({
      name: "myapp",
      compose: { $file: filePath },
    });

    assert.equal(result.isError, undefined);
    const [name, yaml] = client.calls.updateStack[0] as [string, string];
    assert.equal(name, "myapp");
    assert.equal(yaml, compose);
  });

  it("create_stack_file reads compose from $file", async () => {
    const compose = "version: '3.3'\nservices: {}\n";
    writeFileSync(filePath, compose);
    const server = mockServer();
    const client = mockClient();
    registerStackTools(server as never, client as never, "sensitive");

    const result = await server.handlers.create_stack_file({
      name: "myapp",
      compose: { $file: filePath },
    });

    assert.equal(result.isError, undefined);
    const [name, yaml] = client.calls.createStackFile[0] as [string, string];
    assert.equal(name, "myapp");
    assert.equal(yaml, compose);
  });

  it("create_config with $file does not resolve $env: inside raw config data", async () => {
    writeFileSync(filePath, "$env:SHOULD_NOT_RESOLVE");
    const server = mockServer();
    const client = mockClient();
    registerConfigTools(server as never, client as never, "sensitive");

    await server.handlers.create_config({
      configName: "x",
      data: { $file: filePath },
    });

    const [arg] = client.calls.createConfig[0] as [{ data: string }];
    assert.equal(arg.data, "$env:SHOULD_NOT_RESOLVE");
  });

  it("create_stack with $file resolves $env: refs inside compose", async () => {
    process.env.TEST_STACK_FILE_VAR = "resolved-value";
    const compose = "services:\n  app:\n    environment:\n      SECRET: $env:TEST_STACK_FILE_VAR\n";
    writeFileSync(filePath, compose);
    const server = mockServer();
    const client = mockClient();
    registerStackTools(server as never, client as never, "sensitive");

    const result = await server.handlers.create_stack({
      name: "myapp",
      compose: { $file: filePath },
    });

    assert.equal(result.isError, undefined);
    const [arg] = client.calls.createStack[0] as [{ spec: { compose: string } }];
    assert.ok(arg.spec.compose.includes("SECRET: resolved-value"));
    delete process.env.TEST_STACK_FILE_VAR;
  });

  it("returns isError for missing file", async () => {
    const server = mockServer();
    const client = mockClient();
    registerConfigTools(server as never, client as never, "sensitive");

    const result = await server.handlers.create_config({
      configName: "x",
      data: { $file: "/nonexistent/path/xyz" },
    });

    assert.equal(result.isError, true);
    assert.equal(client.calls.createConfig, undefined);
  });
});
