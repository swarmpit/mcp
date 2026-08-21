import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerServiceTools } from "../tools/services.js";
import { registerStackTools } from "../tools/stacks.js";
import { registerAdminTools, redactUser } from "../tools/admin.js";
import { prepareServiceForUpdate, restoreRedactedVariables } from "../tools/helpers.js";

function mockServer(): { handlers: Record<string, Function>; tool: Function } {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    tool(name: string, _desc: string, _schema: unknown, handler: Function) {
      handlers[name] = handler;
    },
  } as unknown as { handlers: Record<string, Function>; tool: Function };
}

describe("prepareServiceForUpdate null coercion (#3)", () => {
  it("turns deployment.maxReplicas null into 0", () => {
    const out = prepareServiceForUpdate({ deployment: { autoredeploy: false, maxReplicas: null } });
    assert.deepEqual(out.deployment, { autoredeploy: false, maxReplicas: 0 });
  });

  it("drops volumeOptions null on bind mounts", () => {
    const out = prepareServiceForUpdate({
      mounts: [{ containerPath: "/var/run/docker.sock", type: "bind", volumeOptions: null }],
    });
    assert.deepEqual(out.mounts, [{ containerPath: "/var/run/docker.sock", type: "bind" }]);
  });

  it("turns volumeOptions.driver.options null into {}", () => {
    const out = prepareServiceForUpdate({
      mounts: [{ type: "volume", volumeOptions: { labels: [], driver: { name: "local", options: null } } }],
    });
    assert.deepEqual(out.mounts, [
      { type: "volume", volumeOptions: { labels: [], driver: { name: "local", options: {} } } },
    ]);
  });

  it("does not mutate the input spec", () => {
    const input = { mounts: [{ volumeOptions: null }], deployment: { maxReplicas: null } };
    prepareServiceForUpdate(input);
    assert.equal(input.deployment.maxReplicas, null);
    assert.equal(input.mounts[0].volumeOptions, null);
  });
});

describe("restoreRedactedVariables (#4)", () => {
  it("restores [REDACTED] from live values and leaves edits alone", () => {
    const { variables, restored } = restoreRedactedVariables(
      [
        { name: "RPC_URL", value: "[REDACTED]" },
        { name: "LOG_LEVEL", value: "debug" },
        { name: "NEW_KEY", value: "[REDACTED]" },
      ],
      [
        { name: "RPC_URL", value: "wss://real.example" },
        { name: "LOG_LEVEL", value: "info" },
      ]
    );
    assert.deepEqual(variables, [
      { name: "RPC_URL", value: "wss://real.example" },
      { name: "LOG_LEVEL", value: "debug" },
      { name: "NEW_KEY", value: "[REDACTED]" },
    ]);
    assert.deepEqual(restored, ["RPC_URL"]);
  });

  it("passes through a missing variables field", () => {
    assert.deepEqual(restoreRedactedVariables(undefined, []), { variables: undefined, restored: [] });
  });
});

describe("update_service round-trip (#4)", () => {
  it("never writes the literal [REDACTED]", async () => {
    const live = {
      id: "svc1",
      serviceName: "app",
      state: "running",
      repository: { name: "nginx", tag: "alpine", imageDigest: "sha256:x" },
      deployment: { maxReplicas: null },
      variables: [{ name: "RPC_URL", value: "wss://real.example" }],
    };
    const updates: unknown[][] = [];
    const client = {
      getService: () => Promise.resolve(live),
      updateService: (...args: unknown[]) => {
        updates.push(args);
        return Promise.resolve();
      },
    };
    const server = mockServer();
    registerServiceTools(server as never, client as never, "all");

    const result = await server.handlers.update_service({
      id: "svc1",
      spec: { ...live, variables: [{ name: "RPC_URL", value: "[REDACTED]" }], command: ["sh"] },
    });

    assert.equal(result.isError, undefined);
    const [, spec] = updates[0] as [string, Record<string, any>];
    assert.deepEqual(spec.variables, [{ name: "RPC_URL", value: "wss://real.example" }]);
    assert.equal(spec.deployment.maxReplicas, 0);
    assert.equal(spec.state, undefined);
    assert.deepEqual(spec.repository, { name: "nginx", tag: "alpine" });
  });
});

describe("update_stack restoration source (#5)", () => {
  const edited =
    "services:\n  app:\n    image: nginx\n    environment:\n      RPC_URL: [REDACTED]\n";

  it("prefers live compose over a stale stack file", async () => {
    const updates: unknown[][] = [];
    const client = {
      getStackCompose: () =>
        Promise.resolve({ compose: "services:\n  app:\n    environment:\n      RPC_URL: wss://fixed\n" }),
      getStackFile: () =>
        Promise.resolve({ compose: "services:\n  app:\n    environment:\n      RPC_URL: wss://stale\n" }),
      updateStack: (...args: unknown[]) => {
        updates.push(args);
        return Promise.resolve();
      },
    };
    const server = mockServer();
    registerStackTools(server as never, client as never, "all");

    const result = await server.handlers.update_stack({ name: "myapp", compose: edited });

    const [, yaml] = updates[0] as [string, string];
    assert.ok(yaml.includes("RPC_URL: wss://fixed"));
    assert.ok(!yaml.includes("wss://stale"));
    assert.match(JSON.parse(result.content[0].text).warning, /stale.*RPC_URL/);
  });

  it("falls back to the stack file for vars absent from live compose", async () => {
    const updates: unknown[][] = [];
    const client = {
      getStackCompose: () => Promise.resolve({ compose: "services:\n  app:\n    image: nginx\n" }),
      getStackFile: () =>
        Promise.resolve({ compose: "services:\n  app:\n    environment:\n      RPC_URL: wss://from-file\n" }),
      updateStack: (...args: unknown[]) => {
        updates.push(args);
        return Promise.resolve();
      },
    };
    const server = mockServer();
    registerStackTools(server as never, client as never, "all");

    const result = await server.handlers.update_stack({ name: "myapp", compose: edited });

    const [, yaml] = updates[0] as [string, string];
    assert.ok(yaml.includes("RPC_URL: wss://from-file"));
    assert.equal(JSON.parse(result.content[0].text).warning, undefined);
  });
});

describe("admin password references (#6)", () => {
  it("create_user resolves { $env } without a literal", async () => {
    process.env.TEST_NEW_USER_PASS = "s3cret";
    const created: unknown[][] = [];
    const client = {
      createUser: (...args: unknown[]) => {
        created.push(args);
        return Promise.resolve();
      },
    };
    const server = mockServer();
    registerAdminTools(server as never, client as never, "all");

    const result = await server.handlers.create_user({
      username: "svc",
      password: { $env: "TEST_NEW_USER_PASS" },
      role: "user",
    });

    assert.equal(result.isError, undefined);
    const [spec] = created[0] as [{ password: string }];
    assert.equal(spec.password, "s3cret");
    assert.equal(result.content[0].text.includes("s3cret"), false);
    delete process.env.TEST_NEW_USER_PASS;
  });

  it("edit_user resolves a password reference in spec", async () => {
    process.env.TEST_EDIT_USER_PASS = "rotated";
    const edits: unknown[][] = [];
    const client = {
      editUser: (...args: unknown[]) => {
        edits.push(args);
        return Promise.resolve();
      },
    };
    const server = mockServer();
    registerAdminTools(server as never, client as never, "all");

    await server.handlers.edit_user({ id: "u1", spec: { password: { $env: "TEST_EDIT_USER_PASS" } } });

    const [, spec] = edits[0] as [string, { password: string }];
    assert.equal(spec.password, "rotated");
    delete process.env.TEST_EDIT_USER_PASS;
  });

  it("create_user errors on an unset $env reference without calling the API", async () => {
    const client = { createUser: () => Promise.reject(new Error("should not be called")) };
    const server = mockServer();
    registerAdminTools(server as never, client as never, "all");

    const result = await server.handlers.create_user({
      username: "svc",
      password: { $env: "TEST_DEFINITELY_UNSET_VAR" },
      role: "user",
    });

    assert.equal(result.isError, true);
  });
});

describe("redactUser (#7)", () => {
  const user = {
    _id: "u1",
    _rev: "2-abc",
    role: "admin",
    username: "ops",
    type: "user",
    "api-token": { jti: "jti-1", mask: "abcde" },
  };

  it("drops api-token and _rev outside none mode", () => {
    assert.deepEqual(redactUser(user, "all"), {
      _id: "u1",
      username: "ops",
      role: "admin",
      hasApiToken: true,
    });
    assert.deepEqual(redactUser(user, "sensitive"), redactUser(user, "all"));
  });

  it("passes the raw record through in none mode", () => {
    assert.deepEqual(redactUser(user, "none"), user);
  });

  it("list_users and get_user route through the redactor", async () => {
    const client = {
      listUsers: () => Promise.resolve([user]),
      getUser: () => Promise.resolve(user),
    };
    const server = mockServer();
    registerAdminTools(server as never, client as never, "all");

    for (const out of [
      await server.handlers.list_users({}),
      await server.handlers.get_user({ id: "u1" }),
    ]) {
      assert.equal(out.content[0].text.includes("api-token"), false);
      assert.equal(out.content[0].text.includes("2-abc"), false);
    }
  });
});
