import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse, stringify } from "yaml";
import { sanitizeComposeYaml, resolveComposeEnvRefs, restoreComposeRedactions } from "../sanitize.js";
import { registerStackTools } from "../tools/stacks.js";

const secret = "synthetic-provenance-secret";
const variable = "MCP_TEST_COMPOSE_PROVENANCE";
const stack = (spec: Record<string, unknown>) => stringify({ version: "3.8", services: { app: { image: "example/app:1", ...spec } } });
async function withValue(value: string, run: () => void | Promise<void>): Promise<void> {
  const previous = process.env[variable];
  process.env[variable] = value;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
}
function harness(live: string, redact: "all" | "sensitive" | "none" = "all", file = live) {
  const handlers: Record<string, Function> = {};
  const writes: string[] = [];
  registerStackTools({
    tool(name: string, _description: string, _schema: unknown, handler: Function) { handlers[name] = handler; },
  } as never, {
    getStackServices: async () => [],
    getStackCompose: async () => ({ compose: live }),
    getStackFile: async () => ({ compose: file }),
    updateStack: async (_name: string, compose: string) => { writes.push(compose); },
    createStack: async (payload: { spec: { compose: string } }) => { writes.push(payload.spec.compose); },
    createStackFile: async (_name: string, compose: string) => { writes.push(compose); },
  } as never, redact);
  return { handlers, writes };
}

describe("nested extension environment redaction", () => {
  const fixtures = {
    map: `x-templates: {inactive: {environment: {db_password: ${secret}}}}\n${stack({})}`,
    list: `x-templates: {inactive: {environment: [API_TOKEN=${secret}]}}\n${stack({})}`,
    sequence: `x-templates: [{group: [{environment: [API_TOKEN=${secret}]}]}]\n${stack({})}`,
    aliasedField: `x-name: &name environment\nx-templates: {inactive: {*name : {db_password: ${secret}}}}\n${stack({})}`,
    serviceExtension: stack({ "x-templates": { inactive: { environment: { db_password: secret } } } }),
  };
  for (const [name, yaml] of Object.entries(fixtures)) {
    for (const redact of ["all", "sensitive", "none"] as const) {
      it(`protects ${name} in ${redact} reads`, async () => {
        const { handlers } = harness(yaml, redact);
        for (const tool of ["get_stack", "get_stack_compose"]) {
          const result = await handlers[tool]({ name: "audit" });
          assert.equal(result.isError, undefined, result.content[0].text);
          assert.equal(result.content[0].text.includes(secret), redact === "none");
        }
      });
    }
  }

  it("preserves metadata and labels named environment inside templates", () => {
    const yaml = `x-templates:
  notes: {environment: production}
  inactive:
    labels: {environment: production}
    deploy: {labels: {environment: production}}
    environment: {environment: production, db_password: ${secret}}
${stack({ labels: { environment: "production" } })}`;
    const actual = parse(sanitizeComposeYaml(yaml, false));
    assert.equal(actual["x-templates"].notes.environment, "production");
    assert.equal(actual["x-templates"].inactive.labels.environment, "production");
    assert.equal(actual["x-templates"].inactive.deploy.labels.environment, "production");
    assert.equal(actual["x-templates"].inactive.environment.environment, "production");
    assert.equal(actual["x-templates"].inactive.environment.db_password, "[REDACTED]");
    assert.equal(actual.services.app.labels.environment, "production");
  });

  it("restores consumers before dropping an unused nested template", () => {
    const yaml = `x-templates:\n  group:\n    active: &active {environment: {db_password: ${secret}}}\n    inactive: {environment: [API_TOKEN=${secret}]}\nservices:\n  app:\n    image: example/app:1\n    <<: *active\n`;
    const restored = restoreComposeRedactions(sanitizeComposeYaml(yaml), [yaml]);
    assert.deepEqual(restored.unresolved, []);
    assert.deepEqual(parse(restored.yaml).services, parse(yaml, { merge: true }).services);
    assert.equal(parse(restored.yaml)["x-templates"], undefined);
  });
});

describe("local compose references in previews", () => {
  for (const redact of ["all", "sensitive", "none"] as const) {
    for (const field of ["command", "entrypoint", "healthcheck"] as const) {
      for (const value of [secret, `${secret}$REMOTE`, `${secret}\nsecond line`]) {
        it(`protects ${field} references in ${redact} mode for ${JSON.stringify(value)}`, async () => {
          await withValue(value, async () => {
            const spec = (args: string[]) => ({ [field]: field === "healthcheck" ? { test: args } : args });
            const { handlers, writes } = harness(stack(spec(["run"])), redact);
            const compose = stack(spec(["run", "--password", `$env:${variable}`]));
            const result = await handlers.update_stack({ name: "audit", compose, dry_run: true });
            assert.equal(result.isError, undefined, result.content[0].text);
            assert.equal(result.content[0].text.includes(secret), redact === "none");
            assert.equal(JSON.parse(result.content[0].text).changes.changed, true);
            assert.deepEqual(writes, []);
            const update = await handlers.update_stack({ name: "audit", compose });
            assert.equal(update.isError, undefined, update.content[0].text);
            assert.deepEqual(parse(writes[0]).services.app, parse(stack(spec(["run", "--password", value.replace(/\$/g, () => "$$")]))).services.app);
          });
        });
      }
    }
  }

  it("tracks reference aliases and non-sensitive environment names", async () => {
    await withValue(secret, async () => {
      const { handlers } = harness(stack({ environment: { LOG_LEVEL: "info" }, command: ["run"] }), "sensitive");
      const compose = `x-value: &value $env:${variable}\nservices:\n  app:\n    image: example/app:1\n    command: [run, *value]\n    environment: {LOG_LEVEL: *value}\n`;
      const result = await handlers.update_stack({ name: "audit", compose, dry_run: true });
      assert.equal(result.isError, undefined, result.content[0].text);
      assert.ok(!result.content[0].text.includes(secret));
      assert.deepEqual(JSON.parse(result.content[0].text).changes.services.changed.app.environment.changed, ["LOG_LEVEL"]);
    });
  });

  it("protects prefixed reference values outside environment blocks", async () => {
    await withValue(secret, async () => {
      const { handlers } = harness(stack({ command: ["run"] }), "sensitive");
      const result = await handlers.update_stack({ name: "audit", compose: stack({ command: ["run", `value=$env:${variable}`] }), dry_run: true });
      assert.equal(result.isError, undefined, result.content[0].text);
      assert.ok(!result.content[0].text.includes(secret));
      assert.deepEqual(JSON.parse(result.content[0].text).changes.services.changed.app.command.to, ["run", "value=[REDACTED]"]);
    });
  });
});

describe("reference mapping-key guards", () => {
  const fixtures = {
    direct: `services: {app: {environment: {'$env:${variable}': public}}}`,
    alias: `x-key: &key $env:${variable}\nservices: {app: {environment: {*key : public}}}`,
    sequence: `x-key: &key $env:${variable}\nx-values: {[ *key ]: public}\n${stack({})}`,
    mapping: `x-key: &key $env:${variable}\nx-values: {{name: *key}: public}\n${stack({})}`,
  };
  for (const [name, compose] of Object.entries(fixtures)) {
    it(`rejects ${name} reference keys without exposing the resolved value`, async () => {
      await withValue(secret, () => {
        assert.throws(() => resolveComposeEnvRefs(compose), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /mapping key|Unsupported \$env/);
          assert.ok(!error.message.includes(secret));
          return true;
        });
      });
    });
  }
  for (const tool of ["create_stack", "update_stack", "create_stack_file"]) {
    for (const redact of ["all", "sensitive", "none"] as const) {
      it(`rejects aliased keys in ${tool} with ${redact} mode`, async () => {
        await withValue(secret, async () => {
          const { handlers, writes } = harness(stack({}), redact);
          const result = await handlers[tool]({ name: "audit", compose: fixtures.alias });
          assert.equal(result.isError, true);
          assert.ok(!result.content[0].text.includes(secret));
          assert.deepEqual(writes, []);
        });
      });
    }
  }

  for (const compose of [
    `services: {app: {environment: ['$env:${variable}']}}`,
    `x-value: &value $env:${variable}\nservices: {app: {environment: [*value]}}`,
    `x-field: &field environment\nx-env: &env ['$env:${variable}']\nservices: {app: {*field : *env}}`,
  ]) {
    for (const dry_run of [true, false]) {
      it(`rejects a bare environment-list reference with dry_run=${dry_run}`, async () => {
        await withValue(secret, async () => {
          const { handlers, writes } = harness(stack({}));
          const result = await handlers.update_stack({ name: "audit", compose, dry_run });
          assert.equal(result.isError, true);
          assert.match(result.content[0].text, /environment name/);
          assert.ok(!result.content[0].text.includes(secret));
          assert.deepEqual(writes, []);
        });
      });
    }
  }

  it("allows an anchored KEY=value reference in an environment list", async () => {
    await withValue(secret, () => {
      const yaml = `x-entry: &entry DB_PASSWORD=$env:${variable}\nservices: {app: {environment: [*entry]}}`;
      assert.deepEqual(parse(resolveComposeEnvRefs(yaml)).services.app.environment, [`DB_PASSWORD=${secret}`]);
    });
  });
});

describe("explicit YAML scalar tags", () => {
  for (const tagged of ["!!int 123", "!!int 0x2a", "!!float 1.5", "!!float 1e2", "!!bool false", "!!str 123"]) {
    for (const redactAll of [true, false]) {
      it(`round-trips ${tagged} with redactAll=${redactAll}`, async () => {
        const original = `version: '3.8'\nx-value: &value ${tagged}\nservices:\n  app:\n    image: example/app:1\n    environment: {DB_PASSWORD: *value}\n`;
        const sanitized = sanitizeComposeYaml(original, redactAll);
        assert.equal(parse(sanitized).services.app.environment.DB_PASSWORD, "[REDACTED]");
        const restored = restoreComposeRedactions(sanitized, [original]);
        assert.deepEqual(restored.unresolved, []);
        assert.deepEqual(parse(restored.yaml).services, parse(original).services);
        const { handlers, writes } = harness(original, redactAll ? "all" : "sensitive");
        const result = await handlers.update_stack({ name: "audit", compose: sanitized });
        assert.equal(result.isError, undefined, result.content[0].text);
        assert.deepEqual(parse(writes[0]).services, parse(original).services);
      });
    }
  }
});
