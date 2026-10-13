import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { registerStackTools } from "../tools/stacks.js";
import { registerServiceTools } from "../tools/services.js";
import { restoreComposeRedactions, sanitizeComposeYaml } from "../sanitize.js";
import { SwarmpitClient } from "../client.js";

function mockServer(): { handlers: Record<string, Function>; tool: Function } {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    tool(name: string, _desc: string, _schema: unknown, handler: Function) {
      handlers[name] = handler;
    },
  } as unknown as { handlers: Record<string, Function>; tool: Function };
}

function stackHarness(live: string, file = live) {
  const updates: [string, string][] = [];
  const client = {
    getStackCompose: () => Promise.resolve({ compose: live }),
    getStackFile: () => Promise.resolve({ compose: file }),
    updateStack: (name: string, compose: string) => {
      updates.push([name, compose]);
      return Promise.resolve();
    },
  };
  const server = mockServer();
  registerStackTools(server as never, client as never, "all");
  return { updates, run: (args: Record<string, unknown>) => server.handlers.update_stack(args) };
}

const env = (yaml: string, svc: string) => parse(yaml).services[svc].environment;

// two services sharing variable names, as in a keeper + monitor stack
const LIVE = `services:
  keeper:
    image: keeper:1
    environment:
      PRIVATE_KEY: "0xkeeperkey"
      ALERT_WEBHOOK: https://hooks.example/keeper
      RPC_URL: wss://rpc.example
  monitor:
    image: monitor:1
    environment:
      - ALERT_WEBHOOK=https://hooks.example/monitor
      - RPC_URL=wss://rpc.example
`;

describe("update_stack placeholder forms the line regex missed", () => {
  it("restores quoted map placeholders (the gamma outage shape)", async () => {
    const { updates, run } = stackHarness(LIVE);
    const edited = `services:
  keeper:
    image: keeper:2
    environment:
      PRIVATE_KEY: '[REDACTED]'
      ALERT_WEBHOOK: "[REDACTED]"
      RPC_URL: [REDACTED]
  monitor:
    image: monitor:1
    environment:
      - ALERT_WEBHOOK=[REDACTED]
      - RPC_URL=[REDACTED]
`;
    const result = await run({ name: "s", compose: edited });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const out = updates[0][1];
    assert.ok(!out.includes("REDACTED"));
    assert.equal(env(out, "keeper").PRIVATE_KEY, "0xkeeperkey");
    assert.equal(env(out, "keeper").ALERT_WEBHOOK, "https://hooks.example/keeper");
    assert.equal(parse(out).services.keeper.image, "keeper:2");
  });

  it("restores quoted list items and trailing comments", async () => {
    const { updates, run } = stackHarness(LIVE);
    const edited = `services:
  keeper:
    image: keeper:1
    environment:
      PRIVATE_KEY: [REDACTED]   # unchanged
      ALERT_WEBHOOK: [REDACTED]
      RPC_URL: [REDACTED]
  monitor:
    image: monitor:2
    environment:
      - "ALERT_WEBHOOK=[REDACTED]"
      - 'RPC_URL=[REDACTED]'
`;
    const result = await run({ name: "s", compose: edited });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const out = updates[0][1];
    assert.ok(!out.includes("REDACTED"));
    assert.equal(env(out, "keeper").PRIVATE_KEY, "0xkeeperkey");
    assert.deepEqual(env(out, "monitor"), ["ALERT_WEBHOOK=https://hooks.example/monitor", "RPC_URL=wss://rpc.example"]);
  });

  it("keeps each service's own value when names collide", async () => {
    const { updates, run } = stackHarness(LIVE);
    const edited = `services:
  keeper:
    image: keeper:1
    environment:
      PRIVATE_KEY: [REDACTED]
      ALERT_WEBHOOK: [REDACTED]
      RPC_URL: [REDACTED]
  monitor:
    image: monitor:1
    environment:
      ALERT_WEBHOOK: [REDACTED]
      RPC_URL: [REDACTED]
`;
    await run({ name: "s", compose: edited });
    const out = updates[0][1];
    assert.equal(env(out, "keeper").ALERT_WEBHOOK, "https://hooks.example/keeper");
    // monitor switched from list to map form; still gets its own webhook, never the keeper's
    assert.equal(env(out, "monitor").ALERT_WEBHOOK, "https://hooks.example/monitor");
    assert.equal(env(out, "monitor").PRIVATE_KEY, undefined);
  });

  it("restores values defined under an anchor from the stack file", () => {
    const file = `x-common: &common
  RPC_URL: wss://from-file
services:
  app:
    image: app:1
    environment: *common
`;
    const edited = `x-common: &common
  RPC_URL: [REDACTED]
services:
  app:
    image: app:2
    environment: *common
`;
    const live = "services:\n  app:\n    image: app:1\n    environment:\n      RPC_URL: wss://from-file\n";
    const r = restoreComposeRedactions(edited, [live, file]);
    assert.deepEqual(r.unresolved, []);
    assert.equal(parse(r.yaml, { merge: true }).services.app.environment.RPC_URL, "wss://from-file");
  });
});

describe("update_stack refuses to ship a placeholder", () => {
  const edited = `services:
  keeper:
    image: keeper:1
    environment:
      PRIVATE_KEY: [REDACTED]
      NEW_SECRET: [REDACTED]
`;

  it("errors without writing when a placeholder has no source", async () => {
    const { updates, run } = stackHarness(LIVE);
    const result = await run({ name: "s", compose: edited });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Refusing to write.*services\.keeper\.environment\.NEW_SECRET/);
    assert.equal(updates.length, 0);
  });

  it("reports the same refusal on dry_run", async () => {
    const { run } = stackHarness(LIVE);
    const result = await run({ name: "s", compose: edited, dry_run: true });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /NEW_SECRET/);
  });

  it("never restores from a source that itself holds the placeholder", () => {
    const poisoned = "services:\n  app:\n    environment:\n      KEY: '[REDACTED]'\n";
    const r = restoreComposeRedactions("services:\n  app:\n    environment:\n      KEY: [REDACTED]\n", [poisoned, poisoned]);
    assert.deepEqual(r.unresolved, ["services.app.environment.KEY"]);
  });

  it("leaves a compose without placeholders byte-for-byte unchanged", () => {
    const yaml = "services:\n  app:\n    image: app:1   # pinned\n";
    assert.equal(restoreComposeRedactions(yaml, [LIVE]).yaml, yaml);
  });
});

describe("update_service refuses an unresolvable placeholder", () => {
  it("errors without writing when the live service lacks the variable", async () => {
    const updates: unknown[] = [];
    const client = {
      getService: () => Promise.resolve({ id: "svc", variables: [{ name: "RPC_URL", value: "wss://x" }] }),
      updateService: (...args: unknown[]) => {
        updates.push(args);
        return Promise.resolve();
      },
    };
    const server = mockServer();
    registerServiceTools(server as never, client as never, "all");
    const result = await server.handlers.update_service({
      id: "svc",
      spec: { variables: [{ name: "RPC_URL", value: "[REDACTED]" }, { name: "PRIVATE_KEY", value: "[REDACTED]" }] },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /PRIVATE_KEY/);
    assert.equal(updates.length, 0);
  });
});

describe("client write guard", () => {
  it("throws before any request carrying [REDACTED] leaves the process", async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    try {
      const client = new SwarmpitClient("https://swarmpit.invalid", "token");
      await assert.rejects(
        client.updateStack("s", "services:\n  app:\n    environment:\n      AUTH: Bearer [REDACTED]\n"),
        /Refusing to send a \[REDACTED\] placeholder/
      );
      assert.equal(called, false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("sanitizeComposeYaml quoted list form", () => {
  it("redacts - \"KEY=value\" entries it used to pass through", () => {
    const out = sanitizeComposeYaml(`    environment:\n      - "PRIVATE_KEY=0xsecret"\n      - 'RPC_URL=wss://x'\n`, true);
    assert.ok(!out.includes("0xsecret"));
    assert.ok(out.includes(`- "PRIVATE_KEY=[REDACTED]"`));
    assert.ok(out.includes(`- 'RPC_URL=[REDACTED]'`));
  });

  it("round-trips: sanitized output restores to the original values", () => {
    const sanitized = sanitizeComposeYaml(LIVE, true);
    assert.ok(!sanitized.includes("0xkeeperkey"));
    const r = restoreComposeRedactions(sanitized, [LIVE]);
    assert.deepEqual(r.unresolved, []);
    assert.deepEqual(parse(r.yaml), parse(LIVE));
  });
});
