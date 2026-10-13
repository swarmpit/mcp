import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { diffCompose } from "../compose-diff.js";
import { restoreComposeRedactions, sanitizeComposeYaml } from "../sanitize.js";
import { SwarmpitClient } from "../client.js";
import { registerStackTools } from "../tools/stacks.js";

describe("compose review regressions", () => {
  it("redacts environment values in both the service and its anchor", () => {
    const before = "x-env: &env\n  db_password: synthetic-old-secret\nservices:\n  app:\n    environment: *env\n";
    const after = before.replace("synthetic-old-secret", "synthetic-new-secret");
    for (const redact of ["all", "sensitive"] as const) {
      const diff = diffCompose(before, after, { redact });
      assert.equal(diff.changed, true);
      assert.deepEqual(diff.secretsChanged, ["db_password"]);
      assert.doesNotMatch(JSON.stringify(diff), /synthetic-(old|new)-secret/);
    }
    assert.match(JSON.stringify(diffCompose(before, after, { redact: "none" })), /synthetic-new-secret/);
  });

  it("redacts values inside added objects and changed extension lists", () => {
    const before = "services: {}\nx-env:\n  - DB_PASSWORD=synthetic-old-secret\n";
    const after = "services: {}\nx-env:\n  - DB_PASSWORD=synthetic-new-secret\nx-extra:\n  environment:\n    DB_PASSWORD: synthetic-nested-secret\n";
    for (const redact of ["all", "sensitive"] as const) {
      const diff = diffCompose(before, after, { redact });
      assert.equal(diff.changed, true);
      assert.doesNotMatch(JSON.stringify(diff), /synthetic-\w+-secret/);
    }
  });

  it("normalizes merged environment maps before comparing", () => {
    const before = "x-env: &env\n  TOKEN: synthetic-secret\nservices:\n  app:\n    environment:\n      <<: *env\n      LOG_LEVEL: info\n";
    const after = before.replace("      <<: *env", "      TOKEN: synthetic-secret");
    assert.equal(diffCompose(before, after).changed, false);
  });

  it("does not include compose values in YAML parse errors", () => {
    const invalid = "services:\n  app:\n    environment:\n      DB_PASSWORD: synthetic-parse-secret: invalid\n";
    const diff = diffCompose("", invalid);
    assert.equal(diff.changed, true);
    assert.ok(diff.parseError);
    assert.doesNotMatch(diff.parseError, /synthetic-parse-secret/);
    assert.throws(
      () => restoreComposeRedactions(`${invalid}      TOKEN: '[REDACTED]'\n`, []),
      (error: unknown) => error instanceof Error && !error.message.includes("synthetic-parse-secret")
    );
  });

  it("redacts quoted list entries with comments and restores their values", () => {
    const yaml = "services:\n  app:\n    environment:\n      - \"DB_PASSWORD=synthetic-list-secret\" # unchanged\n      - 'API_TOKEN=synthetic-token-secret' # unchanged\n      - \"LOG_LEVEL=debug\" # visible\n";
    for (const redactAll of [true, false]) {
      const sanitized = sanitizeComposeYaml(yaml, redactAll);
      assert.doesNotMatch(sanitized, /synthetic-\w+-secret/);
      assert.equal(sanitized.includes("LOG_LEVEL=debug"), !redactAll);
      const restored = restoreComposeRedactions(sanitized, [yaml]);
      assert.deepEqual(restored.unresolved, []);
      assert.deepEqual(parse(restored.yaml), parse(yaml));
    }
  });
});

describe("history failures", () => {
  it("reports an unavailable live compose instead of an empty stack", async () => {
    const handlers: Record<string, Function> = {};
    const server = { tool: (name: string, _description: string, _schema: unknown, handler: Function) => { handlers[name] = handler; } };
    const client = {
      getStackHistory: async () => [{ at: "2026-01-01T00:00:00Z", by: "admin", spec: { compose: "services:\n  app:\n    image: nginx:1\n" } }],
      getStackCompose: async () => { throw new Error("live compose unavailable"); },
    };
    registerStackTools(server as never, client as never, "all");
    const result = await handlers.get_stack_history({ name: "app", index: 0, diff: true });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /live compose unavailable/);
    assert.doesNotMatch(result.content[0].text, /removed/);
  });
});

describe("encoded write guard", () => {
  it("rejects secret and config placeholders before base64 encoding", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("");
    }) as typeof fetch;
    try {
      const client = new SwarmpitClient("https://swarmpit.invalid", "synthetic-token");
      await assert.rejects(client.createSecret({ secretName: "example", data: "[REDACTED]" }), /Refusing to send/);
      await assert.rejects(client.createConfig({ configName: "example", data: "TOKEN=[REDACTED]" }), /Refusing to send/);
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
