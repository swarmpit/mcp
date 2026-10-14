import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse, stringify } from "yaml";
import { sanitizeComposeYaml, restoreComposeRedactions } from "../sanitize.js";
import { registerStackTools } from "../tools/stacks.js";

const secret = "synthetic-context-password";
const stack = (spec: Record<string, unknown>) => stringify({ version: "3.8", services: { app: { image: "example/app:1", ...spec } } });
function harness(live: string, file = live, redact: "all" | "sensitive" | "none" = "all") {
  const handlers: Record<string, Function> = {};
  const writes: string[] = [];
  registerStackTools({
    tool(name: string, _description: string, _schema: unknown, handler: Function) { handlers[name] = handler; },
  } as never, {
    getStackServices: async () => [],
    getStackCompose: async () => ({ compose: live }),
    getStackFile: async () => ({ compose: file }),
    updateStack: async (_name: string, compose: string) => { writes.push(compose); },
  } as never, redact);
  return { handlers, writes };
}

describe("compose environment context", () => {
  for (const redact of ["all", "sensitive", "none"] as const) {
    it(`keeps labels named environment in ${redact} reads`, async () => {
      const yaml = stack({
        labels: { environment: "production" },
        deploy: { labels: { environment: "production" } },
        environment: { environment: "production", DB_PASSWORD: secret },
      });
      const { handlers } = harness(yaml, yaml, redact);
      for (const name of ["get_stack", "get_stack_compose"]) {
        const result = await handlers[name]({ name: "audit" });
        assert.equal(result.isError, undefined, result.content[0].text);
        const actual = parse(JSON.parse(result.content[0].text).compose).services.app;
        assert.equal(actual.labels.environment, "production");
        assert.equal(actual.deploy.labels.environment, "production");
        assert.equal(actual.environment.environment, redact === "all" ? "[REDACTED]" : "production");
        assert.equal(actual.environment.DB_PASSWORD, redact === "none" ? secret : "[REDACTED]");
      }
    });
  }

  it("handles a service named environment and inherited service fields", () => {
    const yaml = `version: '3.8'
x-base: &base
  image: example/app:1
  labels: {environment: production}
  environment: {db_password: ${secret}}
services:
  environment:
    <<: *base
`;
    const sanitized = sanitizeComposeYaml(yaml, false);
    assert.ok(!sanitized.includes(secret));
    const spec = parse(sanitized, { merge: true }).services.environment;
    assert.equal(spec.labels.environment, "production");
    assert.equal(spec.environment.db_password, "[REDACTED]");
    const restored = restoreComposeRedactions(sanitized, [yaml]);
    assert.deepEqual(restored.unresolved, []);
    assert.deepEqual(parse(restored.yaml).services, parse(yaml, { merge: true }).services);
  });

  it("still rejects invalid actual environment blocks without exposing their values", () => {
    assert.throws(() => sanitizeComposeYaml(stack({ environment: secret })), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /environment must be a map or list/);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  });
});

describe("shared map and list environment scalars", () => {
  const fixtures = {
    extension: `x-entry: &entry DB_PASSWORD=${secret}
services:
  first:
    environment: {API_TOKEN: *entry}
  second:
    environment: [*entry]
`,
    map: `services:
  first:
    environment:
      API_TOKEN: &entry DB_PASSWORD=${secret}
  second:
    environment: [*entry]
`,
    list: `services:
  second:
    environment: [&entry DB_PASSWORD=${secret}]
  first:
    environment: {API_TOKEN: *entry}
`,
    uppercaseTemplate: `x-env:
  ENTRY: &entry DB_PASSWORD=${secret}
services:
  second:
    environment: [*entry]
`,
    nonsensitiveMap: `x-entry: &entry DB_PASSWORD=${secret}
services:
  first:
    environment: {LOG_LEVEL: *entry}
  second:
    environment: [*entry]
`,
    nonsensitiveList: `x-entry: &entry LOG_LEVEL=${secret}
services:
  first:
    environment: {API_TOKEN: *entry}
  second:
    environment: [*entry]
`,
  };
  for (const [name, template] of Object.entries(fixtures)) {
    const yaml = `${template}    command: [echo, *entry]\n`;
    for (const redactAll of [true, false]) {
      it(`round-trips an anchor defined in ${name} with redactAll=${redactAll}`, () => {
        const sanitized = sanitizeComposeYaml(yaml, redactAll);
        assert.ok(!sanitized.includes(secret));
        const actual = parse(sanitized);
        const name = parse(yaml).services.second.environment[0].split("=")[0];
        assert.deepEqual(actual.services.second.environment, [`${name}=[REDACTED]`]);
        if (actual.services.first) assert.deepEqual(Object.values(actual.services.first.environment), ["[REDACTED]"]);
        const restored = restoreComposeRedactions(sanitized, [yaml]);
        assert.deepEqual(restored.unresolved, []);
        assert.deepEqual(parse(restored.yaml).services, parse(yaml).services);
      });
    }
  }

  it("keeps independent live values when a stored anchor has diverged", async () => {
    const live = `services:
  first:
    environment: {API_TOKEN: synthetic-map-live}
  second:
    environment: {DB_PASSWORD: synthetic-list-live}
`;
    const { handlers, writes } = harness(live, fixtures.extension);
    const result = await handlers.update_stack({ name: "audit", compose: sanitizeComposeYaml(fixtures.extension) });
    assert.equal(result.isError, undefined, result.content[0].text);
    const actual = parse(writes[0]);
    assert.equal(actual.services.first.environment.API_TOKEN, "synthetic-map-live");
    assert.deepEqual(actual.services.second.environment, ["DB_PASSWORD=synthetic-list-live"]);
    assert.ok(!result.content[0].text.includes("synthetic-"));
  });
});

describe("positional placeholder safety", () => {
  const original = ["--password", secret, "--port", "8080"];
  const edits = {
    prepend: ["--verbose", "--password", "[REDACTED]", "--port", "8080"],
    remove: ["[REDACTED]", "--port", "8080"],
    reorder: ["--port", "8080", "--password", "[REDACTED]"],
    replace: ["--password", "[REDACTED]", "--port", "9090"],
  };
  for (const field of ["command", "entrypoint", "healthcheck"] as const) {
    const spec = (value: string[]) => ({ [field]: field === "healthcheck" ? { test: value } : value });
    for (const [name, args] of Object.entries(edits)) {
      for (const dry_run of [true, false]) {
        it(`rejects ${name} in ${field} with dry_run=${dry_run}`, async () => {
          const { handlers, writes } = harness(stack(spec(original)));
          const result = await handlers.update_stack({ name: "audit", compose: stack(spec(args)), dry_run });
          assert.equal(result.isError, true);
          assert.match(result.content[0].text, /Refusing to write/);
          assert.ok(result.content[0].text.includes(`services.app.${field}`));
          assert.ok(!result.content[0].text.includes(secret));
          assert.deepEqual(writes, []);
        });
      }
    }
  }

  it("does not fall back to an old layout when the live list changed", () => {
    const file = stack({ command: original });
    const live = stack({ command: ["--verbose", ...original] });
    const edited = stack({ command: ["--password", "[REDACTED]", "--port", "8080"] });
    const restored = restoreComposeRedactions(edited, [live, file]);
    assert.deepEqual(restored.unresolved, ["services.app.command.1"]);
  });

  it("does not let a stale stored layout block an unchanged live list", () => {
    const live = stack({ command: original });
    const file = stack({ command: ["--verbose", ...original] });
    const edited = stack({ command: ["--password", "[REDACTED]", "--port", "8080"] });
    const restored = restoreComposeRedactions(edited, [live, file]);
    assert.deepEqual(restored.unresolved, []);
    assert.deepEqual(parse(restored.yaml).services.app.command, original);
  });

  it("protects placeholders nested inside changed arrays", () => {
    const file = stack({ command: [{ token: secret }, { token: "public" }] });
    const edited = stack({ command: [{ token: "new" }, { token: "[REDACTED]" }, { token: "public" }] });
    const restored = restoreComposeRedactions(edited, [file]);
    assert.deepEqual(restored.unresolved, ["services.app.command.1.token"]);
  });

  it("continues restoring named environment entries after reordering", () => {
    const file = stack({ environment: [`DB_PASSWORD=${secret}`, "LOG_LEVEL=info"] });
    const edited = stack({ environment: ["LOG_LEVEL=debug", "DB_PASSWORD=[REDACTED]"] });
    const restored = restoreComposeRedactions(edited, [file]);
    assert.deepEqual(restored.unresolved, []);
    assert.deepEqual(parse(restored.yaml).services.app.environment, ["LOG_LEVEL=debug", `DB_PASSWORD=${secret}`]);
  });

  it("accepts explicit env references when changing a list", async () => {
    const variable = "MCP_TEST_POSITIONAL_PASSWORD";
    const previous = process.env[variable];
    process.env[variable] = secret;
    try {
      const { handlers, writes } = harness(stack({ command: original }));
      const result = await handlers.update_stack({ name: "audit", compose: stack({ command: ["--verbose", "--password", `$env:${variable}`, "--port", "8080"] }) });
      assert.equal(result.isError, undefined, result.content[0].text);
      assert.deepEqual(parse(writes[0]).services.app.command, ["--verbose", ...original]);
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });
});
