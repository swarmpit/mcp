import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reduceTimeseries, filterLogs } from "../timeseries.js";
import { formatSpecError } from "../client.js";
import { registerServiceTools } from "../tools/services.js";
import { registerStackTools } from "../tools/stacks.js";
import { registerTimeseriesTools } from "../tools/timeseries.js";

function mockServer() {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    tool(name: string, _d: string, _s: unknown, handler: Function) {
      handlers[name] = handler;
    },
  };
}

const body = (r: any) => JSON.parse(r.content[0].text);

function series(n: number, name = "web") {
  return {
    name,
    time: Array.from({ length: n }, (_, i) => `2026-08-21T00:${String(i).padStart(2, "0")}:00Z`),
    cpu: Array.from({ length: n }, (_, i) => i),
    memory: Array.from({ length: n }, (_, i) => i * 10),
  };
}

describe("reduceTimeseries", () => {
  it("downsamples to the requested number of points", () => {
    const out: any = reduceTimeseries([series(100)], { points: 10 });
    assert.equal(out[0].time.length, 10);
    assert.equal(out[0].cpu.length, 10);
    assert.equal(out[0].samples, 100);
    assert.deepEqual(out[0].downsampled, { to: 10, agg: "avg" });
  });

  it("keeps stats computed from the full series, not the buckets", () => {
    const out: any = reduceTimeseries([series(100)], { points: 5 });
    assert.deepEqual(out[0].stats.cpu, { min: 0, max: 99, avg: 49.5, last: 99 });
  });

  it("honours max and min aggregation", () => {
    const max: any = reduceTimeseries([series(10)], { points: 2, agg: "max" });
    assert.deepEqual(max[0].cpu, [4, 9]);
    const min: any = reduceTimeseries([series(10)], { points: 2, agg: "min" });
    assert.deepEqual(min[0].cpu, [0, 5]);
  });

  it("drops the arrays entirely for stats_only", () => {
    const out: any = reduceTimeseries([series(100)], { statsOnly: true });
    assert.equal(out[0].time, undefined);
    assert.equal(out[0].cpu, undefined);
    assert.equal(out[0].stats.cpu.max, 99);
    assert.equal(out[0].samples, 100);
  });

  it("filters series by name", () => {
    const out: any = reduceTimeseries([series(5, "api"), series(5, "worker")], { match: "work" });
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "worker");
  });

  it("reaches series nested under a wrapper key", () => {
    const out: any = reduceTimeseries([{ cpu: { service: "api", time: ["t"], cpu: [1] } }], {});
    assert.equal(out[0].cpu.service, "api");
    assert.deepEqual(out[0].cpu.stats.cpu, { min: 1, max: 1, avg: 1, last: 1 });
  });

  it("never returns more points than samples", () => {
    const out: any = reduceTimeseries([series(3)], { points: 50 });
    assert.equal(out[0].time.length, 3);
    assert.equal(out[0].downsampled, undefined);
  });

  it("shrinks a realistic payload by an order of magnitude", () => {
    const raw = Array.from({ length: 30 }, (_, i) => series(720, `svc-${i}`));
    const before = JSON.stringify(raw).length;
    const after = JSON.stringify(reduceTimeseries(raw, {})).length;
    assert.ok(after * 10 < before, `expected 10x reduction, got ${before} → ${after}`);
  });
});

describe("filterLogs", () => {
  const logs = [
    { line: "starting up" },
    { line: "ERROR connection refused" },
    { line: "retrying" },
    { line: "error: giving up" },
  ];

  it("greps case-insensitively and reports what it dropped", () => {
    const out = filterLogs(logs, { grep: "error" });
    assert.equal(out.returned, 2);
    assert.equal(out.total, 4);
    assert.deepEqual(out.dropped, { byGrep: 2 });
  });

  it("supports /regex/ syntax", () => {
    const out = filterLogs(logs, { grep: "/^ERROR/" });
    assert.deepEqual(out.entries, [{ line: "ERROR connection refused" }]);
  });

  it("tails after filtering", () => {
    const out = filterLogs(logs, { tail: 2 });
    assert.deepEqual(out.entries, [{ line: "retrying" }, { line: "error: giving up" }]);
    assert.deepEqual(out.dropped, { byTail: 2 });
  });

  it("reports nothing dropped when everything matches", () => {
    assert.equal(filterLogs(logs, { grep: "" }).dropped, undefined);
  });
});

describe("service_logs filtering", () => {
  it("passes the raw array through when unfiltered", async () => {
    const server = mockServer();
    const client = { getServiceLogs: async () => [{ line: "a" }, { line: "b" }] };
    registerServiceTools(server as never, client as never, "all");

    assert.deepEqual(body(await server.handlers.service_logs({ id: "s" })), [
      { line: "a" },
      { line: "b" },
    ]);
  });

  it("filters and annotates when grep is given", async () => {
    const server = mockServer();
    const client = { getServiceLogs: async () => [{ line: "ok" }, { line: "boom" }] };
    registerServiceTools(server as never, client as never, "all");

    const out = body(await server.handlers.service_logs({ id: "s", grep: "boom" }));
    assert.deepEqual(out.entries, [{ line: "boom" }]);
    assert.equal(out.total, 2);
    assert.deepEqual(out.dropped, { byGrep: 1 });
  });
});

describe("get_nodes_timeseries reduction", () => {
  it("downsamples by default without being asked", async () => {
    const server = mockServer();
    const client = { getNodesTimeseries: async () => [series(500)] };
    registerTimeseriesTools(server as never, client as never);

    const out = body(await server.handlers.get_nodes_timeseries({}));
    assert.equal(out[0].time.length, 12);
    assert.equal(out[0].samples, 500);
  });
});

describe("dry_run", () => {
  const live = {
    id: "svc1",
    serviceName: "app",
    state: "running",
    repository: { name: "nginx", tag: "alpine", imageDigest: "sha256:x" },
    variables: [
      { name: "RPC_URL", value: "wss://real" },
      { name: "LOG_LEVEL", value: "info" },
      { name: "OLD", value: "gone" },
    ],
  };

  it("reports service changes without writing", async () => {
    const server = mockServer();
    const writes: unknown[] = [];
    const client = {
      getService: async () => live,
      updateService: (...a: unknown[]) => {
        writes.push(a);
        return Promise.resolve();
      },
    };
    registerServiceTools(server as never, client as never, "all");

    const out = body(
      await server.handlers.update_service({
        id: "svc1",
        dry_run: true,
        spec: {
          ...live,
          replicas: 3,
          variables: [
            { name: "RPC_URL", value: "[REDACTED]" },
            { name: "LOG_LEVEL", value: "debug" },
            { name: "NEW", value: "x" },
          ],
        },
      })
    );

    assert.equal(out.dryRun, true);
    assert.deepEqual(writes, [], "dry_run must not write");
    assert.deepEqual(out.restoredVars, ["RPC_URL"]);
    assert.deepEqual(out.changes.fields.replicas, { from: null, to: 3 });
    assert.deepEqual(out.changes.variables.changed, ["LOG_LEVEL"]);
    assert.deepEqual(out.changes.variables.added, ["NEW"]);
    assert.deepEqual(out.changes.variables.removed, ["OLD"]);
  });

  it("never puts an env var value in the service preview", async () => {
    const server = mockServer();
    const client = { getService: async () => live, updateService: async () => {} };
    registerServiceTools(server as never, client as never, "all");

    const raw = (
      await server.handlers.update_service({
        id: "svc1",
        dry_run: true,
        spec: { ...live, variables: [{ name: "RPC_URL", value: "wss://brand-new-secret" }] },
      })
    ).content[0].text;

    assert.equal(raw.includes("brand-new-secret"), false);
    assert.equal(raw.includes("wss://real"), false);
  });

  it("reports stack changes without writing, and hides secret values", async () => {
    const server = mockServer();
    const writes: unknown[] = [];
    const client = {
      getStackCompose: async () => ({
        compose: "services:\n  app:\n    image: nginx:1.0\n    environment:\n      DB_PASSWORD: old-secret\n",
      }),
      getStackFile: async () => ({ compose: "" }),
      updateStack: (...a: unknown[]) => {
        writes.push(a);
        return Promise.resolve();
      },
    };
    registerStackTools(server as never, client as never, "sensitive");

    const out = body(
      await server.handlers.update_stack({
        name: "app",
        dry_run: true,
        compose: "services:\n  app:\n    image: nginx:2.0\n    environment:\n      DB_PASSWORD: new-secret\n",
      })
    );

    assert.equal(out.dryRun, true);
    assert.deepEqual(writes, [], "dry_run must not write");
    assert.equal(out.changes.changed, true);
    assert.deepEqual(out.changes.services.changed.app.image, { from: "nginx:1.0", to: "nginx:2.0" });
    assert.deepEqual(out.changes.services.changed.app.environment.changed, ["DB_PASSWORD"]);
    assert.deepEqual(out.changes.secretsChanged, ["DB_PASSWORD"]);
    const raw = JSON.stringify(out);
    assert.equal(raw.includes("new-secret"), false);
    assert.equal(raw.includes("old-secret"), false);
  });

  it("still writes when dry_run is absent", async () => {
    const server = mockServer();
    const writes: unknown[] = [];
    const client = {
      getService: async () => live,
      updateService: (...a: unknown[]) => {
        writes.push(a);
        return Promise.resolve();
      },
    };
    registerServiceTools(server as never, client as never, "all");

    await server.handlers.update_service({ id: "svc1", spec: { ...live, replicas: 2 } });
    assert.equal(writes.length, 1);
  });
});

describe("formatSpecError", () => {
  it("turns a coercion failure into field-level guidance", () => {
    const msg = formatSpecError(
      JSON.stringify({
        problems: [
          { path: ["mounts", "volumeOptions"], pred: "clojure.core/map?", val: null },
          { path: ["deployment", "maxReplicas"], pred: "clojure.core/number?", val: null },
        ],
      })
    );
    assert.equal(
      msg,
      "Swarmpit rejected the request body:\n" +
        "  mounts.volumeOptions must be an object, got null\n" +
        "  deployment.maxReplicas must be a number, got null"
    );
  });

  it("falls back to the raw predicate when unmapped", () => {
    const msg = formatSpecError(JSON.stringify({ problems: [{ path: ["x"], pred: "my.ns/even?", val: 3 }] }));
    assert.match(msg!, /x must be my\.ns\/even\?, got 3/);
  });

  it("caps the list and says how many were hidden", () => {
    const problems = Array.from({ length: 14 }, (_, i) => ({
      path: [`f${i}`],
      pred: "clojure.core/string?",
      val: null,
    }));
    assert.match(formatSpecError(JSON.stringify({ problems }))!, /…and 4 more/);
  });

  it("returns undefined for bodies it does not recognise", () => {
    assert.equal(formatSpecError("plain text"), undefined);
    assert.equal(formatSpecError(JSON.stringify({ error: "nope" })), undefined);
    assert.equal(formatSpecError(JSON.stringify({ problems: [] })), undefined);
  });
});
