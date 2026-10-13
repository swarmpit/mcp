import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { z } from "zod";
import type { RedactMode } from "../config.js";
import { SwarmpitApiError, SwarmpitClient } from "../client.js";
import { sanitizeComposeYaml, resolveComposeEnvRefs, restoreComposeRedactions } from "../sanitize.js";
import { diffCompose } from "../compose-diff.js";
import { filterLogs } from "../timeseries.js";
import { registerServiceTools } from "../tools/services.js";
import { registerStackTools } from "../tools/stacks.js";
import { registerSecretTools } from "../tools/secrets.js";
import { registerConfigTools } from "../tools/configs.js";
import { registerNetworkTools } from "../tools/networks.js";
import { registerVolumeTools } from "../tools/volumes.js";
import { registerAdminTools } from "../tools/admin.js";

function harness(register: Function, client: unknown, redact: RedactMode = "all") {
  const handlers: Record<string, Function> = {};
  const schemas: Record<string, z.ZodTypeAny> = {};
  register({
    tool(name: string, _description: string, shape: z.ZodRawShape, handler: Function) {
      handlers[name] = handler;
      schemas[name] = z.object(shape);
    },
  }, client, redact);
  return { handlers, schemas };
}

const text = (result: any): string => result.content.map((part: any) => part.text ?? "").join("\n");
const body = (result: any): any => JSON.parse(text(result));
const secret = "synthetic-audit-secret";
const service = {
  id: "audit-service", serviceName: "audit_app",
  variables: [{ name: "DB_PASSWORD", value: secret }, { name: "LOG_LEVEL", value: "debug" }],
};
const compose = (value: string) => `services:\n  app:\n    image: alpine:3\n    environment:\n      DB_PASSWORD: ${JSON.stringify(value)}\n      LOG_LEVEL: debug\n`;

describe("audit: consistent read redaction", () => {
  for (const mode of ["all", "sensitive", "none"] as const) {
    const client = {
      getService: async () => service,
      getServiceCompose: async () => ({ compose: compose(secret) }),
      listStacks: async () => [{ stackName: "audit", services: [service] }],
      getSecretServices: async () => [service],
      getConfigServices: async () => [service],
      getNetworkServices: async () => [service],
      getVolumeServices: async () => [service],
    };
    const cases: [Function, string, Record<string, unknown>][] = [
      [registerServiceTools, "get_service_env", { id: "audit", names: ["DB_PASSWORD", "LOG_LEVEL"] }],
      [registerServiceTools, "get_service_compose", { id: "audit" }],
      [registerStackTools, "list_stacks", {}],
      [registerSecretTools, "get_secret_services", { id: "audit" }],
      [registerConfigTools, "get_config_services", { id: "audit" }],
      [registerNetworkTools, "get_network_services", { id: "audit" }],
      [registerVolumeTools, "get_volume_services", { name: "audit" }],
    ];
    for (const [register, name, args] of cases) {
      it(`${name} obeys ${mode} mode`, async () => {
        const result = await harness(register, client, mode).handlers[name](args);
        assert.equal(result.isError, undefined, text(result));
        assert.equal(text(result).includes(secret), mode === "none");
        assert.equal(text(result).includes("debug"), mode !== "all");
        assert.equal(service.variables[0].value, secret);
      });
    }
  }
});

describe("audit: structural compose redaction", () => {
  const variants = {
    flow: `services: {app: {environment: {DB_PASSWORD: ${secret}}}}\n`,
    quoted: `services:\n  app:\n    environment:\n      "DB_PASSWORD": ${secret}\n`,
    lowercase: `services:\n  app:\n    environment:\n      db_password: ${secret}\n`,
    literal: `services:\n  app:\n    environment:\n      DB_PASSWORD: |\n        ${secret}\n`,
    folded: `services:\n  app:\n    environment:\n      DB_PASSWORD: >-\n        ${secret}\n`,
    scalarAnchor: `x-value: &value ${secret}\nservices:\n  app:\n    environment:\n      DB_PASSWORD: *value\n`,
    mapAnchor: `x-env: &env {db_password: ${secret}}\nservices:\n  app:\n    environment: *env\n`,
    merge: `x-env: &env {db_password: ${secret}}\nservices:\n  app:\n    environment:\n      <<: *env\n`,
    mergeList: `x-env: &env {db_password: ${secret}}\nservices:\n  app:\n    environment:\n      <<: [*env]\n`,
    listAnchor: `x-env: &env ["DB_PASSWORD=${secret}"]\nservices:\n  app:\n    environment: *env\n`,
    listEntryAnchor: `x-entry: &entry "DB_PASSWORD=${secret}"\nservices:\n  app:\n    environment: [*entry]\n`,
    serviceAnchor: `x-service: &service {environment: {DB_PASSWORD: ${secret}}}\nservices:\n  app: *service\n`,
    comments: `# ${secret}\nservices:\n  app:\n    environment:\n      DB_PASSWORD: ${secret} # ${secret}\n`,
  };
  for (const [name, yaml] of Object.entries(variants)) {
    for (const redactAll of [true, false]) {
      it(`redacts and round-trips ${name} in ${redactAll ? "all" : "sensitive"} mode`, () => {
        const sanitized = sanitizeComposeYaml(yaml, redactAll);
        assert.ok(!sanitized.includes(secret));
        parse(sanitized, { merge: true });
        const restored = restoreComposeRedactions(sanitized, [yaml]);
        assert.deepEqual(restored.unresolved, []);
        const expected = parse(yaml, { merge: true });
        for (const key of Object.keys(expected)) if (key.startsWith("x-")) delete expected[key];
        assert.deepEqual(parse(restored.yaml, { merge: true }), expected);
      });
    }
  }

  for (const yaml of [
    `services:\n  app:\n    environment:\n      DB_PASSWORD: ${secret}: invalid\n`,
    "services: *undefined\n",
    "x-cycle: &cycle {self: *cycle}\nservices: {}\n",
    `services: {app: {environment: {DB_PASSWORD: !unknown ${secret}}}}\n`,
  ]) {
    it("refuses unsafe YAML without exposing its contents", () => {
      assert.throws(() => sanitizeComposeYaml(yaml), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(secret));
        return true;
      });
    });
  }
});

describe("audit: fail-closed restoration", () => {
  for (const dry_run of [false, true]) {
    for (const source of ["live", "file"]) {
      it(`does not hide ${source} read failures with dry_run=${dry_run}`, async () => {
        let writes = 0;
        const fail = async () => { throw new Error("synthetic read failure"); };
        const { handlers } = harness(registerStackTools, {
          getStackCompose: source === "live" ? fail : async () => ({ compose: compose("live-value") }),
          getStackFile: source === "file" ? fail : async () => ({ compose: compose("stale-value") }),
          updateStack: async () => { writes++; },
        });
        const result = await handlers.update_stack({ name: "audit", compose: compose("[REDACTED]"), dry_run });
        assert.equal(result.isError, true);
        assert.equal(writes, 0);
        assert.ok(!text(result).includes("stale-value"));
      });
    }
  }

  it("allows a missing stored file when the live value is available", async () => {
    let written = "";
    const { handlers } = harness(registerStackTools, {
      getStackCompose: async () => ({ compose: compose(secret) }),
      getStackFile: async () => { throw new SwarmpitApiError(404, "Not Found", "missing"); },
      updateStack: async (_name: string, yaml: string) => { written = yaml; },
    });
    const result = await handlers.update_stack({ name: "audit", compose: compose("[REDACTED]") });
    assert.equal(result.isError, undefined, text(result));
    assert.equal(parse(written).services.app.environment.DB_PASSWORD, secret);
  });

  it("rejects corrupt live YAML instead of falling back to stored secrets", () => {
    assert.throws(() => restoreComposeRedactions(compose("[REDACTED]"), ["bad: [", compose(secret)]), /not valid YAML/);
  });

  it("preserves the effective last value of duplicate list variables", () => {
    const live = "services:\n  app:\n    environment: [DB_PASSWORD=old, DB_PASSWORD=effective]\n";
    const result = restoreComposeRedactions(compose("[REDACTED]"), [live]);
    assert.deepEqual(result.unresolved, []);
    assert.equal(parse(result.yaml).services.app.environment.DB_PASSWORD, "effective");
  });

  for (const merge of [false, true]) {
    it(`restores each service's live value through ${merge ? "merged" : "shared"} anchors`, async () => {
      const environment = merge ? "\n      <<: *env" : " *env";
      const file = `x-env: &env\n  DB_PASSWORD: stale-value\nservices:\n  app:\n    image: alpine:3\n    environment:${environment}\n  worker:\n    image: alpine:3\n    environment:${environment}\n`;
      const live = `${compose("app-live")}  worker:\n    image: alpine:3\n    environment:\n      DB_PASSWORD: worker-live\n`;
      let written = "";
      const { handlers } = harness(registerStackTools, {
        getStackCompose: async () => ({ compose: live }),
        getStackFile: async () => ({ compose: file }),
        updateStack: async (_name: string, yaml: string) => { written = yaml; },
      });
      const result = await handlers.update_stack({ name: "audit", compose: sanitizeComposeYaml(file).replaceAll("alpine:3", "alpine:3.21") });
      assert.equal(result.isError, undefined, text(result));
      const actual = parse(written, { merge: true });
      assert.equal(actual.services.app.environment.DB_PASSWORD, "app-live");
      assert.equal(actual.services.worker.environment.DB_PASSWORD, "worker-live");
      assert.equal(actual.services.app.image, "alpine:3.21");
      assert.equal(actual["x-env"], undefined);
      assert.ok(!sanitizeComposeYaml(written).includes("stale-value"));
      assert.match(body(result).warning, /services.app.environment.DB_PASSWORD/);
      assert.ok(!text(result).includes("app-live"));
      assert.ok(!text(result).includes("stale-value"));
    });
  }

  it("does not retain stale scalar templates, and keeps unrelated extension metadata", () => {
    const file = "x-value: &value stale-value\nx-notes: keep-this\nservices:\n  app:\n    environment: {DB_PASSWORD: *value}\n";
    const restored = restoreComposeRedactions(sanitizeComposeYaml(file), [compose("rotated-value"), file]);
    assert.deepEqual(restored.unresolved, []);
    assert.equal(parse(restored.yaml).services.app.environment.DB_PASSWORD, "rotated-value");
    assert.equal(parse(restored.yaml)["x-notes"], "keep-this");
    assert.ok(!restored.yaml.includes("stale-value"));
    assert.ok(!sanitizeComposeYaml(restored.yaml).includes("rotated-value"));
  });

  it("drops unused redacted templates even when no runtime placeholders remain", () => {
    const edited = "x-unused: '[REDACTED]'\nservices:\n  app:\n    image: alpine:3\n";
    const restored = restoreComposeRedactions(edited, ["services: {}\n"]);
    assert.deepEqual(restored.unresolved, []);
    assert.deepEqual(parse(restored.yaml), { services: { app: { image: "alpine:3" } } });
  });
});

describe("audit: literal env reference values", () => {
  const variable = "MCP_AUDIT_COMPOSE_VALUE";
  const fixtures = ["", "audit # suffix", "true", "001234567890", "a: b", "line one\nline two", "quote\" and \\ slash", "$REMOTE $$literal ${REMOTE}"];
  for (const value of fixtures) {
    it(`preserves ${JSON.stringify(value)} as a string`, () => {
      const previous = process.env[variable];
      process.env[variable] = value;
      try {
        const result = resolveComposeEnvRefs(compose(`$env:${variable}`));
        assert.equal(parse(result).services.app.environment.DB_PASSWORD, value.replace(/\$/g, () => "$$"));
      } finally {
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
      }
    });
  }

  it("supports quoted, flow, list, commented and anchored references", () => {
    process.env[variable] = "audit # suffix";
    try {
      for (const yaml of [
        `services: {app: {environment: {DB_PASSWORD: "$env:${variable}"}}}\n`,
        `services:\n  app:\n    environment:\n      db_password: '$env:${variable}' # comment\n`,
        `services:\n  app:\n    environment: ["DB_PASSWORD=$env:${variable}"]\n`,
        `x-value: &value $env:${variable}\nservices:\n  app:\n    environment:\n      DB_PASSWORD: *value\n`,
      ]) {
        const env = parse(resolveComposeEnvRefs(yaml)).services.app.environment;
        assert.deepEqual(Array.isArray(env) ? env : Object.values(env), [Array.isArray(env) ? "DB_PASSWORD=audit # suffix" : "audit # suffix"]);
      }
    } finally {
      delete process.env[variable];
    }
  });

  it("rejects partial references without echoing the surrounding value", () => {
    assert.throws(() => resolveComposeEnvRefs(compose(`${secret}-$env:${variable}`)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  });

  it("leaves an explicitly escaped literal $env string alone", () => {
    const yaml = compose(`$$env:${variable}`);
    assert.equal(resolveComposeEnvRefs(yaml), yaml);
  });

  for (const name of ["create_stack", "update_stack", "create_stack_file"]) {
    it(`${name} submits string-safe resolved values`, async () => {
      process.env[variable] = "audit # suffix";
      let written = "";
      const { handlers } = harness(registerStackTools, {
        getStackCompose: async () => ({ compose: compose("old") }),
        getStackFile: async () => ({ compose: compose("old") }),
        createStack: async (payload: any) => { written = payload.spec.compose; },
        updateStack: async (_name: string, yaml: string) => { written = yaml; },
        createStackFile: async (_name: string, yaml: string) => { written = yaml; },
      });
      try {
        const result = await handlers[name]({ name: "audit", compose: compose(`$env:${variable}`) });
        assert.equal(result.isError, undefined, text(result));
        assert.equal(parse(written).services.app.environment.DB_PASSWORD, "audit # suffix");
        assert.ok(!text(result).includes("audit # suffix"));
      } finally {
        delete process.env[variable];
      }
    });
  }
});

describe("audit: safe API errors", () => {
  const responses = [
    { status: 400, body: JSON.stringify({ problems: [{ path: ["password"], pred: "clojure.core/string?", val: secret }] }) },
    { status: 400, body: JSON.stringify({ problems: [{ path: [secret], pred: secret, val: { password: secret } }] }) },
    { status: 400, body: JSON.stringify({ problems: [null, { pred: "constructor", val: secret }] }) },
    { status: 400, body: JSON.stringify({ error: secret }) },
    { status: 500, body: `<html>${secret}</html>` },
    { status: 401, body: secret },
    { status: 200, body: `{broken: ${secret}}` },
  ];
  for (const [index, response] of responses.entries()) {
    it(`withholds response contents and status text (${index})`, async () => {
      const original = globalThis.fetch;
      const variable = "MCP_AUDIT_USER_PASSWORD";
      process.env[variable] = secret;
      globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        assert.equal(JSON.parse(init.body as string).password, secret);
        return new Response(response.body, { status: response.status, statusText: secret });
      }) as typeof fetch;
      try {
        const client = new SwarmpitClient("https://swarmpit.invalid", "synthetic-token");
        const { handlers } = harness(registerAdminTools, client);
        const result = await handlers.create_user({ username: "audit", role: "user", password: { $env: variable } });
        assert.equal(result.isError, true);
        assert.ok(!text(result).includes(secret), text(result));
      } finally {
        globalThis.fetch = original;
        delete process.env[variable];
      }
    });
  }
});

describe("audit: accurate previews and log filters", () => {
  for (const field of ["command", "entrypoint", "env_file"]) {
    it(`reports ordered ${field} changes`, () => {
      const before = `services:\n  app:\n    ${field}: [first, second]\n`;
      assert.equal(diffCompose(before, before.replace("first, second", "second, first")).changed, true);
    });
  }
  it("reports reordered health checks through dry_run", async () => {
    const before = "services:\n  app:\n    healthcheck:\n      test: [CMD, check, source, destination]\n";
    const { handlers } = harness(registerStackTools, {
      getStackCompose: async () => ({ compose: before }),
      getStackFile: async () => ({ compose: before }),
      updateStack: async () => { assert.fail("dry_run must not write"); },
    });
    const result = await handlers.update_stack({ name: "audit", compose: before.replace("source, destination", "destination, source"), dry_run: true });
    assert.equal(body(result).changes.changed, true);
  });
  it("reports interpolation changes without exposing secret values", () => {
    const diff = diffCompose(compose("$$SYNTHETIC_VALUE"), compose("$SYNTHETIC_VALUE"));
    assert.equal(diff.changed, true);
    assert.deepEqual(diff.secretsChanged, ["DB_PASSWORD"]);
    assert.ok(!JSON.stringify(diff).includes("SYNTHETIC_VALUE"));
    assert.equal(diffCompose(compose("$$SYNTHETIC_VALUE"), compose("$$SYNTHETIC_VALUE")).changed, false);
  });
  for (const redact of ["all", "sensitive"] as const) {
    it(`hides scalar and list-entry anchor values in ${redact} previews`, () => {
      for (const before of [
        `x-value: &value synthetic-old-secret\nservices:\n  app:\n    environment: {DB_PASSWORD: *value, LOG_LEVEL: *value}\n`,
        `x-value: &value DB_PASSWORD=synthetic-old-secret\nservices:\n  app:\n    environment: [*value]\n`,
      ]) {
        const diff = diffCompose(before, before.replace("synthetic-old-secret", "synthetic-new-secret"), { redact });
        assert.equal(diff.changed, true);
        assert.ok(!JSON.stringify(diff).includes("synthetic-old-secret"));
        assert.ok(!JSON.stringify(diff).includes("synthetic-new-secret"));
      }
    });
  }
  for (const grep of ["/error/g", "/error/y", "/error/gy"]) {
    it(`keeps all matches with ${grep}`, () => {
      const entries = [{ line: "error" }, { line: "error" }, { line: "ok" }, { line: "error" }];
      const result = filterLogs(entries, { grep });
      assert.equal(result.returned, 3);
      assert.equal(result.dropped?.byGrep, 1);
    });
  }
});

describe("audit: honest user edits", () => {
  it("rejects password updates in both the schema and handler", async () => {
    const { schemas, handlers } = harness(registerAdminTools, {
      getUser: async () => { assert.fail("must not fetch"); },
      editUser: async () => { assert.fail("must not write"); },
    });
    for (const password of [secret, { $env: "MCP_AUDIT_MISSING_PASSWORD" }, { $file: "/no/such/file" }]) {
      const args = { id: "audit", spec: { password } };
      assert.equal(schemas.edit_user.safeParse(args).success, false);
      const result = await handlers.edit_user(args);
      assert.equal(result.isError, true);
      assert.match(text(result), /password changes are not supported/);
      assert.ok(!text(result).includes(secret));
    }
  });
  it("fetches required metadata locally for supported partial edits", async () => {
    const user = {
      _id: "audit", _rev: "1-private-revision", type: "user", username: "audit", role: "user", email: "old@example.invalid",
      password: secret, "api-token": { mask: "private-token-mask" },
    };
    let payload: unknown;
    const { handlers } = harness(registerAdminTools, {
      getUser: async () => user,
      editUser: async (_id: string, spec: unknown) => { payload = spec; },
    });
    const result = await handlers.edit_user({ id: "audit", spec: { role: "admin" } });
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual(payload, {
      _id: "audit", _rev: "1-private-revision", type: "user", username: "audit", role: "admin", email: "old@example.invalid",
    });
    assert.ok(!text(result).includes("private"));
    assert.ok(!JSON.stringify(payload).includes(secret));
    assert.equal(user.role, "user");
  });
});
