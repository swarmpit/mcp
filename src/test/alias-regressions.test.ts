import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse, stringify } from "yaml";
import type { RedactMode } from "../config.js";
import { SwarmpitClient } from "../client.js";
import { sanitizeComposeYaml, restoreComposeRedactions } from "../sanitize.js";
import { registerStackTools } from "../tools/stacks.js";

const secret = "synthetic-alias-password";
const aliasedKey = `version: '3.8'
x-env-key: &env-key environment
x-name: &name db_password
services:
  app:
    image: alpine:3
    *env-key :
      *name : ${secret}
      log_level: debug
`;
const sharedValue = `version: '3.8'
x-password: &password ${secret}
services:
  app:
    image: alpine:3
    environment:
      DB_PASSWORD: *password
    command: [echo, *password]
    entrypoint: [run, *password]
    healthcheck:
      test: [CMD, check, *password]
`;

function harness(client: unknown, mode: RedactMode = "all") {
  const handlers: Record<string, Function> = {};
  registerStackTools({
    tool(name: string, _description: string, _shape: unknown, handler: Function) {
      handlers[name] = handler;
    },
  } as never, client as never, mode);
  return handlers;
}

describe("aliased compose keys", () => {
  for (const mode of ["all", "sensitive", "none"] as const) {
    it(`applies ${mode} redaction through get_stack and get_stack_compose`, async () => {
      const handlers = harness({
        getStackServices: async () => [],
        getStackFile: async () => ({ compose: aliasedKey }),
        getStackCompose: async () => ({ compose: aliasedKey }),
      }, mode);
      for (const name of ["get_stack", "get_stack_compose"]) {
        const result = await handlers[name]({ name: "audit" });
        assert.equal(result.isError, undefined, result.content[0].text);
        assert.equal(result.content[0].text.includes(secret), mode === "none");
        const { compose } = JSON.parse(result.content[0].text);
        const environment = parse(compose).services.app.environment;
        assert.equal(environment.db_password, mode === "none" ? secret : "[REDACTED]");
        assert.equal(environment.log_level, mode === "all" ? "[REDACTED]" : "debug");
        if (mode !== "none") {
          const restored = restoreComposeRedactions(compose, [aliasedKey]);
          assert.deepEqual(restored.unresolved, []);
          assert.deepEqual(parse(restored.yaml), parse(aliasedKey));
        }
      }
    });
  }

  for (const redactAll of [true, false]) {
    it(`redacts list environments under aliased keys with redactAll=${redactAll}`, () => {
      const yaml = aliasedKey.replace(`      *name : ${secret}\n      log_level: debug`, `      - db_password=${secret}\n      - log_level=debug`);
      const sanitized = sanitizeComposeYaml(yaml, redactAll);
      assert.ok(!sanitized.includes(secret));
      const restored = restoreComposeRedactions(sanitized, [yaml]);
      assert.deepEqual(restored.unresolved, []);
      assert.deepEqual(parse(restored.yaml), parse(yaml));
    });
  }

  it("refuses redaction that would also change a mapping key", () => {
    const yaml = aliasedKey.replace("  app:\n", "  first:\n    image: alpine:3\n    environment: {DB_PASSWORD: *env-key}\n  app:\n");
    assert.throws(() => sanitizeComposeYaml(yaml), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /mapping key/);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  });
});

describe("shared compose scalars in lists", () => {
  for (const redactAll of [true, false]) {
    it(`restores scalar aliases at every list position with redactAll=${redactAll}`, () => {
      const sanitized = sanitizeComposeYaml(sharedValue, redactAll);
      assert.ok(!sanitized.includes(secret));
      const restored = restoreComposeRedactions(sanitized, [sharedValue]);
      assert.deepEqual(restored.unresolved, []);
      assert.ok(!restored.yaml.includes("[REDACTED]"));
      assert.deepEqual(parse(restored.yaml).services, parse(sharedValue).services);
      assert.deepEqual(restored.restored.map(({ path }) => path), [
        "services.app.environment.DB_PASSWORD", "services.app.command.1",
        "services.app.entrypoint.1", "services.app.healthcheck.test.2",
      ]);
    });
  }

  it("uses live values in both previews and guarded API writes", async () => {
    const live = parse(sharedValue);
    delete live["x-password"];
    live.services.app.environment.DB_PASSWORD = "synthetic-live-password";
    live.services.app.command[1] = "synthetic-live-command";
    live.services.app.entrypoint[1] = "synthetic-live-entrypoint";
    live.services.app.healthcheck.test[2] = "synthetic-live-healthcheck";
    const originalFetch = globalThis.fetch;
    const writes: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        writes.push(JSON.parse(init.body as string).spec.compose);
        return new Response("{}");
      }
      assert.equal(init.method, "GET");
      const compose = new URL(url).pathname.endsWith("/compose") ? stringify(live) : sharedValue;
      return new Response(JSON.stringify({ spec: { compose } }));
    }) as typeof fetch;
    try {
      const handlers = harness(new SwarmpitClient("https://swarmpit.invalid", "synthetic-token"));
      const compose = sanitizeComposeYaml(sharedValue).replace("alpine:3", "alpine:3.21");
      const preview = await handlers.update_stack({ name: "audit", compose, dry_run: true });
      assert.equal(preview.isError, undefined, preview.content[0].text);
      assert.deepEqual(writes, []);
      assert.deepEqual(JSON.parse(preview.content[0].text).changes.services.changed.app, {
        image: { from: "alpine:3", to: "alpine:3.21" },
      });
      const result = await handlers.update_stack({ name: "audit", compose });
      assert.equal(result.isError, undefined, result.content[0].text);
      assert.equal(writes.length, 1);
      live.services.app.image = "alpine:3.21";
      assert.deepEqual(parse(writes[0]), live);
      assert.ok(!JSON.stringify([preview, result]).includes("synthetic-"));
      assert.match(result.content[0].text, /services.app.command.1/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  for (const placeholder of ["'[REDACTED]'", '"[REDACTED]"', "[REDACTED]"]) {
    it(`restores standalone list placeholder ${placeholder}`, () => {
      const edited = `services:\n  app:\n    command:\n      - echo\n      - ${placeholder}\n`;
      const restored = restoreComposeRedactions(edited, [sharedValue]);
      assert.deepEqual(restored.unresolved, []);
      assert.deepEqual(parse(restored.yaml).services.app.command, ["echo", secret]);
    });
  }

  for (const dry_run of [true, false]) {
    it(`refuses unresolved list placeholders with dry_run=${dry_run}`, async () => {
      const live = `services: {app: {image: 'alpine:3', environment: {DB_PASSWORD: ${secret}}, command: [echo]}}`;
      const handlers = harness({
        getStackCompose: async () => ({ compose: live }),
        getStackFile: async () => ({ compose: live }),
        updateStack: async () => { assert.fail("must not write an unresolved list value"); },
      });
      const result = await handlers.update_stack({ name: "audit", compose: sanitizeComposeYaml(sharedValue), dry_run });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /services.app.command.1/);
      assert.match(result.content[0].text, /services.app.healthcheck.test.2/);
      assert.ok(!result.content[0].text.includes(secret));
    });
  }
});
